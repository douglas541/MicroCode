import { cellWidth } from "./picker.js";

export const stripAnsi = (text) =>
  String(text)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const parts = (text) =>
  [...graphemes.segment(text)].map((part) => part.segment);
const glyphWidth = (text) =>
  /\p{Emoji_Presentation}|\p{Regional_Indicator}|\ufe0f|\u20e3/u.test(text)
    ? 2
    : cellWidth(text);
export const visibleWidth = (text) =>
  parts(stripAnsi(text)).reduce((sum, part) => sum + glyphWidth(part), 0);
const span = (text, styles = []) => ({ text, styles });

function closePair(text, start, open, close) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === open) depth++;
    else if (text[i] === close && !--depth) return i;
  }
  return -1;
}

function delimiterEnd(text, start, marker) {
  const char = marker[0];
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") {
      const ticks = /^`+/.exec(text.slice(i))[0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end >= 0) {
        i = end + ticks.length - 1;
        continue;
      }
    }
    if (text[i] !== char) continue;
    let count = 1;
    while (text[i + count] === char) count++;
    if (count >= marker.length && !/\s/.test(text[i - 1] || " ")) {
      if (
        char === "_" &&
        /[\p{L}\p{N}]/u.test(text[i - 1] || "") &&
        /[\p{L}\p{N}]/u.test(text[i + count] || "")
      ) {
        i += count - 1;
        continue;
      }
      if (marker.length === 1 && count === 2) {
        i += count - 1;
        continue;
      }
      return i + (count === 3 && marker.length < 3 ? count - marker.length : 0);
    }
    i += count - 1;
  }
  return -1;
}

export function inlineMarkdown(
  text,
  { references = new Map(), styles = [], depth = 0 } = {},
) {
  if (depth > 10) return [span(text, styles)];
  const output = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      output.push(span(plain, styles));
      plain = "";
    }
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "\\" && /[\\`*_{}\[\]()#+.!>~|\-]/.test(text[i + 1] || "")) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const marker = /^`+/.exec(text.slice(i))[0];
      let end = text.indexOf(marker, i + marker.length);
      while (
        end >= 0 &&
        (text[end - 1] === "`" || text[end + marker.length] === "`")
      )
        end = text.indexOf(marker, end + marker.length);
      if (end >= 0) {
        flush();
        let code = text.slice(i + marker.length, end).replace(/\n/g, " ");
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim())
          code = code.slice(1, -1);
        output.push(span(code, [...styles, "code"]));
        i = end + marker.length;
        continue;
      }
    }
    const image = c === "!" && text[i + 1] === "[";
    if (c === "[" || image) {
      const opening = image ? i + 1 : i;
      const endLabel = closePair(text, opening + 1, "[", "]");
      if (endLabel >= 0) {
        const label = text.slice(opening + 1, endLabel);
        let destination;
        let end = endLabel + 1;
        if (text[end] === "(") {
          const endUrl = closePair(text, end + 1, "(", ")");
          if (endUrl >= 0) {
            destination = text
              .slice(end + 1, endUrl)
              .trim()
              .replace(/\s+["'][\s\S]*["']$/, "")
              .replace(/^<|>$/g, "")
              .replace(/\\([()])/g, "$1");
            end = endUrl + 1;
          }
        } else if (text[end] === "[") {
          const close = text.indexOf("]", end + 1);
          if (close >= 0) {
            destination = references.get(
              (text.slice(end + 1, close) || label).trim().toLowerCase(),
            );
            end = close + 1;
          }
        } else destination = references.get(label.trim().toLowerCase());
        if (destination) {
          flush();
          if (image) output.push(span("Imagem: ", styles));
          output.push(
            ...inlineMarkdown(label || "imagem", {
              references,
              styles: [...styles, "link"],
              depth: depth + 1,
            }),
          );
          output.push(span(` (${destination})`, [...styles, "muted"]));
          i = end;
          continue;
        }
      }
    }
    if (c === "<") {
      const auto = /^<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/i.exec(
        text.slice(i),
      );
      if (auto) {
        flush();
        output.push(span(auto[1], [...styles, "link"]));
        i += auto[0].length;
        continue;
      }
    }
    const marker = /^(\*{1,3}|_{1,3}|~~)/.exec(text.slice(i))?.[1];
    if (
      marker &&
      !/\s/.test(text[i + marker.length] || " ") &&
      !(marker[0] === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] || ""))
    ) {
      const end = delimiterEnd(text, i + marker.length, marker);
      if (end >= 0) {
        flush();
        const added =
          marker === "~~"
            ? ["strike"]
            : marker.length === 3
              ? ["bold", "italic"]
              : marker.length === 2
                ? ["bold"]
                : ["italic"];
        output.push(
          ...inlineMarkdown(text.slice(i + marker.length, end), {
            references,
            styles: [...styles, ...added],
            depth: depth + 1,
          }),
        );
        i = end + marker.length;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return output;
}

function codes(styles) {
  const set = new Set(styles);
  const result = [];
  if (set.has("bold") || set.has("heading")) result.push("1");
  if (set.has("italic")) result.push("3");
  if (set.has("strike")) result.push("9");
  if (set.has("muted")) result.push("90");
  if (set.has("heading")) result.push("38;5;215");
  if (set.has("codeblock")) result.push("38;5;252");
  if (set.has("code")) result.push("38;5;223", "48;5;235");
  if (set.has("link")) result.push("4", "38;5;81");
  return result.join(";");
}

function compose(atoms, color) {
  let output = "";
  let group = "";
  let style = null;
  const flush = () => {
    if (group)
      output += color && style ? `\x1b[${style}m${group}\x1b[0m` : group;
    group = "";
  };
  for (const atom of atoms) {
    const next = codes(atom.styles);
    if (next !== style) {
      flush();
      style = next;
    }
    group += atom.text;
  }
  flush();
  return output;
}

function atomsFor(spans) {
  return spans.flatMap((s) =>
    parts(s.text).map((text) => ({
      text,
      styles: s.styles,
      width: glyphWidth(text),
    })),
  );
}
const atomsWidth = (atoms) => atoms.reduce((sum, atom) => sum + atom.width, 0);
const space = (atom) => /^\s+$/.test(atom.text);

function wrapSpans(spans, width) {
  const output = [];
  let line = [];
  let size = 0;
  for (const atom of atomsFor(spans)) {
    if (size + atom.width > width && line.length) {
      let split = -1;
      for (let i = line.length - 1; i >= 0; i--)
        if (space(line[i])) {
          split = i;
          break;
        }
      if (split > 0) {
        output.push(line.slice(0, split));
        line = line.slice(split + 1);
        while (line.length && space(line[0])) line.shift();
        size = atomsWidth(line);
      } else {
        output.push(line);
        line = [];
        size = 0;
      }
    }
    if (!line.length && space(atom)) continue;
    line.push(atom);
    size += atom.width;
  }
  if (line.length || !output.length) output.push(line);
  return output;
}

function tableCells(line) {
  const cells = [];
  let buffer = "";
  let code = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      buffer += "\\|";
      i++;
      continue;
    }
    if (line[i] === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (!code) code = run;
      else if (code === run) code = 0;
      buffer += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (line[i] === "|" && !code) {
      cells.push(buffer.trim());
      buffer = "";
    } else buffer += line[i];
  }
  cells.push(buffer.trim());
  if (!cells[0]) cells.shift();
  if (!cells.at(-1)) cells.pop();
  return cells;
}

