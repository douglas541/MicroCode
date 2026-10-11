import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { UI, clean } from "../src/ui.js";
import { Store, newSession } from "../src/store.js";
import { Application } from "../src/cli.js";
import { temp } from "./helpers.js";
import path from "node:path";

// A small VT screen model checks actual row placement/scrolling, not just that
// status text was written somewhere into an ANSI capture.
class Screen {
  constructor(rows = 24, columns = 100) {
    this.rows = rows;
    this.columns = columns;
    this.scrollback = [];
    this.archiveOnEraseAll = false;
    this.main = this.buffer();
    this.current = this.main;
    this.mainCursor = null;
  }
  buffer() {
    return {
      lines: Array.from({ length: this.rows }, () =>
        Array(this.columns).fill(" "),
      ),
      x: 0,
      y: 0,
      saved: { x: 0, y: 0 },
      top: 0,
      bottom: this.rows - 1,
    };
  }
  scroll(amount = 1) {
    const b = this.current;
    for (let i = 0; i < amount; i++) {
      const removed = b.lines.splice(b.top, 1)[0];
      b.lines.splice(b.bottom, 0, Array(this.columns).fill(" "));
      if (b === this.main && b.top === 0)
        this.scrollback.push(removed.join(""));
    }
  }
  feed(text) {
    const b = () => this.current;
    for (let i = 0; i < text.length; ) {
      if (text[i] === "\x1b") {
        if (text[i + 1] === "7") {
          b().saved = { x: b().x, y: b().y };
          i += 2;
          continue;
        }
        if (text[i + 1] === "8") {
          b().x = Math.min(this.columns - 1, b().saved.x);
          b().y = Math.min(this.rows - 1, b().saved.y);
          i += 2;
          continue;
        }
        const match = /^\x1b\[([?\d;]*)([A-Za-z])/.exec(text.slice(i));
        if (!match) {
          i += 2;
          continue;
        }
        const [full, args, action] = match;
        i += full.length;
        const values = args.replace("?", "").split(";").map(Number);
        const n = values[0] || 1;
        if ((action === "h" || action === "l") && args === "?1049") {
          if (action === "h") {
            this.mainCursor = { x: b().x, y: b().y };
            this.current = this.buffer();
          } else {
            this.current = this.main;
            if (this.mainCursor) Object.assign(this.main, this.mainCursor);
          }
        } else if (action === "r") {
          b().top = args ? Math.max(0, n - 1) : 0;
          b().bottom = args
            ? Math.min(this.rows - 1, (values[1] || this.rows) - 1)
            : this.rows - 1;
          b().x = 0;
          b().y = 0;
        } else if (action === "H" || action === "f") {
          b().y = Math.max(0, Math.min(this.rows - 1, n - 1));
          b().x = Math.max(0, Math.min(this.columns - 1, (values[1] || 1) - 1));
        } else if (action === "A") b().y = Math.max(0, b().y - n);
        else if (action === "B") b().y = Math.min(this.rows - 1, b().y + n);
        else if (action === "C") b().x = Math.min(this.columns - 1, b().x + n);
        else if (action === "D") b().x = Math.max(0, b().x - n);
        else if (action === "G")
          b().x = Math.max(0, Math.min(this.columns - 1, n - 1));
        else if (action === "S") this.scroll(n);
        else if (action === "K") {
          const start = values[0] === 2 ? 0 : b().x;
          b().lines[b().y].fill(" ", start);
        } else if (action === "J") {
          if (values[0] === 3) this.scrollback = [];
          else if (values[0] === 2) {
            // Windows Terminal archives the main viewport for ED 2, unlike ED 0.
            if (this.archiveOnEraseAll && b() === this.main) {
              const last = b().lines.findLastIndex((row) =>
                row.some((cell) => cell !== " "),
              );
              this.scrollback.push(
                ...b()
                  .lines.slice(0, last + 1)
                  .map((row) => row.join("")),
              );
            }
            b().lines = Array.from({ length: this.rows }, () =>
              Array(this.columns).fill(" "),
            );
          } else {
            b().lines[b().y].fill(" ", b().x);
            for (let y = b().y + 1; y < this.rows; y++) b().lines[y].fill(" ");
          }
        }
        continue;
      }
      const char = String.fromCodePoint(text.codePointAt(i));
      i += char.length;
      if (char === "\r") {
        b().x = 0;
        continue;
      }
      if (char === "\n") {
        if (b().y === b().bottom) this.scroll();
        else b().y = Math.min(this.rows - 1, b().y + 1);
        continue;
      }
      if (char < " ") continue;
      if (b().x >= this.columns) {
        b().x = 0;
        if (b().y === b().bottom) this.scroll();
        else b().y++;
      }
      b().lines[b().y][b().x++] = char;
    }
  }
  resize(rows, columns) {
    this.rows = rows;
    this.columns = columns;
    for (const buffer of new Set([this.main, this.current])) {
      buffer.lines = Array.from({ length: rows }, (_v, i) =>
        Array.from({ length: columns }, (_c, j) => buffer.lines[i]?.[j] || " "),
      );
      buffer.y = Math.min(rows - 1, buffer.y);
      buffer.x = Math.min(columns - 1, buffer.x);
      buffer.bottom = rows - 1;
    }
  }
  line(y) {
    return this.current.lines[y].join("").trimEnd();
  }
  footer(height = 2) {
    return this.current.lines
      .slice(-height)
      .map((line) => line.join("").trimEnd());
  }
}

function terminal(t, tty = true) {
  const screen = new Screen();
  const input = new PassThrough();
  input.isTTY = tty;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
    return input;
  };
  let capture = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      const text = chunk.toString();
      capture += text;
      screen.feed(text);
      done();
    },
  });
  output.isTTY = tty;
  output.rows = 24;
  output.columns = 100;
  const ui = new UI({ input, output });
  t.after(() => {
    ui.close();
    input.end();
  });
  const session = newSession("/project", { provider: "local", model: "demo" });
  const model = { id: "deepseek/deepseek-v4.1-flash" };
  const stats = { tokens: 2000, limit: 1000000, ratio: 0.002 };
  return {
    ui,
    input,
    output,
    screen,
    session,
    model,
    stats,
    capture: () => capture,
  };
}

