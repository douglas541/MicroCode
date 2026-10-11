import { captureKeys } from "./terminal-input.js";
import { fitLine } from "./picker.js";

export function toolPreview(call, context = {}) {
  const args = call.arguments || {};
  if (call.name === "shell")
    return [
      { text: "Diretório: " + (context.cwd || args.cwd || ".") },
      ...String(args.command || "")
        .split("\n")
        .map((line) => ({ text: "$ " + line })),
    ];
  const rows = [{ text: "Arquivo: " + (args.path || "") }];
  if (call.name === "edit_file") {
    const old = String(args.old_text || "").split("\n");
    const next = String(args.new_text || "").split("\n");
    rows.push(
      ...old
        .slice(0, 4)
        .map((line) => ({ text: "- " + line, kind: "removed" })),
    );
    if (old.length > 4)
      rows.push({ text: `… mais ${old.length - 4} linhas removidas` });
    rows.push(
      ...next.slice(0, 6).map((line) => ({ text: "+ " + line, kind: "added" })),
    );
    if (next.length > 6)
      rows.push({ text: `… mais ${next.length - 6} linhas adicionadas` });
    if (args.replace_all)
      rows.push({ text: "Substituir todas as ocorrências." });
  } else {
    const content = String(args.content || "").split("\n");
    rows.push({ text: "Conteúdo proposto para criação/substituição:" });
    rows.push(
      ...content
        .slice(0, 8)
        .map((line) => ({ text: "+ " + line, kind: "added" })),
    );
    if (content.length > 8)
      rows.push({ text: `… mais ${content.length - 8} linhas` });
  }
  return rows;
}

// Approval is a compact, non-searchable card in the chat, rather than another
// fullscreen model picker. Digits select immediately; arrows/Tab use Enter.
export async function approvalMenu({
  input,
  output,
  rl,
  title,
  preview = [],
  items,
  selectedValue,
  theme = {},
  signal,
  registerCancel,
  onInterrupt,
  onSummary = () => {},
}) {
  signal?.throwIfAborted();
  const identity = (value) => value;
  const color = {
    orange: identity,
    green: identity,
    red: identity,
    muted: identity,
    ...theme,
  };
  let index = Math.max(
    0,
    items.findIndex((item) => item.value === selectedValue),
  );
  let linesDrawn = 0;
  let decision = null;
  const writeFrame = (lines) => {
    if (output.managedViewport) {
      const previous = Math.max(1, output.rows - Math.max(1, linesDrawn) + 1);
      const start = Math.max(1, output.rows - lines.length + 1);
      const extra = Math.max(0, lines.length - Math.max(1, linesDrawn));
      output.write(
        `\x1b[?25l\x1b[${previous};1H\x1b[J${extra ? "\x1b[" + extra + "S" : ""}\x1b[${start};1H` +
          lines.map((line) => line + "\x1b[K").join("\r\n") +
          "\x1b[?25h",
      );
      linesDrawn = lines.length;
      return;
    }
    if (linesDrawn) output.write(`\x1b[${linesDrawn}A\r`);
    output.write(
      "\x1b[?25l" +
        lines.map((line) => line + "\x1b[K").join("\r\n") +
        "\r\n\x1b[J\x1b[?25h",
    );
    linesDrawn = lines.length;
  };
  const buildFrame = () => {
    const width = Math.max(1, Math.min(100, (output.columns || 100) - 1));
    const height = Math.max(1, (output.rows || 24) - 1);
    if (height < items.length + 4) {
      const small = [];
      if (height >= 2) small.push(color.orange(fitLine("  ◇ " + title, width)));
      small.push(
        color.green(fitLine(`  › ${index + 1}. ${items[index].label}`, width)),
      );
      if (height >= 3)
        small.push(color.muted(fitLine("  ↑↓ · Enter · Esc", width)));
      return small.slice(0, height);
    }
    const budget = Math.max(0, Math.min(12, height - items.length - 7));
    const lines = [
      color.orange(fitLine("  ◇ " + title, width)),
      color.muted("  " + "─".repeat(Math.max(1, width - 2))),
    ];
    for (const row of preview.slice(0, budget)) {
      const text = fitLine(
        "  " + (typeof row === "string" ? row : row.text),
        width,
      );
      lines.push(
        row.kind === "removed"
          ? color.red(text)
          : row.kind === "added"
            ? color.green(text)
            : text,
      );
    }
    if (preview.length > budget)
      lines.push(
        color.muted(`  … ${preview.length - budget} linhas de prévia omitidas`),
      );
    lines.push("");
    items.forEach((item, i) => {
      const text = fitLine(
        `  ${i === index ? "›" : " "} ${i + 1}. ${item.label}`,
        width,
      );
      lines.push(i === index ? color.green(text) : text);
    });
    if (items[index]?.description)
      lines.push(color.muted(fitLine("  " + items[index].description, width)));
    lines.push(
      color.muted(
        fitLine(
          "  ↑↓/Tab escolher · Enter confirmar · números: atalho · Esc negar",
          width,
        ),
      ),
    );
    return lines.slice(0, height);
  };
  const render = () => writeFrame(buildFrame());
  const resize = () => {
    linesDrawn = buildFrame().length;
    render();
  };
  const detach = output.attachOverlay?.({
    kind: "approval",
    getHeight: () => buildFrame().length,
  });
  if (!output.managedViewport) output.write("\n");
  output.on("resize", resize);
  return captureKeys({
    input,
    rl,
    signal,
    registerCancel,
    render,
    onKey: (text, key) => {
      if (key.ctrl && key.name === "c" && signal && onInterrupt) onInterrupt();
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        decision = "deny";
        return { done: true, value: decision };
      }
      if (key.name === "up") index = Math.max(0, index - 1);
      else if (key.name === "down")
        index = Math.min(items.length - 1, index + 1);
      else if (key.name === "tab")
        index = (index + (key.shift ? -1 : 1) + items.length) % items.length;
      else if (key.name === "home") index = 0;
      else if (key.name === "end") index = items.length - 1;
      else if (
        !key.ctrl &&
        !key.meta &&
        /^[1-9]$/.test(text) &&
        items[Number(text) - 1]
      ) {
        decision = items[Number(text) - 1].value;
        return { done: true, value: decision };
      } else if (key.name === "return" || key.name === "enter") {
        decision = items[index].value;
        return { done: true, value: decision };
      }
      return null;
    },
    onCleanup: () => {
      output.removeListener("resize", resize);
      detach?.();
      const label =
        items.find((item) => item.value === decision)?.label || "Cancelado";
      writeFrame([
        color.orange("  ◇ " + title),
        (decision && decision !== "deny" ? color.green : color.muted)(
          "  " + label,
        ),
      ]);
      if (output.managedViewport) output.write("\r\n");
      onSummary({ title, label });
    },
  });
}
