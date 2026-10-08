import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, server, chatReply, sseResponse } from "./helpers.js";
import { compactionSplit, textSegments } from "../src/context.js";

for (const native of [false, true]) {
  test(`End-to-end ${native ? "native" : "text"} loop edits files and executes shell over real HTTP SSE`, async (t) => {
    let step = 0;
    const gateway = await server(t, (body) => {
      if (native) assert.ok(body.tools.length);
      else {
        assert.ok(!("tools" in body));
        assert.ok(!("tool_choice" in body));
        assert.ok(body.messages.every((m) => m.role !== "tool"));
      }
      const calls = [
        {
          name: "write_file",
          arguments: { path: "hello.js", content: 'console.log("olá");\n' },
        },
        { name: "read_file", arguments: { path: "hello.js" } },
        { name: "shell", arguments: { command: "node hello.js" } },
      ];
      const index = step++;
      if (index === 3) {
        const messages = JSON.stringify(body.messages);
        assert.match(messages, /olá/);
        return chatReply("Arquivo criado e execução verificada.");
      }
      return native
        ? chatReply("", [calls[index]])
        : chatReply(
            "```microcode_tool\n" + JSON.stringify(calls[index]) + "\n```",
          );
    });
    const { agent, cwd, session, store } = await fixture(t, {
      native,
      url: gateway.url,
    });
    assert.match(await agent.run("Crie hello.js e execute"), /verificada/);
    assert.equal(
      await readFile(path.join(cwd, "hello.js"), "utf8"),
      'console.log("olá");\n',
    );
    assert.equal(session.usage.length, 4);
    assert.equal(session.messages.filter((m) => m.role === "tool").length, 3);
    assert.equal(session.checkpoints[0].changes.length, 1);
    assert.equal(gateway.requests[0].headers["x-opencode-session"], session.id);
    assert.equal(
      (await store.loadSession(session.id, cwd)).messages.at(-1).content,
      "Arquivo criado e execução verificada.",
    );
  });
}

test("Auto falls back to text exactly once for unsupported native tools", async (t) => {
  const gateway = await server(t, (body) =>
    body.tools
      ? { status: 404, error: "No endpoints found that support tool use." }
      : chatReply("Resposta por texto."),
  );
  const { agent, session } = await fixture(t, {
    native: true,
    url: gateway.url,
  });
  assert.equal(await agent.run("Olá"), "Resposta por texto.");
  assert.equal(gateway.requests.length, 2);
  assert.equal(session.usage.length, 1);
  assert.deepEqual(session.textFallback, ["demo"]);
  await agent.run("Outra pergunta");
  assert.equal(gateway.requests.length, 3);
  assert.ok(!gateway.requests[2].body.tools);
});

test("Authentication errors never trigger fallback or repeat charged calls", async (t) => {
  const gateway = await server(t, () => ({
    status: 401,
    error: "Invalid API key",
  }));
  const { agent } = await fixture(t, { native: true, url: gateway.url });
  await assert.rejects(agent.run("Olá"), /401/);
  assert.equal(gateway.requests.length, 1);
});

test("Malformed mixed text batch executes nothing; corrected request can retry", async (t) => {
  let n = 0;
  const call = {
    name: "write_file",
    arguments: { path: "a.txt", content: "one" },
  };
  const gateway = await server(t, (body) => {
    n++;
    if (n === 1)
      return chatReply(
        "```microcode_tool\n" +
          JSON.stringify(call) +
          "\n```\n```microcode_tool\nNOT JSON\n```",
      );
    if (n === 2) {
      assert.match(JSON.stringify(body.messages), /Nenhuma ferramenta/);
      return chatReply("```microcode_tool\n" + JSON.stringify(call) + "\n```");
    }
    return chatReply("Pronto");
  });
  const { agent, cwd, session } = await fixture(t, { url: gateway.url });
  await agent.run("Crie a");
  assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "one");
  assert.equal(session.messages.filter((m) => m.role === "tool").length, 1);
});

test("Cancellation fills pending native tool results so resume remains valid", async (t) => {
  const controller = new AbortController();
  const { agent, runner, session } = await fixture(t, {
    native: true,
    fetchImpl: async () =>
      sseResponse(
        chatReply("", [
          { name: "read_file", arguments: { path: "a" } },
          { name: "read_file", arguments: { path: "b" } },
        ]),
      ),
  });
  runner.execute = async () => {
    controller.abort(new Error("stop"));
    throw controller.signal.reason;
  };
  await assert.rejects(agent.run("Leia a e b", controller.signal), /stop/);
  assert.equal(session.messages.filter((m) => m.role === "tool").length, 2);
  for (const m of session.messages.filter((m) => m.role === "tool"))
    assert.match(m.content, /cancelada/);
});