test("Submitted user requests are highlighted once, remain styled after resize and do not color assistant output", async (t) => {
  const { ui, input, output, screen, session, model, stats, capture } =
    terminal(t);
  ui.status(session, model, "native", stats);
  const request = ui.ask("  ❯ ", { commands: true });
  input.write("Inspecione este projeto.");
  const offset = capture().length;
  input.write("\r");
  assert.equal(await request, "Inspecione este projeto.");
  const submitted = capture().slice(offset);
  assert.equal(
    (clean(submitted).match(/❯ Inspecione este projeto\./g) || []).length,
    1,
  );
  if (!process.env.NO_COLOR)
    assert.match(submitted, /\x1b\[[\d;]*48;5;236[\d;]*m/);
  assert.equal(
    ui.transcriptRecords.filter((r) =>
      clean(r.message).includes("Inspecione este projeto."),
    ).length,
    1,
  );
  const afterUser = capture().length;
  ui.answer("Resposta do assistente.");
  assert.ok(!capture().slice(afterUser).includes("48;5;236"));
  const next = ui.ask("  ❯ ", { commands: true });
  input.write("rascunho");
  output.rows = 30;
  output.columns = 48;
  screen.resize(30, 48);
  output.emit("resize");
  const content = screen.current.lines.map((row) => row.join("")).join("\n");
  assert.equal((content.match(/❯ Inspecione este projeto\./g) || []).length, 1);
  assert.match(content, /rascunho/);
  if (!process.env.NO_COLOR)
    assert.ok(
      ui.viewportTranscript(48, 24).some((row) => row.includes("48;5;236")),
    );
  input.write("\r");
  assert.equal(await next, "rascunho");
});

test("The bordered input remains visible after submission, between inference steps and while tools print", async (t) => {
  const { ui, input, screen, session, model, stats } = terminal(t);
  screen.archiveOnEraseAll = true;
  ui.status(session, model, "text", stats);
  const request = ui.ask("  ❯ ", { commands: true });
  input.write("Quero mais detalhes\r");
  assert.equal(await request, "Quero mais detalhes");
  const assertInput = () => {
    assert.match(screen.line(ui.stdout.rows - 3), /─{10}/);
    assert.equal(screen.line(ui.stdout.rows - 2).trim(), "❯");
    assert.match(screen.line(ui.stdout.rows - 1), /─{10}/);
    assert.match(screen.footer()[0], /BUILD/);
  };
  assertInput();
  ui.start("text", "agent");
  ui.token("Vou pesquisar.", "text", "agent");
  ui.drawProgress();
  assertInput();
  ui.stop("agent");
  ui.answer("Vou pesquisar os detalhes.", "agent", { phase: "progress" });
  ui.tool({ name: "web_search", arguments: { query: "detalhes" } });
  ui.toolResult(
    { name: "web_search" },
    { ok: true, results: Array(5).fill({}), provider: "duckduckgo" },
  );
  assertInput();
  for (let i = 0; i < 40; i++) ui.print("ACTUAL_TOOL_OUTPUT " + i);
  assertInput();
  assert.ok(
    screen.scrollback.some((line) => line.includes("ACTUAL_TOOL_OUTPUT")),
  );
  assert.ok(
    !screen.scrollback.some(
      (line) => /─{10}|BUILD/.test(line) || line.trim() === "❯",
    ),
  );
  ui.start("text", "agent");
  ui.stop("agent");
  ui.answer("Resposta final com os detalhes.");
  assertInput();
  const next = ui.ask("  ❯ ", { commands: true });
  assertInput();
  input.write("próximo pedido\r");
  assert.equal(await next, "próximo pedido");
});

test("Background input preserves its draft across progress, tools, resize and the next chat prompt", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "text", stats);
  const request = ui.ask("  ❯ ", { commands: true });
  input.write("Pedido inicial\r");
  await request;
  const questions = [];
  ui.onBackgroundLine = (line) => questions.push(line);
  ui.start("text", "agent");
  input.write("/btw deta");
  ui.answer("Comentário intermediário.", "agent", { phase: "progress" });
  ui.tool({ name: "read_file", arguments: { path: "README.md" } });
  ui.drawProgress();
  assert.match(screen.line(ui.stdout.rows - 2), /❯ \/btw deta$/);
  assert.equal(screen.current.y, ui.stdout.rows - 2);
  output.rows = 30;
  output.columns = 80;
  screen.resize(30, 80);
  output.emit("resize");
  assert.match(screen.line(ui.stdout.rows - 2), /❯ \/btw deta$/);
  input.write("lhes\r");
  assert.deepEqual(questions, ["/btw detalhes"]);
  assert.equal(ui.queue.length, 0);
  assert.equal(screen.line(ui.stdout.rows - 2).trim(), "❯");
  input.write("rascunho do próximo pedido");
  input.write("\x1b[D");
  ui.stop("agent");
  ui.answer("Resposta concluída.");
  const next = ui.ask("  ❯ ", { commands: true });
  assert.match(screen.line(ui.stdout.rows - 2), /rascunho do próximo pedido/);
  input.write("!\r");
  assert.equal(await next, "rascunho do próximo pedid!o");
});

