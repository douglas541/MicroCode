import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { UI } from "../src/ui.js";
import { PickerState } from "../src/picker.js";
import path from "node:path";
import { Application } from "../src/cli.js";
import { Store, newSession } from "../src/store.js";
import { temp, server } from "./helpers.js";

const models = [
  {
    value: "venice",
    label: "Venice Dolphin",
    search: "venice dolphin",
    details: ["Entrada $0.2 · saída $0.9", "Tools: texto"],
  },
  {
    value: "cydonia",
    label: "Cydonia 24B",
    search: "thedrummer/cydonia-24b-v4.1",
  },
  { value: "deepseek", label: "DeepSeek Flash", search: "deepseek flash" },
];

test("Typing filters immediately; arrows navigate; n/p are search text, not pagination commands", () => {
  const state = new PickerState(models);
  state.key("cy", {});
  assert.deepEqual(
    state.matches.map((m) => m.value),
    ["cydonia"],
  );
  assert.equal(state.key("", { name: "return" }).value, "cydonia");
  state.key("", { name: "u", ctrl: true });
  assert.equal(state.matches.length, 3);
  state.key("n", { name: "n" });
  assert.equal(state.query.join(""), "n");
  state.key("", { name: "u", ctrl: true });
  state.key("", { name: "down" });
  assert.equal(state.key("", { name: "return" }).value, "cydonia");
});

test("Selection scrolls into view; search supports multiple accent-insensitive terms", () => {
  const state = new PickerState(
    Array.from({ length: 60 }, (_, i) => ({
      value: String(i),
      label: `Modelo grátis ${i}`,
    })),
    { pageSize: 5 },
  );
  state.key("", { name: "pagedown" });
  assert.equal(state.index, 5);
  assert.ok(state.start > 0);
  state.key("", { name: "end", ctrl: true });
  assert.equal(state.index, 59);
  assert.equal(state.start, 55);
  state.key("gratis 59", {});
  assert.deepEqual(
    state.matches.map((m) => m.value),
    ["59"],
  );
});

test("Search editing, empty results and Escape are handled without confirming a wrong model", () => {
  const state = new PickerState(models);
  state.key("unknown", {});
  assert.equal(state.matches.length, 0);
  assert.equal(state.key("", { name: "return" }), null);
  state.key("", { name: "u", ctrl: true });
  state.key("cyonia", {});
  state.key("", { name: "home" });
  state.key("", { name: "right" });
  state.key("", { name: "right" });
  state.key("d", {});
  assert.equal(state.query.join(""), "cydonia");
  assert.equal(state.matches[0].value, "cydonia");
  assert.equal(state.key("", { name: "escape" }).value, null);
});

function terminal(t) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
    return input;
  };
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  const ui = new UI({ input, output });
  t.after(() => {
    ui.close();
    input.end();
  });
  return { ui, input, output, text: () => text };
}