const fenceStart = (line) => /^\s*(`{3,}|~{3,})([^`]*)$/.exec(line);
const listStart = (line) => /^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/.exec(line);
const headingStart = (line) => /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
const ruleLine = (line) =>
  /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const tableSeparator = (line) => {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
};

export function renderMarkdown(
  markdown,
  { width = 88, color = false, indent = 2 } = {},
) {
  const source = stripAnsi(String(markdown).replace(/\r\n?/g, "\n")).replaceAll(
    "\t",
    "    ",
  );
  const references = new Map();
  let inFence = null;
  const lines = source.split("\n").filter((line) => {
    const fence = fenceStart(line);
    if (fence && !inFence) {
      inFence = fence[1];
      return true;
    }
    if (inFence) {
      if (new RegExp(`^\\s*${inFence[0]}{${inFence.length},}\\s*$`).test(line))
        inFence = null;
      return true;
    }
    const definition =
      /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+["'][^"']*["'])?\s*$/.exec(
        line,
      );
    if (!definition) return true;
    references.set(definition[1].trim().toLowerCase(), definition[2]);
    return false;
  });
  const totalWidth = Math.max(20, Math.min(240, Math.floor(width || 88)));
  const paint = (text, styles) =>
    compose(atomsFor([span(text, styles)]), color);
  const flow = (text, prefix, continuation = prefix, styles = []) => {
    const chunks = text.split("\n");
    const output = [];
    for (const chunk of chunks) {
      const available = Math.max(
        4,
        totalWidth - Math.max(visibleWidth(prefix), visibleWidth(continuation)),
      );
      const wrapped = wrapSpans(
        inlineMarkdown(chunk, { references, styles }),
        available,
      );
      wrapped.forEach((line, i) =>
        output.push(
          (output.length || i ? continuation : prefix) + compose(line, color),
        ),
      );
    }
    return output;
  };
  const renderTable = (header, alignment, rows, prefix) => {
    const columns = header.length;
    const data = [header, ...rows].map((row) =>
      header.map((_cell, i) => inlineMarkdown(row[i] || "", { references })),
    );
    const available = totalWidth - visibleWidth(prefix) - 3 * columns + 1;
    if (columns > 12 || available < columns * 3) {
      const output = [];
      for (const row of rows) {
        header.forEach((name, i) =>
          output.push(
            ...flow(
              `**${name || "Coluna " + (i + 1)}:** ${row[i] || ""}`,
              prefix,
            ),
          ),
        );
        output.push("");
      }
      return output;
    }
    const natural = header.map((_cell, i) =>
      Math.max(
        3,
        ...data.map((row) =>
          row[i].reduce((sum, s) => sum + visibleWidth(s.text), 0),
        ),
      ),
    );
    const widths = natural.map((w) =>
      Math.min(w, Math.max(3, Math.floor(available / columns))),
    );
    let spare = available - widths.reduce((sum, w) => sum + w, 0);
    while (spare > 0 && widths.some((w, i) => w < natural[i])) {
      for (let i = 0; i < columns && spare > 0; i++)
        if (widths[i] < natural[i]) {
          widths[i]++;
          spare--;
        }
    }
    const output = [];
    data.forEach((row, rowIndex) => {
      const cells = row.map((cell, i) =>
        wrapSpans(
          rowIndex === 0
            ? cell.map((s) => span(s.text, [...s.styles, "bold"]))
            : cell,
          widths[i],
        ),
      );
      const height = Math.max(...cells.map((cell) => cell.length));
      for (let line = 0; line < height; line++) {
        const rendered = cells.map((cell, i) => {
          const atoms = cell[line] || [];
          const extra = Math.max(0, widths[i] - atomsWidth(atoms));
          const left =
            alignment[i] === "right"
              ? extra
              : alignment[i] === "center"
                ? Math.floor(extra / 2)
                : 0;
          return (
            " " +
            " ".repeat(left) +
            compose(atoms, color) +
            " ".repeat(extra - left) +
            " "
          );
        });
        output.push(prefix + rendered.join(paint("│", ["muted"])));
      }
      if (!rowIndex)
        output.push(
          prefix +
            paint(widths.map((w) => "─".repeat(w + 2)).join("┼"), ["muted"]),
        );
    });
    return output;
  };
  const blocks = (input, prefix, depth = 0) => {
    const output = [];
    const isBlock = (line, next) =>
      !line.trim() ||
      fenceStart(line) ||
      headingStart(line) ||
      ruleLine(line) ||
      listStart(line) ||
      /^\s*>/.test(line) ||
      /^ {4}|^\t/.test(line) ||
      (line.includes("|") && next && tableSeparator(next));
    for (let i = 0; i < input.length; ) {
      const line = input[i];
      if (!line.trim()) {
        if (output.at(-1) !== "") output.push("");
        i++;
        continue;
      }
      const fence = fenceStart(line);
      if (fence) {
        const marker = fence[1];
        const language = fence[2].trim();
        const code = [];
        i++;
        while (
          i < input.length &&
          !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(
            input[i],
          )
        )
          code.push(input[i++]);
        if (i < input.length) i++;
        output.push(prefix + paint("╭─ " + (language || "código"), ["muted"]));
        for (const row of code)
          output.push(
            prefix +
              paint("│ ", ["muted"]) +
              paint(row.replaceAll("\t", "    "), ["codeblock"]),
          );
        output.push(prefix + paint("╰─", ["muted"]), "");
        continue;
      }
      const heading = headingStart(line);
      if (heading) {
        output.push(
          ...flow(heading[2].replace(/\s+#+\s*$/, ""), prefix, prefix, [
            "heading",
          ]),
          "",
        );
        i++;
        continue;
      }
      if (
        i + 1 < input.length &&
        /^ {0,3}(?:={3,}|-{3,})\s*$/.test(input[i + 1]) &&
        !listStart(line)
      ) {
        output.push(...flow(line, prefix, prefix, ["heading"]), "");
        i += 2;
        continue;
      }
      if (ruleLine(line)) {
        output.push(
          prefix +
            paint("─".repeat(Math.max(1, totalWidth - visibleWidth(prefix))), [
              "muted",
            ]),
          "",
        );
        i++;
        continue;
      }
      if (
        /^\s*>/.test(line) &&
        depth < 8 &&
        visibleWidth(prefix) < totalWidth - 10
      ) {
        const quoted = [];
        while (i < input.length && /^\s*>/.test(input[i]))
          quoted.push(input[i++].replace(/^\s*>\s?/, ""));
        output.push(
          ...blocks(quoted, prefix + paint("│ ", ["muted"]), depth + 1),
        );
        continue;
      }
      if (line.includes("|") && input[i + 1] && tableSeparator(input[i + 1])) {
        const header = tableCells(line);
        const separator = tableCells(input[i + 1]);
        const alignment = separator.map((c) =>
          c.startsWith(":") && c.endsWith(":")
            ? "center"
            : c.endsWith(":")
              ? "right"
              : "left",
        );
        const rows = [];
        i += 2;
        while (i < input.length && input[i].trim() && input[i].includes("|"))
          rows.push(tableCells(input[i++]));
        output.push(...renderTable(header, alignment, rows, prefix), "");
        continue;
      }
      const list = listStart(line);
      if (list) {
        let nesting = " ".repeat(
          Math.min(12, list[1].replaceAll("\t", "    ").length),
        );
        let marker = /^\d/.test(list[2]) ? list[2].replace(")", ".") : "•";
        let text = list[3];
        const task = /^\[([ xX])\]\s+/.exec(text);
        if (task) {
          marker = task[1].toLowerCase() === "x" ? "☑" : "☐";
          text = text.slice(task[0].length);
        }
        nesting = nesting.slice(
          0,
          Math.max(
            0,
            totalWidth - visibleWidth(prefix) - visibleWidth(marker) - 5,
          ),
        );
        i++;
        while (
          i < input.length &&
          input[i].trim() &&
          /^\s+/.test(input[i]) &&
          !isBlock(input[i].trimStart(), input[i + 1])
        )
          text += " " + input[i++].trim();
        const lead = prefix + nesting + marker + " ";
        const continuation =
          prefix + nesting + " ".repeat(visibleWidth(marker) + 1);
        output.push(...flow(text, lead, continuation));
        continue;
      }
      if (/^ {4}|^\t/.test(line)) {
        const code = [];
        while (
          i < input.length &&
          (/^ {4}|^\t/.test(input[i]) || !input[i].trim())
        )
          code.push(input[i++].replace(/^(?: {4}|\t)/, ""));
        while (code.at(-1) === "") code.pop();
        output.push(
          prefix + paint("╭─ código", ["muted"]),
          ...code.map(
            (row) =>
              prefix +
              paint("│ ", ["muted"]) +
              paint(row.replaceAll("\t", "    "), ["codeblock"]),
          ),
          prefix + paint("╰─", ["muted"]),
          "",
        );
        continue;
      }
      let paragraph = line;
      i++;
      while (i < input.length && !isBlock(input[i], input[i + 1])) {
        const hard = / {2}$|\\$/.test(paragraph);
        paragraph =
          paragraph.replace(/ {2}$|\\$/, "") +
          (hard ? "\n" : " ") +
          input[i++].trim();
      }
      output.push(...flow(paragraph, prefix));
    }
    while (output.at(-1) === "") output.pop();
    return output;
  };
  return blocks(lines, " ".repeat(Math.max(0, Math.min(12, indent)))).join(
    "\n",
  );
}