test("Background drafts and the input panel return after approvals, pickers and masked prompts", async (t) => {
  const { ui, input, output, screen, session, model, stats, capture } =
    terminal(t);
  ui.status(session, model, "text", stats);
  const request = ui.ask("  ❯ ", { commands: true });
  input.write("Pedido inicial\r");
  await request;
  input.write("KEEP_BACKGROUND_DRAFT");
  const assertInput = () => {
    assert.match(screen.line(ui.stdout.rows - 3), /─{10}/);
    assert.match(screen.line(ui.stdout.rows - 2), /KEEP_BACKGROUND_DRAFT/);
    assert.match(screen.line(ui.stdout.rows - 1), /─{10}/);
    assert.equal(screen.current.bottom, ui.stdout.rows - 4);
  };
  const approval = ui.confirm({
    name: "shell",
    arguments: { command: "node --version" },
  });
  input.write("1");
  assert.equal(await approval, "once");
  assertInput();
  const question = ui.ask("  Provider ID: ");
  input.write("local\r");
  assert.equal(await question, "local");
  assertInput();
  const picker = ui.select({
    title: "MODELOS",
    items: [{ value: "a", label: "A" }],
  });
  input.emit("keypress", "", { name: "escape" });
  assert.equal(await picker, null);
  assertInput();
  const secret = ui.ask("  API key: ", { secret: true });
  input.write("PRIVATE_TEST_VALUE");
  output.rows = 30;
  output.columns = 80;
  screen.resize(30, 80);
  output.emit("resize");
  input.write("\r");
  assert.equal(await secret, "PRIVATE_TEST_VALUE");
  assertInput();
  assert.ok(!capture().includes("PRIVATE_TEST_VALUE"));
  const next = ui.ask("  ❯ ", { commands: true });
  input.write("\r");
  assert.equal(await next, "KEEP_BACKGROUND_DRAFT");
});

