import { captureKeys, printable } from "./terminal-input.js";

const normalized = (text) =>
  String(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const lineText = (text) =>
  String(text)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ");

export function cellWidth(text) {
  let width = 0;
  for (const c of String(text)) {
    const n = c.codePointAt(0);
    if (/\p{M}/u.test(c) || n === 0x200d || n === 0xfe0f) continue;
    width +=
      n >= 0x1100 &&
      (n <= 0x115f ||
        (n >= 0x2e80 && n <= 0xa4cf) ||
        (n >= 0xac00 && n <= 0xd7a3) ||
        (n >= 0xf900 && n <= 0xfaff) ||
        (n >= 0xfe10 && n <= 0xfe6f) ||
        (n >= 0xff00 && n <= 0xff60) ||
        n >= 0x1f300)
        ? 2
        : 1;
  }
  return width;
}

export function fitLine(text, width) {
  const safe = lineText(text);
  let result = "";
  if (cellWidth(safe) <= width) return safe;
  for (const c of safe) {
    if (cellWidth(result + c) > Math.max(0, width - 1)) break;
    result += c;
  }
  return result + "…";
}

export class PickerState {
  constructor(items, { query = "", selectedValue, pageSize = 10 } = {}) {
    this.items = items.map((item) => ({
      ...item,
      searchText: normalized(item.search || item.label),
    }));
    this.query = [...query.slice(0, 256)];
    this.cursor = this.query.length;
    this.index = 0;
    this.start = 0;
    this.pageSize = pageSize;
    this.filter();
    const selected = this.matches.findIndex(
      (item) => item.value === selectedValue,
    );
    if (selected >= 0) this.index = selected;
    this.ensureVisible();
  }
  filter() {
    const terms = normalized(this.query.join(""))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    this.matches = this.items.filter((item) =>
      terms.every((term) => item.searchText.includes(term)),
    );
    this.index = 0;
    this.start = 0;
  }
  ensureVisible() {
    this.index = Math.max(0, Math.min(this.index, this.matches.length - 1));
    if (this.index < this.start) this.start = this.index;
    if (this.index >= this.start + this.pageSize)
      this.start = this.index - this.pageSize + 1;
    this.start = Math.max(
      0,
      Math.min(this.start, Math.max(0, this.matches.length - this.pageSize)),
    );
  }
  key(text, key = {}) {
    const name = key.name;
    if (name === "escape" || (name === "c" && key.ctrl))
      return { done: true, value: null };
    if (name === "return" || name === "enter")
      return this.matches.length
        ? { done: true, value: this.matches[this.index].value }
        : null;
    if (name === "up" || (name === "p" && key.ctrl)) this.index--;
    else if (name === "down" || (name === "n" && key.ctrl)) this.index++;
    else if (name === "pageup") this.index -= this.pageSize;
    else if (name === "pagedown") this.index += this.pageSize;
    else if (name === "home" && key.ctrl) this.index = 0;
    else if (name === "end" && key.ctrl) this.index = this.matches.length - 1;
    else if (name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (name === "right")
      this.cursor = Math.min(this.query.length, this.cursor + 1);
    else if (name === "home" || (name === "a" && key.ctrl)) this.cursor = 0;
    else if (name === "end" || (name === "e" && key.ctrl))
      this.cursor = this.query.length;
    else if (name === "backspace") {
      if (this.cursor) {
        this.query.splice(--this.cursor, 1);
        this.filter();
      }
    } else if (name === "delete") {
      this.query.splice(this.cursor, 1);
      this.filter();
    } else if (name === "u" && key.ctrl) {
      this.query = [];
      this.cursor = 0;
      this.filter();
    } else {
      const value = [...printable(text, key)].slice(
        0,
        Math.max(0, 256 - this.query.length),
      );
      if (value.length) {
        this.query.splice(this.cursor, 0, ...value);
        this.cursor += value.length;
        this.filter();
      }
    }
    this.ensureVisible();
    return null;
  }
}

export async function interactivePicker({
  input,
  output,
  rl,
  title,
  hint = "",
  items,
  initialQuery = "",
  selectedValue,
  theme,
  signal,
  registerCancel,
  onInterrupt,
  allowDelete = false,
}) {
  signal?.throwIfAborted();
  const state = new PickerState(items, { query: initialQuery, selectedValue });
  const identity = (text) => text;
  const colors = {
    orange: identity,
    green: identity,
    muted: identity,
    bold: identity,
    ...theme,
  };
  let entered = false;
  const render = () => {
    const columns = Math.max(1, output.columns || 100);
    const rows = Math.max(1, output.rows || 24);
    const searchPrefix = columns >= 16 ? "  Buscar: " : "/ ";
    const queryWidth = Math.max(1, columns - cellWidth(searchPrefix) - 1);
    let queryStart = 0;
    while (
      queryStart < state.cursor &&
      cellWidth(state.query.slice(queryStart, state.cursor).join("")) >=
        queryWidth
    )
      queryStart++;
    const searchText =
      searchPrefix +
      fitLine(state.query.slice(queryStart).join(""), queryWidth);
    const queryColumn = Math.max(
      1,
      Math.min(
        columns,
        1 +
          cellWidth(searchPrefix) +
          cellWidth(state.query.slice(queryStart, state.cursor).join("")),
      ),
    );
    if (rows < 10) {
      const compact = [];
      if (rows >= 4)
        compact.push(
          colors.orange(fitLine("  " + title, Math.max(1, columns - 1))),
        );
      const searchRow = compact.length + 1;
      compact.push(fitLine(searchText, Math.max(1, columns - 1)));
      state.pageSize = Math.max(1, rows - compact.length - Number(rows >= 4));
      state.ensureVisible();
      for (const [i, item] of state.matches
        .slice(state.start, state.start + state.pageSize)
        .entries())
        compact.push(
          (state.start + i === state.index ? colors.green : (value) => value)(
            fitLine(
              (state.start + i === state.index ? "› " : "  ") + item.label,
              Math.max(1, columns - 1),
            ),
          ),
        );
      if (rows >= 4)
        compact.push(
          colors.muted(
            fitLine(
              "↑↓ Enter Esc" + (allowDelete ? " Del" : ""),
              Math.max(1, columns - 1),
            ),
          ),
        );
      output.write(
        "\x1b[?25l\x1b[H" +
          compact
            .slice(0, rows)
            .map((line) => line + "\x1b[K")
            .join("\r\n") +
          "\x1b[J" +
          `\x1b[${searchRow};${queryColumn}H\x1b[?25h`,
      );
      return;
    }
    state.pageSize = Math.max(1, Math.min(14, rows - 14));
    state.ensureVisible();
    const width = Math.max(1, columns - 1);
    const selected = state.matches[state.index];
    const lines = [
      colors.orange(fitLine("  MICROCODE / " + title, width)),
      colors.muted(fitLine("  " + hint, width)),
      "",
      fitLine(searchText, width),
      colors.muted(
        `  ${state.matches.length} resultados${state.matches.length ? " · " + (state.index + 1) + "/" + state.matches.length : ""}`,
      ),
      "",
    ];
    for (const [offset, item] of state.matches
      .slice(state.start, state.start + state.pageSize)
      .entries()) {
      const current = state.start + offset === state.index;
      const row = fitLine((current ? "  › " : "    ") + item.label, width);
      lines.push(current ? colors.green(row) : row);
    }
    if (!state.matches.length)
      lines.push(
        colors.muted(
          "    Nenhum resultado. Continue digitando ou apague o filtro.",
        ),
      );
    const detailRows = Math.max(0, rows - lines.length - 4);
    lines.push("");
    for (const detail of (selected?.details || []).slice(0, detailRows))
      lines.push(colors.muted(fitLine("  " + detail, width)));
    lines.push(
      "",
      colors.muted(
        fitLine(
          `  ↑↓ navegar · Enter selecionar${allowDelete ? " · Del excluir" : " · PgUp/PgDn rolar"} · Esc cancelar`,
          width,
        ),
      ),
    );
    const content = lines
      .slice(0, rows - 1)
      .map((line) => line + "\x1b[K")
      .join("\r\n");
    // Repaint in one write. The alternate screen preserves the chat transcript.
    output.write(
      "\x1b[?25l\x1b[H" +
        content +
        "\x1b[J" +
        `\x1b[4;${queryColumn}H\x1b[?25h`,
    );
  };
  output.write("\x1b[?1049h\x1b[2J");
  entered = true;
  const detach = output.attachOverlay?.({
    kind: "picker",
    getHeight: () => output.rows || 24,
  });
  output.on("resize", render);
  return captureKeys({
    input,
    rl,
    signal,
    registerCancel,
    onKey: (text, key) => {
      if (key.ctrl && key.name === "c" && signal && onInterrupt) onInterrupt();
      if (allowDelete && key.name === "delete" && state.matches.length)
        return {
          done: true,
          value: {
            action: "delete",
            value: state.matches[state.index].value,
            query: state.query.join(""),
          },
        };
      return state.key(text, key);
    },
    render,
    onCleanup: () => {
      output.removeListener("resize", render);
      detach?.();
      if (entered) output.write("\x1b[?25h\x1b[?1049l");
    },
  });
}