test("Actual keypress stream drives live selection and chat readline works afterwards", async (t) => {
  const { ui, input, text } = terminal(t);
  const selected = ui.select({ title: "MODELOS", items: models });
  input.write("cy");
  assert.match(text(), /Buscar: cy/);
  input.write("\r");
  assert.equal(await selected, "cydonia");
  assert.match(text(), /\x1b\[\?1049h/);
  assert.match(text(), /\x1b\[\?1049l/);
  const chat = ui.ask("> ");
  input.write("/status\r");
  assert.equal(await chat, "/status");
  assert.deepEqual(ui.queue, []);
});

test("Arrow keys traverse the list, Escape cancels, resize redraws and EOF cleans up", async (t) => {
  const { ui, input, output } = terminal(t);
  const selected = ui.select({ title: "MODELOS", items: models });
  input.write("\x1b[B");
  output.emit("resize");
  input.write("\r");
  assert.equal(await selected, "cydonia");
  const cancelled = ui.select({ title: "MODELOS", items: models });
  input.emit("keypress", "", { name: "escape" });
  assert.equal(await cancelled, null);
  const ended = ui.select({ title: "MODELOS", items: models });
  input.end();
  assert.equal(await ended, null);
});

test("Delete key returns a dedicated delete action with the current session and search filter", async (t) => {
  const { ui, input, text } = terminal(t);
  const pending = ui.select({
    title: "RETOMAR SESSÃO",
    hint: "Del excluir",
    allowDelete: true,
    initialQuery: "project",
    items: [
      { value: "one", label: "Project One", search: "project one" },
      { value: "two", label: "Project Two", search: "project two" },
    ],
  });
  input.write("\x1b[3~");
  assert.deepEqual(await pending, {
    action: "delete",
    value: "one",
    query: "project",
  });
  assert.match(text(), /Del excluir/);
  assert.match(text(), /RETOMAR SESSÃO/);
});

test("Secret input is masked, supports clearing and does not leak into history/next command", async (t) => {
  const { ui, input, text } = terminal(t);
  const secret = "sk-or-v1-" + "a".repeat(64);
  const password = ui.ask("API key: ", { secret: true });
  input.write("wrong");
  input.emit("keypress", "", { name: "u", ctrl: true });
  input.write(secret);
  input.write("\r");
  assert.equal(await password, secret);
  assert.ok(!text().includes(secret));
  assert.match(text(), /73 caracteres/);
  assert.ok(!ui.rl.history.includes(secret));
  const next = ui.ask("> ");
  input.write("/models\r");
  assert.equal(await next, "/models");
});

test("/models integrates the live picker with catalog pricing, filtering and persisted selection", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const gateway = await server(t, () => ({
    json: {
      data: [
        {
          id: "thedrummer/cydonia-a",
          name: "Cydonia A",
          context_length: 64000,
          supported_parameters: [],
          pricing: { prompt: "0.0000003", completion: "0.0000005" },
        },
        {
          id: "thedrummer/cydonia-b",
          name: "Cydonia B",
          context_length: 64000,
          supported_parameters: ["tools"],
          pricing: { prompt: "0.0000004", completion: "0.0000006" },
        },
        {
          id: "deepseek/flash",
          name: "DeepSeek Flash",
          supported_parameters: ["tools"],
        },
      ],
    },
  }));
  config.providers.local = {
    name: "Local",
    baseURL: gateway.url,
    catalog: "custom",
  };
  config.selected = { provider: "local", model: null };
  const { ui, input, text } = terminal(t);
  const select = ui.select.bind(ui);
  ui.select = (options) => {
    const pending = select(options);
    queueMicrotask(() => input.write("onia\x1b[B\r"));
    return pending;
  };
  const app = new Application({
    cwd,
    store,
    config,
    session: newSession(cwd, config.selected),
    ui,
  });
  await app.command("/models cyd");
  assert.equal(config.selected.model, "thedrummer/cydonia-b");
  assert.match(text(), /Buscar: cydonia/);
  assert.match(text(), /\$0\.300/);
  assert.match(text(), /tools nativas/);
  assert.equal((await store.config()).selected.model, "thedrummer/cydonia-b");
});

test("Directory permission dialog accepts a session grant and restores the chat input", async (t) => {
  const { ui, input, text } = terminal(t);
  const approval = ui.confirmDirectory({
    directory: "/external/project",
    path: "/external/project/README.md",
    tool: "read_file",
  });
  input.write("\x1b[B\r");
  assert.equal(await approval, "session");
  assert.match(text(), /PERMISSÃO DE DIRETÓRIO/);
  assert.match(text(), /external\/project/);
  const next = ui.ask("> ");
  input.write("continuar\r");
  assert.equal(await next, "continuar");
});

test("Ctrl+C in a running permission dialog aborts execution and cleans up the terminal", async (t) => {
  const { ui, input, text } = terminal(t);
  const controller = new AbortController();
  ui.onInterrupt = () => controller.abort(new Error("user cancelled"));
  const approval = ui.confirmDirectory(
    { directory: "/external", path: "/external/a", tool: "read_file" },
    controller.signal,
  );
  input.write("\x03");
  await assert.rejects(approval, /user cancelled/);
  assert.match(text(), /\x1b\[\?25h/);
  assert.equal(ui.rawInputActive, false);
});

test("Tool approval is an inline menu with numbered choices and supports arrows/Enter", async (t) => {
  const { ui, input, text } = terminal(t);
  const pending = ui.confirm({
    name: "edit_file",
    arguments: { path: "app.js", old_text: "old()", new_text: "new()" },
  });
  assert.match(text(), /APROVAR EDIÇÃO/);
  assert.match(text(), /- old\(\)/);
  assert.match(text(), /\+ new\(\)/);
  assert.ok(!text().includes("[s/N]"));
  assert.ok(!text().includes("\x1b[?1049h"));
  input.write("\x1b[B\r");
  assert.equal(await pending, "session");
  const chat = ui.ask("> ");
  input.write("continuar\r");
  assert.equal(await chat, "continuar");
});

test("Numeric shortcuts approve once or deny without treating permission dialogs as search", async (t) => {
  const { ui, input } = terminal(t);
  const once = ui.confirm(
    { name: "shell", arguments: { command: "node --version" } },
    undefined,
    { cwd: "/project" },
  );
  input.write("1");
  assert.equal(await once, "once");
  const denied = ui.confirm({
    name: "write_file",
    arguments: { path: "a", content: "data" },
  });
  input.write("3");
  assert.equal(await denied, "deny");
  const cancelled = ui.confirm({
    name: "shell",
    arguments: { command: "node --version" },
  });
  input.emit("keypress", "", { name: "escape" });
  assert.equal(await cancelled, "deny");
});

test("Approval cards preserve asynchronous output until the user has finished deciding", async (t) => {
  const { ui, input, text } = terminal(t);
  const approval = ui.confirm({
    name: "shell",
    arguments: { command: "node --version" },
  });
  ui.notice("background response ready");
  assert.ok(!text().includes("background response ready"));
  input.write("1");
  await approval;
  assert.match(text(), /background response ready/);
});

test("Destructive actions default to cancel and accept only an explicit choice", async (t) => {
  const { ui, input } = terminal(t);
  const cancel = ui.confirmAction({
    title: "REVERTER TURNO",
    preview: ["Some files"],
    acceptLabel: "Reverter",
  });
  input.write("\r");
  assert.equal(await cancel, false);
  const accept = ui.confirmAction({
    title: "SOBRESCREVER",
    preview: ["file.md"],
    acceptLabel: "Sobrescrever",
  });
  input.write("1");
  assert.equal(await accept, true);
});

test("Typing slash opens a command list immediately and narrows it while typing", async (t) => {
  const { ui, input, text } = terminal(t);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("/");
  assert.match(text(), /COMANDOS/);
  assert.match(text(), /\/help/);
  assert.match(text(), /Mostrar ajuda/);
  input.write("mod");
  assert.match(text(), /COMANDOS · 2 opções/);
  input.write("\t");
  input.write("cydonia\r");
  assert.equal(await prompt, "/models cydonia");
  assert.deepEqual(ui.queue, []);
});

test("Slash menu supports arrow/Enter selection and argument commands keep the prompt open", async (t) => {
  const { ui, input } = terminal(t);
  const selected = ui.ask("> ", { commands: true });
  input.write("/mod\x1b[B\r");
  assert.equal(await selected, "/model");
  const argument = ui.ask("> ", { commands: true });
  input.write("/bt\r");
  input.write("pergunta lateral\r");
  assert.equal(await argument, "/btw pergunta lateral");
  assert.equal(ui.chatHistory[0], "/btw pergunta lateral");
});

test("Chat prompt keeps history and ordinary text editing outside the command menu", async (t) => {
  const { ui, input } = terminal(t);
  const first = ui.ask("> ", { commands: true });
  input.write("primeiro pedido\r");
  assert.equal(await first, "primeiro pedido");
  const history = ui.ask("> ", { commands: true });
  input.write("\x1b[A\r");
  assert.equal(await history, "primeiro pedido");
  const edited = ui.ask("> ", { commands: true });
  input.write("textoX\x7f\r");
  assert.equal(await edited, "texto");
});

test("Banner uses a clean code mark and a Portuguese descriptor", (t) => {
  const { ui, text } = terminal(t);
  ui.banner("/project/MicroCode");
  assert.match(text(), /<\/>  MicroCode/);
  assert.match(text(), /Agente de código para o terminal/);
  assert.match(text(), /v0\.1\.0/);
  assert.ok(!text().includes("▗▄▖"));
  assert.ok(!text().includes("native intelligence"));
});

test("Actual bracketed multiline paste stays in one chat request and restores terminal paste mode", async (t) => {
  const { ui, input, text } = terminal(t);
  const prompt = ui.ask("> ", { commands: true });
  input.write("\x1b[200~primeira linha\rsegunda linha\x1b[201~\r");
  assert.equal(await prompt, "primeira linha\nsegunda linha");
  assert.match(text(), /\x1b\[\?2004h/);
  assert.match(text(), /\x1b\[\?2004l/);
});