test("Slash commands stay compact and cancelled drafts are not committed as user messages", async (t) => {
  const { ui, input, session, model, stats, capture } = terminal(t);
  ui.status(session, model, "native", stats);
  const command = ui.ask("  ❯ ", { commands: true });
  input.write("/model");
  const offset = capture().length;
  input.write("\r");
  assert.equal(await command, "/model");
  assert.ok(!capture().slice(offset).includes("48;5;236"));
  const request = ui.ask("  ❯ ", { commands: true });
  input.write("pedido ainda não enviado");
  ui.cancelInput();
  assert.equal(await request, null);
  assert.ok(
    !ui.transcriptRecords.some((r) =>
      clean(r.message).includes("pedido ainda não enviado"),
    ),
  );
});

test("Intermediate narration and nested tools reflow together without repeated assistant headings", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  ui.answer(
    "Vou inspecionar os arquivos antes de continuar a análise.",
    "agent",
    { phase: "progress" },
  );
  ui.tool({
    name: "web_search",
    arguments: {
      query: "documentação da ferramenta e exemplos oficiais atualizados",
    },
  });
  ui.toolResult(
    { name: "web_search" },
    {
      ok: true,
      results: [{ url: "https://example.test" }],
      provider: "bing",
      fallback: true,
    },
  );
  ui.answer("Agora verificarei as fontes encontradas.", "agent", {
    phase: "progress",
  });
  ui.answer("Conclusão da análise.");
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("rascunho");
  output.rows = 40;
  output.columns = 40;
  screen.resize(40, 40);
  output.emit("resize");
  const rows = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join("").trimEnd());
  const transcript = rows.join("\n");
  assert.equal((transcript.match(/● MicroCode/g) || []).length, 1);
  assert.match(transcript, /● Vou inspecionar/);
  const call = rows.findIndex((row) => row.includes("› web_search"));
  assert.ok(call >= 0);
  assert.ok(rows[call + 1].startsWith("    "));
  assert.ok(rows.some((row) => row.startsWith("    └ 1 resultados")));
  assert.match(transcript, /rascunho/);
  input.write("\r");
  assert.equal(await prompt, "rascunho");
});

test("Status occupies physical bottom rows and is not appended to the transcript each prompt", (t) => {
  const { ui, screen, session, model, stats } = terminal(t);
  ui.banner("/project");
  ui.status(session, model, "native", stats);
  assert.equal(ui.stdout.rows, 22);
  assert.equal(screen.current.bottom, 21);
  assert.match(screen.footer()[0], /BUILD · deepseek/);
  assert.match(screen.footer()[1], new RegExp(session.id.slice(0, 8)));
  assert.match(screen.footer()[0], /ctx 0%/);
  ui.status(session, model, "native", stats);
  ui.status(session, model, "native", stats);
  assert.ok(
    !screen.current.lines
      .slice(0, ui.stdout.rows)
      .some((line) => line.join("").includes("BUILD")),
  );
});

