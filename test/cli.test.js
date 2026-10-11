import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { Application, parseArgs } from "../src/cli.js";
import { Store, newSession, repairHistory } from "../src/store.js";
import { temp, server, chatReply } from "./helpers.js";

const bin = fileURLToPath(new URL("../bin/microcode.js", import.meta.url));

function cliEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides, NO_COLOR: "1" };
  // npm/pnpm may force colors, but these piped CLI tests require plain output.
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "FORCE_COLOR") delete env[name];
  }
  return env;
}

function processRun(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: cliEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timeout: ${stdout}\n${stderr}`));
    }, 15000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test("CLI parses print/resume/provider/model flags and rejects unknown options", () => {
  assert.deepEqual(
    parseArgs([
      "--cwd",
      "x",
      "--provider",
      "openrouter",
      "--model",
      "author/name",
      "--tools",
      "text",
      "-p",
      "do it",
    ]),
    {
      cwd: "x",
      provider: "openrouter",
      model: "author/name",
      tools: "text",
      prompt: "do it",
    },
  );
  assert.equal(parseArgs(["--resume"]).resume, true);
  assert.equal(parseArgs(["--resume", "abc"]).resume, "abc");
  assert.throws(() => parseArgs(["--model"]), /Falta/);
  assert.throws(() => parseArgs(["--something"]), /desconhecida/);
});

test("Full CLI runs text tools, /btw, config, /compact, /export and /resume with piped input", async (t) => {
  const cwd = await temp(t);
  const home = path.join(cwd, ".microcode");
  const store = new Store(home);
  const gateway = await server(t, (body, req) => {
    if (req.url === "/v1/models")
      return {
        json: {
          data: [
            {
              id: "demo",
              name: "Demo no tools",
              context_length: 64000,
              supported_parameters: [],
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
          ],
        },
      };
    assert.ok(!body.tools);
    assert.ok(!body.tool_choice);
    const latest = body.messages.at(-1).content;
    if (body.messages[0].content.includes("Summarize"))
      return chatReply("Resumo: foi criado hello.txt, conteúdo registrado.");
    if (body.messages[0].content.includes("side question"))
      return chatReply("Resposta lateral isolada.");
    if (latest.includes("MICROCODE_TOOL_RESULTS"))
      return chatReply(
        "Arquivo hello.txt criado. " + "Resumo de trabalho. ".repeat(30),
      );
    if (latest.includes("Crie hello"))
      return chatReply(
        '```microcode_tool\n{"name":"write_file","arguments":{"path":"hello.txt","content":"olá"}}\n```',
      );
    return chatReply("Segundo turno concluído.");
  });
  await store.write("config.json", {
    providers: {
      local: {
        name: "Local",
        baseURL: gateway.url + "/v1",
        catalog: "custom",
        env: "MICROCODE_TEST_KEY",
      },
    },
    selected: { provider: "local", model: "demo" },
    permission: "auto",
    compaction: { keepTurns: 1 },
  });
  const result = await processRun(
    ["--cwd", cwd],
    "/model demo\nCrie hello.txt\n/btw o que mudou?\nSegundo pedido\n/compact\n/config compaction.threshold 0.7\n/rename Sessão teste\n/export export.md\n/status\n/cost\n/exit\n",
    {
      MICROCODE_HOME: home,
      MICROCODE_TEST_KEY: "dummy-test",
      FORCE_COLOR: "1",
    },
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /tools nativas: não/);
  assert.match(result.stdout, /tok\/s/);
  assert.match(result.stdout, /Resposta lateral isolada/);
  assert.match(result.stdout, /Contexto compactado/);
  assert.match(result.stdout, /compaction.threshold = 0.7/);
  assert.equal(await readFile(path.join(cwd, "hello.txt"), "utf8"), "olá");
  const session = (await store.sessions(cwd))[0];
  assert.equal(session.title, "Sessão teste");
  assert.ok(
    !JSON.stringify(session.messages).includes("Resposta lateral isolada"),
  );
  assert.equal(session.compactions, 1);
  assert.match(
    await readFile(path.join(cwd, "export.md"), "utf8"),
    /Crie hello\.txt/,
  );
  const resumed = await processRun(
    ["--cwd", cwd, "--resume", session.id],
    "/status\n/exit\n",
    { MICROCODE_HOME: home, MICROCODE_TEST_KEY: "dummy-test" },
  );
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, new RegExp(session.id.slice(0, 8)));
  assert.match(resumed.stdout, /HISTÓRICO DA SESSÃO/);
  assert.match(resumed.stdout, /Crie hello/);
  assert.match(resumed.stdout, /Segundo turno concluído/);
});

test("Single-prompt CLI native mode invokes real local tools and prints final answer", async (t) => {
  const cwd = await temp(t);
  const home = path.join(cwd, ".microcode");
  const store = new Store(home);
  const gateway = await server(t, (body, req) => {
    if (req.url.endsWith("/models"))
      return {
        json: {
          data: [
            {
              id: "native",
              supported_parameters: ["tools"],
              context_length: 64000,
            },
          ],
        },
      };
    assert.ok(body.tools);
    return body.messages.at(-1).role === "tool"
      ? chatReply("Arquivo verificado.")
      : chatReply("", [{ name: "read_file", arguments: { path: "test.txt" } }]);
  });
  await writeFile(path.join(cwd, "test.txt"), "conteúdo");
  await store.write("config.json", {
    providers: {
      local: { name: "Local", baseURL: gateway.url + "/v1", catalog: "custom" },
    },
    selected: { provider: "local", model: "native" },
  });
  const result = await processRun(["--cwd", cwd, "-p", "Leia test.txt"], "", {
    MICROCODE_HOME: home,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Arquivo verificado/);
  assert.match(result.stdout, /tools native/);
});

test("Configuration commands validate values and retain nested defaults", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const app = new Application({
    cwd,
    store,
    config,
    session: newSession(cwd, null),
    ui: { print() {}, notice() {} },
  });
  await app.configCommand("compaction.auto false");
  assert.equal(config.compaction.auto, false);
  await app.configCommand("compaction.threshold 0.75");
  assert.equal(config.compaction.threshold, 0.75);
  await assert.rejects(
    app.configCommand("compaction.threshold 1.2"),
    /intervalo|entre/,
  );
  await assert.rejects(app.configCommand("compaction.keepTurns 0"), /entre/);
  await assert.rejects(app.configCommand("maxSteps NaN"), /entre/);
  assert.equal((await store.config()).compaction.summaryTokens, 2048);
});

test("Crash recovery inserts results for unfinished native calls without re-executing them", () => {
  const repaired = repairHistory([
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "write_file", arguments: {} },
        { id: "b", name: "shell", arguments: {} },
      ],
    },
    { role: "tool", toolCallId: "a", name: "write_file", content: "done" },
  ]);
  assert.equal(repaired.length, 3);
  assert.equal(repaired[2].toolCallId, "b");
  assert.match(repaired[2].content, /interrompida/);
});

test("/btw can run while a main inference is still pending without contaminating history", async (t) => {
  const cwd = await temp(t);
  const home = path.join(cwd, ".microcode");
  const store = new Store(home);
  let started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const gateway = await server(t, async (body, req) => {
    if (req.url.endsWith("/models"))
      return {
        json: {
          data: [
            { id: "demo", context_length: 64000, supported_parameters: [] },
          ],
        },
      };
    if (body.messages[0].content.includes("side question")) {
      release();
      return chatReply("Resposta enquanto trabalho.");
    }
    started();
    await blocked;
    return chatReply("Resposta principal pronta.");
  });
  await store.write("config.json", {
    providers: {
      local: { name: "Local", baseURL: gateway.url + "/v1", catalog: "custom" },
    },
    selected: { provider: "local", model: "demo" },
  });
  const child = spawn(process.execPath, [bin, "--cwd", cwd], {
    env: cliEnvironment({ MICROCODE_HOME: home }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Background /btw timeout: " + output));
    }, 15000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  child.stdin.write("Pedido principal\n");
  await start;
  child.stdin.end("/btw pergunta lateral\n/exit\n");
  assert.equal(await finished, 0, output);
  assert.match(output, /Resposta enquanto trabalho/);
  assert.match(output, /Resposta principal pronta/);
  const session = (await store.sessions(cwd))[0];
  assert.equal(session.usage.filter((r) => r.purpose === "btw").length, 1);
  assert.ok(
    !JSON.stringify(session.messages).includes("Resposta enquanto trabalho"),
  );
  assert.equal(session.messages.at(-1).content, "Resposta principal pronta.");
});
