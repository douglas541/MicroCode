import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store, newSession } from "../src/store.js";
import { ToolRunner } from "../src/tools.js";
import { Agent } from "../src/agent.js";

export async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "microcode-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return await realpath(root);
}

export function chatReply(content, toolCalls = []) {
  return [
    {
      choices: [
        {
          delta: {
            content,
            ...(toolCalls.length
              ? {
                  tool_calls: toolCalls.map((c, i) => ({
                    index: i,
                    id: c.id || `call-${i}`,
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: JSON.stringify(c.arguments),
                    },
                  })),
                }
              : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        { delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" },
      ],
    },
    {
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00012 },
    },
  ];
}

export function sseResponse(frames, { fragment = 13 } = {}) {
  const data = Buffer.from(
    ": keepalive\r\n\r\n" +
      frames.map((f) => "data: " + JSON.stringify(f) + "\r\n\r\n").join("") +
      "data: [DONE]\r\n\r\n",
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < data.length; i += fragment)
          controller.enqueue(data.subarray(i, i + fragment));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

export async function server(t, handler) {
  const requests = [];
  const instance = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ url: req.url, body, headers: req.headers });
      const answer = await handler(body, req, requests);
      if (answer?.status) {
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: answer.error } }));
        return;
      }
      if (answer?.json) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.json));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const text =
        (answer || chatReply("OK"))
          .map((e) => "data: " + JSON.stringify(e) + "\n\n")
          .join("") + "data: [DONE]\n\n";
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 7)
        res.write(bytes.subarray(i, i + 7));
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${instance.address().port}`, requests };
}

export async function fixture(
  t,
  {
    native = false,
    fetchImpl,
    url = "http://localhost/v1",
    config: overrides = {},
    ui = {},
  } = {},
) {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, ".microcode"));
  const config = {
    ...(await store.config()),
    permission: "auto",
    ...overrides,
  };
  const session = newSession(cwd, { provider: "test", model: "demo" });
  const model = {
    id: "demo",
    name: "Demo",
    nativeTools: native,
    protocol: "chat",
    context: 64000,
    maxOutput: 8192,
    inputPrice: 1,
    outputPrice: 2,
  };
  const runner = new ToolRunner({ cwd, permission: "auto" });
  const agent = new Agent({
    provider: { baseURL: url },
    key: "test-key",
    model,
    config,
    session,
    runner,
    store,
    fetchImpl,
    ui,
  });
  return { cwd, store, config, session, model, runner, agent };
}