test("Transcript scrolling and erase operations cannot remove or scroll the footer", (t) => {
  const { ui, screen, session, model, stats } = terminal(t);
  screen.archiveOnEraseAll = true;
  ui.status(session, model, "native", stats);
  for (let i = 0; i < 100; i++) ui.print("Conversation line " + i);
  const before = screen.footer();
  ui.stdout.write("\r\x1b[J");
  assert.deepEqual(screen.footer(), before);
  assert.ok(
    screen.scrollback.some((line) => line.includes("Conversation line")),
  );
  assert.ok(!screen.scrollback.some((line) => line.includes("BUILD")));
});

test("Prompt stays above the footer, and slash completion preserves footer rows", async (t) => {
  const { ui, input, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("/mod");
  assert.match(screen.footer()[0], /BUILD/);
  assert.ok(
    screen.current.lines
      .slice(0, ui.stdout.rows)
      .some((line) => line.join("").includes("COMANDOS")),
  );
  input.write("\t");
  input.write("query");
  assert.match(screen.line(ui.stdout.rows - 2), /❯ \/models query/);
  input.write("\r");
  assert.equal(await prompt, "/models query");
  assert.match(screen.footer()[0], /BUILD/);
});

test("Command suggestions render above the bordered input and leave the input next to the compact footer", async (t) => {
  const { ui, input, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("/mod");
  const content = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""));
  const commandRow = content.findIndex((row) => row.includes("/models"));
  const inputRow = content.findIndex((row) => row.includes("❯ /mod"));
  assert.ok(commandRow >= 0 && commandRow < inputRow, content.join("\n"));
  assert.match(content[inputRow - 1], /─{10}/);
  assert.match(content[inputRow + 1], /─{10}/);
  assert.equal(inputRow, ui.stdout.rows - 2);
  assert.ok(ui.footer.height <= 2);
  input.write("\r");
  assert.equal(await prompt, "/models");
});

test("Opening and dismissing slash suggestions preserves the banner and visible conversation", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  output.rows = 36;
  screen.resize(36, 100);
  output.emit("resize");
  ui.banner("/project");
  ui.status(session, model, "native", stats);
  ui.answer("KEEP_RESPONSE: uma mensagem já exibida.");
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("/");
  const open = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""))
    .join("\n");
  assert.match(open, /MicroCode/);
  assert.match(open, /Projeto.*project/);
  assert.match(open, /KEEP_RESPONSE/);
  input.emit("keypress", "", { name: "escape" });
  const closed = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""))
    .join("\n");
  assert.match(closed, /KEEP_RESPONSE/);
  assert.ok(!closed.includes("COMANDOS"));
  assert.match(closed, /MicroCode/);
  input.write("\x15normal\r");
  assert.equal(await prompt, "normal");
});

test("Windows Terminal redraws do not archive banners, prompts or footer updates into scrollback", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  screen.archiveOnEraseAll = true;
  output.rows = 44;
  output.columns = 180;
  screen.resize(44, 180);
  output.emit("resize");
  screen.scrollback.push("EXISTING_SHELL_HISTORY");
  ui.banner("/project");
  ui.status(session, model, "text", stats);
  ui.answer("REAL_RESPONSE: preserve this conversation.");
  const history = [...screen.scrollback];
  const prompt = ui.ask("  ❯ ", { commands: true });
  assert.deepEqual(screen.scrollback, history);
  for (let i = 0; i < 5; i++) {
    input.write("/");
    input.emit("keypress", "", { name: "escape" });
    input.write("\x15");
    ui.updateContext({ ...stats, ratio: 0.02 }, "text");
    ui.start("text", "agent");
    ui.token("update", "text", "agent");
    ui.drawProgress();
    ui.stop("agent");
    assert.deepEqual(screen.scrollback, history);
  }
  input.write("KEEP_DRAFT");
  for (const [rows, columns] of [
    [38, 90],
    [44, 180],
  ]) {
    output.rows = rows;
    output.columns = columns;
    screen.resize(rows, columns);
    output.emit("resize");
    assert.deepEqual(screen.scrollback, history);
    const content = screen.current.lines.map((row) => row.join("")).join("\n");
    assert.equal((content.match(/<\/>/g) || []).length, 1);
    assert.equal((content.match(/REAL_RESPONSE/g) || []).length, 1);
    assert.equal((content.match(/KEEP_DRAFT/g) || []).length, 1);
    assert.equal((content.match(/BUILD/g) || []).length, 1);
  }
  ui.cancelInput();
  assert.equal(await prompt, null);
});

