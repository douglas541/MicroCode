import test from "node:test";
import assert from "node:assert/strict";
import { renderUserMessage, clean } from "../src/ui.js";
import { displayWidth } from "../src/terminal-layout.js";
import { PassThrough, Writable } from "node:stream";
import { UI } from "../src/ui.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, chatReply, sseResponse } from "./helpers.js";

test("User message panels wrap literal multiline input with aligned continuations and full-width styling", () => {
  const text = "Inspecione **esta pasta** 👨‍👩‍👧‍👦\n  Preserve identação e 文件.";
  for (const width of [6, 18, 42, 100]) {
    const panel = renderUserMessage(text, { width, color: true });
    const rows = panel.slice(1, -1).split("\n");
    for (const row of rows) {
      assert.equal(displayWidth(clean(row)), width - 1);
      assert.ok(
        row.endsWith("\x1b[0m"),
        "Each row must reset its background before subsequent output",
      );
    }
    const reconstructed = rows
      .map((row) =>
        clean(row)
          .slice(width >= 7 ? 4 : 2)
          .trimEnd(),
      )
      .join("");
    assert.ok(reconstructed.includes("👨‍👩‍👧‍👦"));
  }
  assert.match(
    renderUserMessage("**literal**\n  code", { width: 100 }),
    /❯ \*\*literal\*\*\n      code/,
  );
});

test("Plain user messages contain no ANSI and untrusted input cannot add terminal controls", () => {
  const plain = renderUserMessage("Meu pedido", { color: false });
  assert.equal(plain, "\n  ❯ Meu pedido\n");
  const untrusted = renderUserMessage("\x1b[2J\x1b[31mMeu pedido\x1b[0m", {
    color: true,
  });
  assert.ok(!untrusted.includes("\x1b[2J"));
  assert.ok(!untrusted.includes("\x1b[31m"));
  assert.match(clean(untrusted), /Meu pedido/);
});

test("Real agent iterations render compact commentary and nested tool results with one final assistant heading", async (t) => {
  let response = 0;
  let output = "";
  const input = new PassThrough();
  const destination = new Writable({
    write(chunk, _encoding, done) {
      output += chunk;
      done();
    },
  });
  const ui = new UI({ input, output: destination });
  t.after(() => {
    ui.close();
    input.end();
  });
  const f = await fixture(t, {
    native: true,
    fetchImpl: async () => {
      response++;
      return sseResponse(
        response < 3
          ? chatReply(
              response === 1
                ? "Vou inspecionar os arquivos."
                : "Agora vou verificar o restante.",
              [
                {
                  name: "read_file",
                  arguments: { path: "file.txt" },
                  id: `read-${response}`,
                },
              ],
            )
          : chatReply("Resultado final."),
      );
    },
    ui: {
      answer: (...args) => ui.answer(...args),
      toolResult: (...args) => ui.toolResult(...args),
    },
  });
  f.runner.onTool = (call) => ui.tool(call);
  await writeFile(path.join(f.cwd, "file.txt"), "line one\nline two");
  await f.agent.run("Inspecione", undefined);
  assert.equal((output.match(/● MicroCode/g) || []).length, 1);
  assert.match(output, /● Vou inspecionar os arquivos\./);
  assert.match(output, /● Agora vou verificar o restante\./);
  assert.match(output, /› read_file file.txt\n    └ 2 linhas/);
  assert.match(output, /● MicroCode\n  Resultado final\./);
  const before = structuredClone(f.session);
  output = "";
  ui.history(f.session);
  assert.equal((output.match(/● MicroCode/g) || []).length, 1);
  assert.match(output, /● Vou inspecionar/);
  assert.deepEqual(f.session, before);
});
