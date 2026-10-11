import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { writeFile, readFile } from "node:fs/promises";
import { Application } from "../src/cli.js";
import { Store, newSession } from "../src/store.js";
import { UI } from "../src/ui.js";
import {
  archiveMessages,
  conversationMessages,
  historyQuestions,
  sessionOption,
} from "../src/history.js";
import { fixture, temp, sseResponse, chatReply } from "./helpers.js";

function terminal(t) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
    return input;
  };
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 24;
  const ui = new UI({ input, output: stream });
  t.after(() => {
    ui.close();
    input.end();
  });
  return { ui, input, output: () => output };
}

test("/resume selects sessions by typing and arrows, replays the chosen conversation and restores state", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const alpha = newSession(cwd, { provider: "local", model: "model-a" });
  alpha.title = "Sessão Alpha";
  alpha.updatedAt = "2026-10-08T12:00:00Z";
  alpha.messages = [
    { role: "user", content: "Pergunta Alpha" },
    { role: "assistant", content: "**Resposta Alpha**" },
  ];
  alpha.toolApprovals.edits = true;
  const beta = newSession(cwd, { provider: "local", model: "model-b" });
  beta.title = "Sessão Beta";
  beta.updatedAt = "2026-10-08T13:00:00Z";
  beta.messages = [
    { role: "user", content: "Pergunta Beta" },
    { role: "assistant", content: "Resposta Beta" },
  ];
  const otherProject = newSession(path.join(cwd, "other"), null);
  otherProject.title = "Outro projeto";
  for (const session of [alpha, beta, otherProject])
    await store.write(`sessions/${session.id}.json`, session);
  const { ui, input, output } = terminal(t);
  const select = ui.select.bind(ui);
  ui.select = (options) => {
    assert.equal(options.items.length, 2);
    const pending = select(options);
    queueMicrotask(() => input.write("sessao\x1b[B\r"));
    return pending;
  };
  const current = newSession(cwd, null);
  const app = new Application({ cwd, store, config, session: current, ui });
  await app.command("/resume");
  assert.equal(app.session.id, alpha.id);
  assert.equal(config.selected.model, "model-a");
  assert.equal(app.session.toolApprovals.edits, true);
  assert.match(output(), /RETOMAR SESSÃO/);
  assert.match(output(), /HISTÓRICO DA SESSÃO/);
  assert.match(output(), /Pergunta Alpha/);
  assert.match(output(), /Resposta Alpha/);
  assert.ok(!output().includes("Sessão (número ou ID)"));
  assert.ok(!output().includes("**Resposta Alpha**"));
  assert.deepEqual(ui.chatHistory, ["Pergunta Alpha"]);
  assert.equal((await store.loadSession(current.id, cwd)).messages.length, 0);
});

test("Cancelling the session picker leaves the current session and configuration intact", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  await store.saveSession(newSession(cwd, null));
  const current = newSession(cwd, { provider: "old", model: "old-model" });
  config.selected = current.selected;
  const { ui, input } = terminal(t);
  const select = ui.select.bind(ui);
  ui.select = (options) => {
    const pending = select(options);
    queueMicrotask(() => input.emit("keypress", "", { name: "escape" }));
    return pending;
  };
  const app = new Application({ cwd, store, config, session: current, ui });
  await app.command("/resume");
  assert.equal(app.session.id, current.id);
  assert.equal(config.selected.model, "old-model");
});

test("All stored sessions can be browsed, including more than the old 20-session limit", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  for (let i = 0; i < 24; i++) {
    const session = newSession(cwd, null);
    session.title = "Session " + i;
    await store.saveSession(session);
  }
  let listed = 0;
  const app = new Application({
    cwd,
    store,
    config,
    session: newSession(cwd, null),
    ui: {
      select: async (options) => {
        listed = options.items.length;
        return null;
      },
      notice() {},
    },
  });
  await app.command("/resume");
  assert.equal(listed, 24);
});