test("Wide terminals use one footer row with a readable model label, narrower terminals use at most two", (t) => {
  const { ui, output, screen, session, stats } = terminal(t);
  const model = {
    id: "cognitivecomputations/dolphin-mistral-24b-venice-edition",
    name: "Venice: Uncensored",
  };
  ui.status(session, model, "text", { ...stats, ratio: 0.03 });
  assert.equal(ui.footer.height, 2);
  assert.match(screen.footer()[0], /Venice: Uncensored/);
  assert.match(screen.footer()[0], /ctx 3%/);
  output.columns = 170;
  screen.resize(24, 170);
  output.emit("resize");
  assert.equal(ui.footer.height, 1);
  const footer = screen.footer(1)[0];
  assert.match(footer, /Venice: Uncensored/);
  assert.match(footer, /ctx 3%/);
  assert.match(footer, /tok\/s/);
  assert.match(footer, /\$0.00/);
  assert.ok(!footer.includes("cognitivecomputations/"));
  output.columns = 60;
  screen.resize(24, 60);
  output.emit("resize");
  assert.equal(ui.footer.height, 2);
});

test("Live generation, usage, context changes and resumed session state update in place", (t) => {
  const { ui, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  ui.start("native", "agent");
  ui.token("generated text", "native", "agent");
  ui.drawProgress();
  assert.match(screen.footer()[1], /gerando ~/);
  session.usage.push({ input: 100, output: 40, cost: 0.002, seconds: 2 });
  ui.usage(session.usage.at(-1));
  ui.stop("agent");
  assert.match(screen.footer()[1], /100 in\/40 out/);
  assert.match(screen.footer()[1], /20.0 tok\/s/);
  ui.updateContext({ ...stats, tokens: 4000, ratio: 0.004 }, "text");
  assert.match(screen.footer()[0], /ctx 0%/);
  assert.equal(ui.statusState.mode, "text");
  assert.ok(!screen.footer().join("").includes("texto"));
  const next = newSession("/project", { model: "other" });
  ui.bindSession(next);
  assert.match(screen.footer()[0], /other/);
  assert.match(screen.footer()[1], new RegExp(next.id.slice(0, 8)));
});

test("Pickers and inline approval dialogs retain the footer and restore the main viewport", async (t) => {
  const { ui, input, screen, session, model, stats } = terminal(t);
  screen.archiveOnEraseAll = true;
  ui.status(session, model, "native", stats);
  const history = [...screen.scrollback];
  const selected = ui.select({
    title: "MODELOS",
    items: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  });
  assert.match(screen.footer()[0], /BUILD/);
  input.write("\x1b[B\r");
  assert.equal(await selected, "b");
  assert.deepEqual(screen.scrollback, history);
  assert.equal(screen.current, screen.main);
  assert.equal(screen.current.bottom, 21);
  const approval = ui.confirm({
    name: "shell",
    arguments: { command: "node --version" },
  });
  assert.match(screen.footer()[0], /BUILD/);
  input.write("1");
  assert.equal(await approval, "once");
  assert.match(screen.footer()[1], new RegExp(session.id.slice(0, 8)));
});

test("Resizing repositions the footer without losing the typed prompt", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("draft");
  output.rows = 30;
  output.columns = 60;
  screen.resize(30, 60);
  output.emit("resize");
  assert.equal(ui.stdout.rows, 28);
  assert.equal(screen.current.bottom, 27);
  assert.match(screen.line(ui.stdout.rows - 2), /draft/);
  assert.match(screen.footer()[0], /BUILD/);
  input.write("\r");
  assert.equal(await prompt, "draft");
});