test("/btw does not mutate main conversation, executes no tools, counts usage", async (t) => {
  const gateway = await server(t, (body) => {
    assert.ok(!body.tools);
    assert.match(JSON.stringify(body.messages), /O que significa/);
    return chatReply("Significa uma pergunta lateral.");
  });
  const { agent, session } = await fixture(t, {
    url: gateway.url,
    native: true,
  });
  session.messages.push(
    { role: "user", content: "Principal" },
    { role: "assistant", content: "Resposta principal" },
  );
  const before = structuredClone(session.messages);
  assert.match(await agent.btw("O que significa btw?"), /lateral/);
  assert.deepEqual(session.messages, before);
  assert.equal(session.usage.at(-1).purpose, "btw");
});

test("Compaction keeps recent turns with complete call/result pairs and records summary cost", async (t) => {
  const gateway = await server(t, (body) => {
    assert.ok(!body.tools);
    return chatReply(
      "Objetivo: implementar arquivo a.js. Já foi criado e testado.",
    );
  });
  const { agent, session, config } = await fixture(t, { url: gateway.url });
  config.compaction.keepTurns = 1;
  session.messages = [
    { role: "user", content: "antigo ".repeat(500) },
    { role: "assistant", content: "feito ".repeat(500) },
    { role: "user", content: "recente" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.js" } }],
    },
    {
      role: "tool",
      name: "read_file",
      toolCallId: "t1",
      content: '{"ok":true}',
    },
  ];
  const recent = structuredClone(session.messages.slice(2));
  const result = await agent.compact("preserve paths");
  assert.equal(result.changed, true);
  assert.match(session.messages[0].content, /MICROCODE_CONTEXT_SUMMARY/);
  assert.deepEqual(session.messages.slice(1), recent);
  assert.equal(session.usage.at(-1).purpose, "compact");
  assert.equal(compactionSplit(session.messages, 1).cut, 0);
});

test("Failed compaction leaves original history intact", async (t) => {
  const { agent, session, config } = await fixture(t, {
    fetchImpl: async () =>
      new Response('{"error":{"message":"quota"}}', { status: 429 }),
  });
  config.compaction.keepTurns = 1;
  session.messages = [
    { role: "user", content: "old" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "new" },
  ];
  const before = structuredClone(session.messages);
  await assert.rejects(agent.compact(), /quota/);
  assert.deepEqual(session.messages, before);
});

test("Auto compaction triggers before inference and preserves active checkpoint reference", async (t) => {
  const gateway = await server(t, (body) =>
    body.messages[0]?.content?.includes("Previous summary:") ||
    (body.messages[0]?.role === "system" &&
      body.messages[0].content.includes("Summarize"))
      ? chatReply("Resumo curto.")
      : chatReply("Tudo certo."),
  );
  const { agent, config, session, model } = await fixture(t, {
    url: gateway.url,
  });
  model.context = 12000;
  config.maxTokens = 1024;
  config.compaction.keepTurns = 1;
  config.compaction.threshold = 0.5;
  session.messages = [
    { role: "user", content: "context ".repeat(3500) },
    { role: "assistant", content: "result ".repeat(1000) },
  ];
  await agent.run("Continue");
  assert.ok(session.compactions >= 1);
  assert.equal(session.messages.at(-1).content, "Tudo certo.");
  assert.ok(session.checkpoints.at(-1).messageIndex < session.messages.length);
});

test("Read-only project instructions are loaded and normal code is never executed", async (t) => {
  const { agent, cwd } = await fixture(t, {
    fetchImpl: async (_url, init) => {
      assert.match(
        JSON.parse(init.body).messages[0].content,
        /Use our conventions/,
      );
      return sseResponse(chatReply("```sh\necho example\n```"));
    },
  });
  await writeFile(path.join(cwd, "AGENTS.md"), "Use our conventions");
  const answer = await agent.run("Explique shell");
  assert.match(answer, /echo example/);
});

test("Context segmentation respects UTF-8 byte budgets without splitting emoji", () => {
  const input = "你好🌱á".repeat(2000);
  const segments = [...textSegments(input, 1024)];
  assert.equal(segments.join(""), input);
  assert.ok(segments.every((s) => Buffer.byteLength(s) <= 1024));
  assert.ok(segments.length > 10);
});

test("Text-to-native mode transition replays prior tool activity as plain context", async (t) => {
  const { agent, session, config } = await fixture(t, {
    native: true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.tools);
      assert.ok(body.messages.every((m) => m.role !== "tool"));
      assert.ok(body.messages.every((m) => !m.tool_calls));
      return sseResponse(chatReply("Concluído no modo nativo."));
    },
  });
  session.historyMode = "text";
  session.messages = [
    { role: "user", content: "old" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "t", name: "shell", arguments: { command: "echo ok" } },
      ],
    },
    { role: "tool", name: "shell", toolCallId: "t", content: '{"ok":true}' },
  ];
  config.toolMode = "native";
  assert.match(await agent.run("Continue"), /nativo/);
});
