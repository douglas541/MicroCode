import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Application } from "../src/cli.js";
import { Store, newSession } from "../src/store.js";
import { diagnose } from "../src/diagnostics.js";
import { runShell } from "../src/tools.js";
import { temp, server } from "./helpers.js";
import { readMemory, MEMORY_FILE } from "../src/memory.js";
import { projectInstructions } from "../src/context.js";
import { createCheckpoint } from "../src/checkpoints.js";

async function application(t) {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, ".microcode"));
  const config = await store.config();
  config.permission = "auto";
  const output = [];
  const ui = {
    print: (s) => output.push(s),
    notice: (s) => output.push(s),
    tool() {},
    toolResult() {},
    confirmAction: async () => true,
  };
  return {
    app: new Application({
      cwd,
      store,
      config,
      session: newSession(cwd, null),
      ui,
    }),
    output,
  };
}

test("/rewind can select an older turn, merge edits and restore chat history without changing costs", async (t) => {
  const { app } = await application(t);
  const file = path.join(app.cwd, "file.txt");
  await writeFile(file, "first");
  const first = createCheckpoint(app.session, "first turn");
  first.changes.push({ path: file, before: "original", after: "first" });
  app.session.messages.push(
    { role: "user", content: "first turn" },
    { role: "assistant", content: "first response" },
  );
  const second = createCheckpoint(app.session, "second turn");
  second.changes.push({ path: file, before: "first", after: "second" });
  await writeFile(file, "second");
  app.session.messages.push(
    { role: "user", content: "second turn" },
    { role: "assistant", content: "second response" },
  );
  app.session.usage.push({ cost: 1 });
  app.ui.select = async (request) => {
    assert.equal(request.items.length, 2);
    return "0";
  };
  await app.command("/rewind");
  assert.equal(await readFile(file, "utf8"), "original");
  assert.equal(app.session.messages.length, 0);
  assert.equal(app.session.checkpoints.length, 0);
  assert.equal(app.session.usage[0].cost, 1);
});

test("Direct !shell commands create restorable checkpoints, and cancelled rewind keeps them", async (t) => {
  const { app } = await application(t);
  await app.shell(
    "node -e \"require('fs').writeFileSync('direct.txt','created')\"",
  );
  assert.equal(app.session.checkpoints.length, 1);
  assert.equal(app.session.checkpoints[0].shellCoverage[0].files, 1);
  app.ui.confirmAction = async () => false;
  await app.command("/undo 1");
  assert.equal(app.session.checkpoints.length, 1);
  app.ui.confirmAction = async () => true;
  await app.command("/undo 1");
  await assert.rejects(readFile(path.join(app.cwd, "direct.txt")), {
    code: "ENOENT",
  });
});

test("/diff reports Git failure instead of claiming the workspace is clean", async (t) => {
  const { app, output } = await application(t);
  await assert.rejects(
    app.command("/diff"),
    /git repository|repositório|not a git/i,
  );
  assert.ok(!output.join("\n").includes("Sem diff"));
  assert.equal((await runShell("git init -q", { cwd: app.cwd })).exitCode, 0);
  await app.command("/diff");
  assert.match(output.at(-1), /Sem diff/);
});

test("/doctor continues after a broken provider and checks every configured catalog", async (t) => {
  const { app, output } = await application(t);
  const broken = await server(t, () => ({
    status: 401,
    error: "bad-key invalid",
  }));
  const healthy = await server(t, () => ({
    json: { data: [{ id: "local" }] },
  }));
  app.config.providers = {
    broken: { name: "Broken", catalog: "openrouter", baseURL: broken.url },
    healthy: { name: "Healthy", catalog: "custom", baseURL: healthy.url },
  };
  app.providers = () => app.config.providers;
  await app.store.setKey("broken", "bad-key");
  const checks = await diagnose(app);
  assert.equal(
    checks.find((c) => c.name === "broken · autenticação").ok,
    false,
  );
  assert.equal(checks.find((c) => c.name === "healthy · catálogo").ok, true);
  assert.ok(healthy.requests.some((r) => r.url === "/models"));
  assert.ok(!output.join("\n").includes("bad-key"));
  assert.ok(checks.some((c) => c.name === "Shell"));
  assert.ok(checks.some((c) => c.name === "pnpm"));
});