test("Growing the terminal does not leave the previous footer inside the conversation", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.banner("/project");
  ui.status(session, model, "native", stats);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("draft");
  output.rows = 36;
  screen.resize(36, 100);
  output.emit("resize");
  const content = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""));
  assert.ok(!content.some((row) => row.includes("BUILD")), content.join("\n"));
  assert.match(screen.footer()[0], /BUILD/);
  input.write("\r");
  assert.equal(await prompt, "draft");
});

test("An approval remains readable and selected after shrinking and growing the terminal", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  const pending = ui.confirm({
    name: "shell",
    arguments: { command: "node --version" },
  });
  input.write("\x1b[B");
  for (const [rows, columns] of [
    [18, 50],
    [32, 110],
    [22, 60],
  ]) {
    output.rows = rows;
    output.columns = columns;
    screen.resize(rows, columns);
    output.emit("resize");
    const content = screen.current.lines
      .slice(0, ui.stdout.rows)
      .map((row) => row.join(""))
      .join("\n");
    assert.equal((content.match(/APROVAR COMANDO/g) || []).length, 1, content);
    assert.match(content, /2\. Permitir este comando/);
  }
  input.write("\r");
  assert.equal(await pending, "session");
});

test("Repeated grow/shrink cycles keep one prompt and one footer, including compact terminal sizes", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.banner("/project");
  ui.status(session, model, "native", stats);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("KEEP_DRAFT");
  for (const [rows, columns] of [
    [36, 110],
    [14, 40],
    [10, 24],
    [24, 100],
    [30, 60],
    [18, 80],
  ]) {
    output.rows = rows;
    output.columns = columns;
    screen.resize(rows, columns);
    output.emit("resize");
    assert.equal(screen.current.bottom, ui.stdout.rows - 1);
    const content = screen.current.lines
      .slice(0, ui.stdout.rows)
      .map((row) => row.join(""))
      .join("\n");
    assert.equal((content.match(/KEEP_DRAFT/g) || []).length, 1, content);
    assert.ok(!content.includes("BUILD"), content);
  }
  input.write("\r");
  assert.equal(await prompt, "KEEP_DRAFT");
});

test("Autocomplete and session picker preserve their highlighted item and query across resize", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("/mod\x1b[B");
  for (const [rows, columns] of [
    [14, 42],
    [30, 90],
  ]) {
    output.rows = rows;
    output.columns = columns;
    screen.resize(rows, columns);
    output.emit("resize");
  }
  input.write("\r");
  assert.equal(await prompt, "/model");
  const selected = ui.select({
    title: "RETOMAR SESSÃO",
    items: [
      { value: "a", label: "Session Alpha" },
      { value: "b", label: "Session Beta" },
    ],
  });
  input.write("session\x1b[B");
  for (const [rows, columns] of [
    [12, 32],
    [28, 110],
  ]) {
    output.rows = rows;
    output.columns = columns;
    screen.resize(rows, columns);
    output.emit("resize");
  }
  input.write("\r");
  assert.equal(await selected, "b");
  assert.equal(screen.current, screen.main);
  assert.equal(screen.current.bottom, ui.stdout.rows - 4);
  assert.match(screen.line(ui.stdout.rows - 3), /─{10}/);
  assert.equal(screen.line(ui.stdout.rows - 2).trim(), "❯");
  const content = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""))
    .join("\n");
  assert.ok(!content.includes("Session Alpha"));
  assert.ok(!content.includes("BUILD"));
});

test("Resize re-renders styled conversation at the new width instead of retaining old wrapping/footer fragments", async (t) => {
  const { ui, input, output, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  ui.answer(
    "## Resultado\n\nEste texto com **formatação** precisa acompanhar a largura da janela corretamente.\n\n1. Última linha preservada.",
  );
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("draft");
  output.rows = 32;
  output.columns = 46;
  screen.resize(32, 46);
  output.emit("resize");
  const content = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""))
    .join("\n");
  assert.match(content, /Resultado/);
  assert.match(content, /Última linha preservada/);
  assert.equal((content.match(/● MicroCode/g) || []).length, 1);
  assert.ok(!content.includes("BUILD"));
  input.write("\r");
  assert.equal(await prompt, "draft");
});

