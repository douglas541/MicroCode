import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { renderMarkdown, stripAnsi, visibleWidth } from "../src/markdown.js";
import { UI } from "../src/ui.js";
import { fixture, sseResponse, chatReply } from "./helpers.js";

test("The reported bold list example renders without literal Markdown markers", () => {
  const source =
    "Encontrei algumas opções.\n\n1. **Jardim Exótico**\n2. **Outro serviço**";
  const rendered = renderMarkdown(source, { color: true });
  assert.match(rendered, /1\. \x1b\[1mJardim Exótico\x1b\[0m/);
  assert.ok(!rendered.includes("**"));
  assert.match(stripAnsi(rendered), /1\. Jardim Exótico/);
  assert.match(stripAnsi(rendered), /2\. Outro serviço/);
});

test("Headings, bold, italic, strikethrough and nested emphasis receive terminal styles", () => {
  const result = renderMarkdown(
    "# Título\n\n**forte** _itálico_ ~~antigo~~ ***ambos***\n\n**negrito e *itálico***",
    { color: true },
  );
  assert.match(result, /\x1b\[1;38;5;215mTítulo/);
  assert.match(result, /\x1b\[1mforte/);
  assert.match(result, /\x1b\[3mitálico/);
  assert.match(result, /\x1b\[9mantigo/);
  assert.match(result, /\x1b\[1;3mambos/);
  assert.ok(!stripAnsi(result).includes("*"));
  assert.ok(!stripAnsi(result).includes("~~"));
});

test("Headings preserve meaningful hash characters such as C# and support setext headings", () => {
  const result = renderMarkdown(
    "# Linguagem C#\n\nOutro título\n---\n\n## Fechamento ###",
  );
  assert.match(result, /Linguagem C#/);
  assert.match(result, /Outro título/);
  assert.match(result, /Fechamento/);
  assert.ok(!result.includes("###"));
});

test("Inline/fenced code preserves Markdown-looking literals and indentation", () => {
  const result = renderMarkdown(
    'Use `foo_bar` e `**literal**`.\n\n```js\n  const text = "**not bold**";\n\tconsole.log(text);\n```',
    { color: true },
  );
  const plain = stripAnsi(result);
  assert.match(plain, /foo_bar/);
  assert.match(plain, /\*\*literal\*\*/);
  assert.match(plain, /const text = "\*\*not bold\*\*";/);
  assert.match(plain, /│     console.log/);
  assert.ok(!plain.includes("```"));
  assert.match(plain, /╭─ js/);
});

test("Code delimiters do not prematurely terminate surrounding emphasis", () => {
  const result = renderMarkdown(
    "**forte `x ** y` mais** e *itálico `a * b` fim*",
    { color: true },
  );
  assert.match(stripAnsi(result), /forte x \*\* y mais/);
  assert.match(stripAnsi(result), /itálico a \* b fim/);
  assert.ok(!stripAnsi(result).includes("**forte"));
});

test("Unclosed Markdown and escaped formatting remain literal rather than disappearing", () => {
  const result = renderMarkdown(
    String.raw`Texto **incompleto e \*literal\* e foo_bar`,
  );
  assert.match(result, /\*\*incompleto/);
  assert.match(result, /\*literal\*/);
  assert.match(result, /foo_bar/);
});

test("Lists, task items, nested items and quotations use readable structure", () => {
  const result = renderMarkdown(
    "- **item**\n  - subitem\n- [x] feito\n- [ ] pendente\n\n> **Citação**\n> outra linha",
  );
  assert.match(result, /• item/);
  assert.match(result, /    • subitem/);
  assert.match(result, /☑ feito/);
  assert.match(result, /☐ pendente/);
  assert.match(result, /│ Citação outra linha/);
});

test("Links, reference links, images and automatic URLs retain source destinations", () => {
  const source =
    '[Docs](https://example.com/path_(x)) e [referência][ref].\n\n![Diagrama](https://example.com/image.png)\n\n<https://example.com>\n\n[ref]: https://example.com/reference "title"';
  const result = renderMarkdown(source);
  assert.match(result, /Docs \(https:\/\/example.com\/path_\(x\)\)/);
  assert.match(result, /referência \(https:\/\/example.com\/reference\)/);
  assert.match(result, /Imagem: Diagrama/);
  assert.ok(!result.includes("[ref]:"));
  assert.ok(!result.includes("![Diagrama]"));
});

test("GFM tables are aligned and preserve literal pipes inside code and escaped cells", () => {
  const source =
    "| Nome | Valor |\n| :--- | ---: |\n| **Item** | `a|b` |\n| Escapado | c\\|d |";
  const result = renderMarkdown(source, { width: 60, color: true });
  const plain = stripAnsi(result);
  assert.match(plain, /Nome/);
  assert.match(plain, /Valor/);
  assert.match(plain, /a\|b/);
  assert.match(plain, /c\|d/);
  assert.match(plain, /┼/);
  assert.ok(!plain.includes(":---"));
  assert.ok(!plain.includes("**Item**"));
  assert.ok(plain.split("\n").every((line) => visibleWidth(line) <= 60));
});

test("Very narrow tables become vertical records without losing column values", () => {
  const result = renderMarkdown(
    "| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| one | two | three | four | five |",
    { width: 20 },
  );
  for (const value of ["A: one", "B: two", "C: three", "D: four", "E: five"])
    assert.match(result, new RegExp(value));
});

test("Paragraph/list wrapping respects visible terminal width, including ANSI styles and emoji clusters", () => {
  const result = renderMarkdown(
    "Um **texto comprido** com 🌱 emoji e palavras para quebrar corretamente.\n\n1. **Item com descrição longa** que deve continuar alinhado.\n            - item muito comprido com mais palavras",
    { width: 28, color: true },
  );
  for (const line of result.split("\n"))
    assert.ok(visibleWidth(line) <= 28, JSON.stringify(line));
  assert.equal(visibleWidth("👨‍👩‍👧‍👦"), 2);
  assert.equal(visibleWidth("ação"), 4);
  assert.match(stripAnsi(result), /Um texto/);
  assert.match(stripAnsi(result), /🌱/);
});

test("No-color output remains formatted plain text with no terminal escapes", () => {
  const result = renderMarkdown(
    "## Título\n\n**negrito** e *itálico*\n\n- item\n\n```txt\n**literal**\n```",
    { color: false },
  );
  assert.ok(!result.includes("\x1b"));
  assert.match(result, /negrito e itálico/);
  assert.match(result, /• item/);
  assert.match(result, /\*\*literal\*\*/);
});

test("Untrusted terminal controls are removed while code text and line breaks remain", () => {
  const result = renderMarkdown(
    "\x1b[2J**texto**\x1b]8;;https://bad\x07link\x1b]8;;\x07\r\n- item",
    { color: false },
  );
  assert.ok(!result.includes("\x1b"));
  assert.match(result, /textolink/);
  assert.match(result, /• item/);
});

test("UI formats both primary and btw responses without printing raw bold markers", (t) => {
  const input = new PassThrough();
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  stream.columns = 80;
  const ui = new UI({ input, output: stream });
  t.after(() => {
    ui.close();
    input.end();
  });
  ui.answer("1. **Jardim Exótico**");
  ui.answer("**Pergunta lateral**", "btw");
  assert.match(output, /● MicroCode/);
  assert.match(output, /↳ btw/);
  assert.ok(!output.includes("**"));
  assert.match(output, /1\. Jardim Exótico/);
});

test("Presentation formatting does not modify the raw Markdown in saved conversation history", async (t) => {
  const original = "# Resultado\n\n1. **Item**\n\n```js\nconst value = 1;\n```";
  const { agent, session } = await fixture(t, {
    fetchImpl: async () => sseResponse(chatReply(original)),
    ui: { answer: (value) => renderMarkdown(value, { color: true }) },
  });
  await agent.run("Responda em Markdown");
  assert.equal(session.messages.at(-1).content, original);
});