test("History replay formats answers, hides protocol internals and never executes stored tool calls", async (t) => {
  const cwd = await temp(t);
  const file = path.join(cwd, "a.txt");
  await writeFile(file, "untouched");
  const session = newSession(cwd, null);
  session.messages = [
    { role: "user", content: "Uma pergunta" },
    {
      role: "assistant",
      content: "## Resposta\n\n1. **Item**",
      reasoningContent: "transport-only-secret",
      toolCalls: [
        {
          id: "t1",
          name: "write_file",
          arguments: { path: file, content: "must not execute" },
        },
      ],
    },
    {
      role: "tool",
      name: "write_file",
      toolCallId: "t1",
      content: '{"ok":true,"bytes":10}',
    },
    {
      role: "user",
      internal: true,
      content: "MICROCODE_PROTOCOL_ERROR\nprivate repair text",
    },
  ];
  const { ui, output } = terminal(t);
  const before = structuredClone(session);
  ui.history(session);
  assert.match(output(), /❯(?:\x1b\[[\d;]*m)* Uma pergunta/);
  assert.match(output(), /Uma pergunta/);
  assert.match(output(), /● (?:\x1b\[[\d;]*m)*Resposta/);
  assert.match(output(), /1\. .*Item/);
  assert.match(output(), /write_file/);
  assert.ok(!output().includes("transport-only-secret"));
  assert.ok(!output().includes("MICROCODE_PROTOCOL_ERROR"));
  assert.ok(!output().includes("**Item**"));
  assert.ok(!output().includes("must not execute"));
  assert.equal(await readFile(file, "utf8"), "untouched");
  assert.deepEqual(session, before);
});

test("Legacy flattened histories and compacted summaries are displayed as historical information", (t) => {
  const { ui, output } = terminal(t);
  const session = {
    messages: [
      {
        role: "user",
        internal: true,
        content: "MICROCODE_CONTEXT_SUMMARY\n**Resumo legado**",
      },
      {
        role: "assistant",
        content:
          '```microcode_tool\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```',
      },
      {
        role: "user",
        internal: true,
        content:
          'MICROCODE_TOOL_RESULTS\n{"id":"old","name":"read_file","result":"{\\"ok\\":true,\\"totalLines\\":3}"}',
      },
      { role: "assistant", content: "Arquivo lido." },
    ],
  };
  ui.history(session);
  assert.match(output(), /Resumo preservado/);
  assert.match(output(), /Resumo legado/);
  assert.match(output(), /3 linhas/);
  assert.ok(!output().includes("microcode_tool"));
  assert.ok(!output().includes("MICROCODE_TOOL_RESULTS"));
});

test("Archiving removed context preserves chronology without replaying generated summaries twice", () => {
  const session = {
    archivedMessages: [],
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
    ],
  };
  archiveMessages(session, session.messages);
  session.messages = [
    {
      role: "user",
      internal: true,
      content: "MICROCODE_CONTEXT_SUMMARY\nsummary",
    },
    { role: "user", content: "second" },
    { role: "assistant", content: "second answer" },
  ];
  archiveMessages(session, session.messages);
  session.messages = [
    {
      role: "user",
      internal: true,
      content: "MICROCODE_CONTEXT_SUMMARY\nsummary2",
    },
    { role: "user", content: "third" },
  ];
  assert.deepEqual(
    conversationMessages(session).map((m) => m.content),
    ["first", "first answer", "second", "second answer", "third"],
  );
  assert.deepEqual(historyQuestions(session), ["third", "second", "first"]);
});

test("Compaction archives original messages for resume while maintaining a smaller model context", async (t) => {
  const { agent, session, config, store, cwd } = await fixture(t, {
    fetchImpl: async () => sseResponse(chatReply("Resumo curto.")),
  });
  config.compaction.keepTurns = 1;
  const old = [
    { role: "user", content: "pergunta antiga ".repeat(100) },
    { role: "assistant", content: "resposta antiga ".repeat(100) },
  ];
  session.messages = [
    ...structuredClone(old),
    { role: "user", content: "pergunta recente" },
    { role: "assistant", content: "**resposta recente**" },
  ];
  assert.equal((await agent.compact()).changed, true);
  assert.deepEqual(session.archivedMessages, old);
  assert.equal(conversationMessages(session).length, 4);
  const restored = await store.loadSession(session.id, cwd);
  assert.deepEqual(conversationMessages(restored), [
    ...old,
    { role: "user", content: "pergunta recente" },
    { role: "assistant", content: "**resposta recente**" },
  ]);
});

test("Session options provide searchable IDs/models and readable counts/dates", () => {
  const session = newSession("/project", {
    provider: "openrouter",
    model: "cydonia",
  });
  session.title = "Fix project";
  session.messages = [
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
  ];
  const option = sessionOption(session);
  assert.match(option.search, /cydonia/);
  assert.ok(option.search.includes(session.id));
  assert.match(option.details[2], /1 perguntas · 1 respostas/);
});

test("Store deletes only sessions belonging to the requested project", async (t) => {
  const root = await temp(t);
  const cwd = path.join(root, "project");
  const otherCwd = path.join(root, "other");
  const store = new Store(path.join(root, "home"));
  const session = newSession(cwd, null);
  const other = newSession(otherCwd, null);
  await store.saveSession(session);
  await store.saveSession(other);
  await assert.rejects(store.deleteSession(other.id, cwd), /não encontrada/);
  assert.equal((await store.loadSession(other.id, otherCwd)).id, other.id);
  assert.equal((await store.deleteSession(session.id, cwd)).id, session.id);
  await assert.rejects(store.loadSession(session.id, cwd), /não encontrada/);
  assert.equal((await store.sessions(otherCwd)).length, 1);
});

test("Delete in the /resume picker confirms, refreshes the list and keeps other sessions", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const first = newSession(cwd, null);
  first.title = "First to delete";
  const second = newSession(cwd, null);
  second.title = "Keep this";
  await store.saveSession(first);
  await store.saveSession(second);
  const selections = [{ action: "delete", value: first.id, query: "" }, null];
  const prompts = [];
  let confirmations = 0;
  const notices = [];
  const ui = {
    select: async (options) => {
      prompts.push(options.items.map((i) => i.value));
      return selections.shift();
    },
    confirmAction: async (options) => {
      confirmations++;
      assert.equal(options.title, "EXCLUIR SESSÃO");
      assert.match(options.preview.join(" "), /First to delete/);
      return true;
    },
    notice: (text) => notices.push(text),
  };
  const app = new Application({
    cwd,
    store,
    config,
    session: newSession(cwd, null),
    ui,
  });
  await app.command("/resume");
  assert.equal(confirmations, 1);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes(first.id));
  assert.ok(!prompts[1].includes(first.id));
  assert.equal((await store.sessions(cwd)).length, 1);
  assert.equal((await store.loadSession(second.id, cwd)).title, "Keep this");
  assert.ok(notices.some((text) => /Sessão excluída/.test(text)));
});

test("Cancelling deletion keeps the session, and /resume never offers the active session", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const active = newSession(cwd, null);
  active.title = "Active";
  const other = newSession(cwd, null);
  other.title = "Other";
  await store.saveSession(active);
  await store.saveSession(other);
  let listed = [];
  const selections = [{ action: "delete", value: other.id, query: "" }, null];
  const app = new Application({
    cwd,
    store,
    config,
    session: active,
    ui: {
      select: async (options) => {
        listed = options.items.map((item) => item.value);
        return selections.shift();
      },
      confirmAction: async () => false,
      notice() {},
    },
  });
  await app.command("/resume");
  assert.ok(listed.includes(other.id));
  assert.ok(!listed.includes(active.id));
  assert.equal((await store.loadSession(other.id, cwd)).id, other.id);
  assert.equal((await store.loadSession(active.id, cwd)).id, active.id);
  assert.equal(app.session.id, active.id);
});