test("Masked API-key input survives resizing without replaying its secret into the transcript", async (t) => {
  const { ui, input, output, screen, session, model, stats, capture } =
    terminal(t);
  ui.status(session, model, "native", stats);
  const key = "PRIVATE_TEST_VALUE";
  const pending = ui.ask("  API key: ", { secret: true });
  input.write(key);
  output.rows = 20;
  output.columns = 50;
  screen.resize(20, 50);
  output.emit("resize");
  assert.ok(!capture().includes(key));
  assert.ok(
    screen.current.lines
      .slice(0, ui.stdout.rows)
      .some((row) => row.join("").includes("API key")),
  );
  input.write("\r");
  assert.equal(await pending, key);
  assert.ok(!ui.viewportTranscript(50, 20).join("\n").includes(key));
});

test("Closing restores terminal margins and clears reserved status rows", (t) => {
  const { ui, screen, session, model, stats } = terminal(t);
  ui.status(session, model, "native", stats);
  ui.close();
  assert.equal(screen.current.bottom, 23);
  assert.deepEqual(screen.footer(), ["", ""]);
  assert.equal(ui.footer.active, false);
});

test("Non-TTY output keeps plain status text without terminal positioning sequences", (t) => {
  const { ui, capture, session, model, stats } = terminal(t, false);
  ui.status(session, model, "native", stats);
  assert.equal(ui.footer.active, false);
  assert.match(capture(), /BUILD · deepseek/);
  assert.ok(!capture().includes("\x1b["));
});

test("/clear removes old command output and visual replay cache while keeping the previous saved session", async (t) => {
  const { ui, input, output, screen, session, model, stats, capture } =
    terminal(t);
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  session.cwd = cwd;
  session.title = "Conversa anterior";
  session.messages = [
    { role: "user", content: "Pergunta anterior" },
    { role: "assistant", content: "**Resposta anterior**" },
  ];
  config.selected = session.selected;
  ui.banner(cwd);
  ui.status(session, model, "native", stats);
  ui.recordInput("  ❯ ", "/model");
  ui.print("OLD_MODEL_DETAILS");
  ui.recordInput("  ❯ ", "/connect");
  ui.answer("OLD_RESPONSE");
  ui.chatHistory = ["Pergunta anterior"];
  ui.deferredOutput.push({ message: "STALE_DEFERRED" });
  screen.archiveOnEraseAll = true;
  screen.scrollback.push("OLD_SCROLLBACK");
  const app = new Application({ cwd, store, config, session, ui });
  await app.command("/clear");
  const fresh = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""))
    .join("\n");
  assert.ok(!fresh.includes("OLD_MODEL_DETAILS"));
  assert.ok(!fresh.includes("OLD_RESPONSE"));
  assert.ok(!fresh.includes("❯ /connect"));
  assert.ok(!ui.viewportTranscript(100, 30).join("\n").includes("❯ /model"));
  assert.match(fresh, /MicroCode/);
  assert.ok(capture().includes("\x1b[3J"));
  assert.ok(
    !screen.scrollback.some((row) =>
      /OLD_SCROLLBACK|OLD_RESPONSE|OLD_MODEL_DETAILS/.test(row),
    ),
  );
  assert.notEqual(app.session.id, session.id);
  assert.equal(app.session.messages.length, 0);
  assert.deepEqual(ui.chatHistory, []);
  assert.deepEqual(ui.deferredOutput, []);
  assert.deepEqual(
    (await store.loadSession(session.id, cwd)).messages,
    session.messages,
  );
  const prompt = ui.ask("  ❯ ", { commands: true });
  input.write("/");
  output.rows = 30;
  output.columns = 80;
  screen.resize(30, 80);
  output.emit("resize");
  const afterResize = screen.current.lines
    .slice(0, ui.stdout.rows)
    .map((row) => row.join(""))
    .join("\n");
  assert.ok(!afterResize.includes("OLD_MODEL_DETAILS"));
  assert.ok(!afterResize.includes("OLD_RESPONSE"));
  assert.ok(!afterResize.includes("STALE_DEFERRED"));
  input.emit("keypress", "", { name: "escape" });
  input.write("\x15novo pedido\r");
  assert.equal(await prompt, "novo pedido");
});