test("/init generates project-specific instructions locally, preserves custom text and is idempotent", async (t) => {
  const { app } = await application(t);
  await writeFile(
    path.join(app.cwd, "AGENTS.md"),
    "# Existing\n\nKeep my naming rules.\n",
  );
  await writeFile(
    path.join(app.cwd, "package.json"),
    JSON.stringify({
      name: "sample",
      packageManager: "pnpm@12.10.1",
      type: "module",
      engines: { node: ">=22" },
      scripts: { test: 'node -e "throw new Error()"', check: "node check.js" },
    }),
  );
  await mkdir(path.join(app.cwd, "src"));
  app.agent = () => {
    throw new Error("/init must not call inference");
  };
  await app.command("/init");
  const first = await readFile(path.join(app.cwd, "AGENTS.md"), "utf8");
  assert.match(first, /Keep my naming rules/);
  assert.match(first, /pnpm run test/);
  assert.match(first, /src\//);
  assert.match(first, /não os executou/);
  assert.equal(app.session.checkpoints.length, 1);
  assert.equal(app.session.messages.length, 0);
  await app.command("/init");
  assert.equal(await readFile(path.join(app.cwd, "AGENTS.md"), "utf8"), first);
  assert.equal(app.session.checkpoints.length, 1);
  await writeFile(
    path.join(app.cwd, "AGENTS.md"),
    first + "\nManual footer.\n",
  );
  await writeFile(
    path.join(app.cwd, "package.json"),
    JSON.stringify({ scripts: { build: "node build.js" } }),
  );
  await app.command("/init");
  const updated = await readFile(path.join(app.cwd, "AGENTS.md"), "utf8");
  assert.match(updated, /Manual footer/);
  assert.match(updated, /npm run build/);
  assert.ok(!updated.includes("pnpm run test"));
});

test("Project memory supports CRUD/search, persists across sessions and reaches model instructions", async (t) => {
  const { app, output } = await application(t);
  app.agent = () => {
    throw new Error("Memory must not require inference");
  };
  await app.command("/memory add Responda em português.");
  let saved = await readMemory(app.cwd);
  const id = saved.entries[0].id;
  assert.match(await projectInstructions(app.cwd), /Responda em português/);
  await app.command("/memory search portugues");
  assert.match(output.at(-1), /Responda em português/);
  await app.command(`/memory edit ${id} Execute os testes antes de terminar.`);
  saved = await readMemory(app.cwd);
  assert.equal(saved.entries[0].text, "Execute os testes antes de terminar.");
  app.session = newSession(app.cwd, null);
  await app.command("/memory list");
  assert.match(output.at(-1), /Execute os testes/);
  await app.command(`/memory remove ${id}`);
  assert.equal((await readMemory(app.cwd)).entries.length, 0);
  await app.command("/memory Uma nota sem subcomando.");
  await app.command("/memory clear");
  assert.equal((await readMemory(app.cwd)).entries.length, 0);
  assert.equal(app.session.messages.length, 0);
});

test("Project instruction and memory writes honor plan mode and denied approvals", async (t) => {
  const { app } = await application(t);
  app.session.plan = true;
  await assert.rejects(app.command("/init"), /plan/);
  await assert.rejects(app.command("/memory add a note"), /plan/);
  await assert.rejects(readFile(path.join(app.cwd, MEMORY_FILE)), {
    code: "ENOENT",
  });
  app.session.plan = false;
  app.config.permission = "ask";
  app.ui.confirm = async () => "deny";
  await assert.rejects(app.command("/init"), /negou/);
  await assert.rejects(app.command("/memory add a note"), /negou/);
  assert.equal(app.session.checkpoints.length, 0);
  await assert.rejects(readFile(path.join(app.cwd, "AGENTS.md")), {
    code: "ENOENT",
  });
});
