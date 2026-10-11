import { captureKeys, printable } from "./terminal-input.js";
import { cellWidth, fitLine } from "./picker.js";
import { COMMAND_DEFINITIONS } from "./commands.js";

export class ChatInputState {
  constructor({ history = [], commands = COMMAND_DEFINITIONS } = {}) {
    this.characters = [];
    this.cursor = 0;
    this.history = history;
    this.historyIndex = -1;
    this.draft = "";
    this.commands = commands;
    this.selected = 0;
    this.dismissed = false;
    this.pasting = false;
  }
  get text() {
    return this.characters.join("");
  }
  get matches() {
    if (
      this.dismissed ||
      this.pasting ||
      this.historyIndex >= 0 ||
      !/^\/[^\s]*$/.test(this.text)
    )
      return [];
    const prefix = this.text.toLowerCase();
    return this.commands
      .filter((command) => command.name.startsWith(prefix))
      .sort((a, b) => Number(b.name === prefix) - Number(a.name === prefix));
  }
  setText(text) {
    this.characters = [...text];
    this.cursor = this.characters.length;
    this.selected = 0;
    this.dismissed = false;
  }
  changed() {
    this.selected = 0;
    this.dismissed = false;
    this.historyIndex = -1;
  }
  insert(text) {
    this.characters.splice(this.cursor, 0, ...[...text]);
    this.cursor += [...text].length;
    this.changed();
  }
  historyMove(direction) {
    if (!this.history.length) return;
    if (this.historyIndex === -1) this.draft = this.text;
    this.historyIndex = Math.max(
      -1,
      Math.min(this.history.length - 1, this.historyIndex + direction),
    );
    this.setText(
      this.historyIndex === -1 ? this.draft : this.history[this.historyIndex],
    );
  }
  key(text, key = {}) {
    const name = key.name;
    if (name === "paste-start" || key.sequence === "\x1b[200~") {
      this.pasting = true;
      return null;
    }
    if (name === "paste-end" || key.sequence === "\x1b[201~") {
      this.pasting = false;
      return null;
    }
    if (name === "c" && key.ctrl)
      return { done: true, value: null, interrupt: true };
    const matches = this.matches;
    if (name === "return" || name === "enter") {
      if (this.pasting) {
        this.insert("\n");
        return null;
      }
      if (matches.length) {
        const command = matches[Math.min(this.selected, matches.length - 1)];
        this.setText(command.name + (command.needsArgument ? " " : ""));
        if (command.needsArgument) return null;
      }
      if (this.text.trim() === "/") {
        this.setText("");
        return null;
      }
      return { done: true, value: this.text };
    }
    if (name === "tab") {
      if (this.pasting) this.insert("\t");
      else if (matches.length)
        this.setText(
          matches[Math.min(this.selected, matches.length - 1)].name + " ",
        );
      return null;
    }
    if (name === "escape") {
      this.dismissed = true;
      return null;
    }
    if (name === "up" || (name === "p" && key.ctrl)) {
      if (matches.length) this.selected = Math.max(0, this.selected - 1);
      else this.historyMove(1);
    } else if (name === "down" || (name === "n" && key.ctrl)) {
      if (matches.length)
        this.selected = Math.min(matches.length - 1, this.selected + 1);
      else this.historyMove(-1);
    } else if (name === "home" || (name === "a" && key.ctrl)) this.cursor = 0;
    else if (name === "end" || (name === "e" && key.ctrl))
      this.cursor = this.characters.length;
    else if (name === "left") {
      if (key.ctrl) {
        while (this.cursor && /\s/.test(this.characters[this.cursor - 1]))
          this.cursor--;
        while (this.cursor && !/\s/.test(this.characters[this.cursor - 1]))
          this.cursor--;
      } else this.cursor = Math.max(0, this.cursor - 1);
    } else if (name === "right") {
      if (key.ctrl) {
        while (
          this.cursor < this.characters.length &&
          !/\s/.test(this.characters[this.cursor])
        )
          this.cursor++;
        while (
          this.cursor < this.characters.length &&
          /\s/.test(this.characters[this.cursor])
        )
          this.cursor++;
      } else this.cursor = Math.min(this.characters.length, this.cursor + 1);
    } else if (name === "backspace") {
      if (this.cursor) {
        this.characters.splice(--this.cursor, 1);
        this.changed();
      }
    } else if (name === "delete") {
      this.characters.splice(this.cursor, 1);
      this.changed();
    } else if (name === "u" && key.ctrl) {
      this.setText("");
      this.historyIndex = -1;
    } else if (name === "k" && key.ctrl) {
      this.characters.splice(this.cursor);
      this.changed();
    } else if (name === "w" && key.ctrl) {
      const end = this.cursor;
      while (this.cursor && /\s/.test(this.characters[this.cursor - 1]))
        this.cursor--;
      while (this.cursor && !/\s/.test(this.characters[this.cursor - 1]))
        this.cursor--;
      this.characters.splice(this.cursor, end - this.cursor);
      this.changed();
    } else {
      const value = printable(text, key);
      if (value) this.insert(value);
    }
    return null;
  }
}

const visible = (text) => text.replaceAll("\n", "↵").replaceAll("\t", "⇥");

export async function interactiveChatInput({
  input,
  output,
  rl,
  label,
  history,
  theme = {},
  signal,
  registerCancel,
  onInterrupt,
  formatSubmitted,
}) {
  signal?.throwIfAborted();
  const state = new ChatInputState({ history });
  output.write("\x1b[?2004h");
  const identity = (value) => value;
  const color = {
    orange: identity,
    green: identity,
    muted: identity,
    ...theme,
  };
  let rowsDrawn = 1;
  let submitted = null;
  const buildFrame = () => {
    const columns = Math.max(1, output.columns || 100);
    const rows = Math.max(1, (output.rows || 24) - 1);
    const prompt = fitLine(label, Math.max(1, columns - 3));
    const available = Math.max(1, columns - cellWidth(prompt) - 1);
    let offset = 0;
    while (
      offset < state.cursor &&
      cellWidth(
        visible(state.characters.slice(offset, state.cursor).join("")),
      ) >= available
    )
      offset++;
    const draft = visible(state.characters.slice(offset).join(""));
    const cursorColumn = Math.min(
      Math.max(0, columns - 1),
      cellWidth(prompt) +
        cellWidth(
          visible(state.characters.slice(offset, state.cursor).join("")),
        ),
    );
    const lines = [];
    const borders = rows >= 3;
    const inputHeight = borders ? 3 : 1;
    const matches = state.matches;
    if (matches.length && rows > inputHeight) {
      const heading = rows >= inputHeight + 5;
      const hint = rows >= inputHeight + 4;
      const size = Math.max(
        1,
        Math.min(8, rows - inputHeight - Number(heading) - Number(hint)),
      );
      const start = Math.max(
        0,
        Math.min(state.selected - size + 1, Math.max(0, matches.length - size)),
      );
      if (heading)
        lines.push(
          color.muted(
            fitLine(
              `  COMANDOS · ${matches.length} opções`,
              Math.max(1, columns - 1),
            ),
          ),
        );
      for (const [i, command] of matches.slice(start, start + size).entries()) {
        const selected = start + i === state.selected;
        const line = fitLine(
          `  ${selected ? "›" : " "} ${command.name.padEnd(14)} ${command.description}`,
          Math.max(1, columns - 1),
        );
        lines.push(selected ? color.green(line) : line);
      }
      if (hint)
        lines.push(
          color.muted(
            fitLine(
              "  ↑↓ navegar · Tab completar · Enter selecionar · Esc fechar",
              Math.max(1, columns - 1),
            ),
          ),
        );
    }
    if (borders) lines.push(color.muted("─".repeat(Math.max(1, columns - 1))));
    const inputIndex = lines.length;
    lines.push(color.orange(prompt) + fitLine(draft, available));
    if (borders) lines.push(color.muted("─".repeat(Math.max(1, columns - 1))));
    return { lines, cursorColumn, inputIndex };
  };
  const render = () => {
    const { lines, cursorColumn, inputIndex } = buildFrame();
    if (output.managedViewport || output.fixedFooter) {
      if (lines.length !== rowsDrawn && output.redrawLayout) {
        output.redrawLayout();
        return;
      }
      const height = output.rows;
      const previousStart = Math.max(1, height - rowsDrawn + 1);
      const start = Math.max(1, height - lines.length + 1);
      const extra = Math.max(0, lines.length - rowsDrawn);
      output.write(
        `\x1b[?25l\x1b[${previousStart};1H\x1b[J${extra ? "\x1b[" + extra + "S" : ""}\x1b[${start};1H` +
          lines.map((line) => line + "\x1b[K").join("\r\n") +
          `\x1b[${start + inputIndex};${cursorColumn + 1}H\x1b[?25h`,
      );
      rowsDrawn = lines.length;
      return;
    }
    // Cursor returns to the prompt after every repaint, including terminal scroll.
    output.write(
      "\x1b[?25l\r\x1b[J" +
        lines.map((line) => line + "\x1b[K").join("\r\n") +
        "\r\n" +
        `\x1b[${lines.length - inputIndex}A\r${cursorColumn ? "\x1b[" + cursorColumn + "C" : ""}\x1b[?25h`,
    );
  };
  const resize = () => {
    rowsDrawn = buildFrame().lines.length;
    render();
  };
  const detach = output.attachOverlay?.({
    kind: "chat",
    getHeight: () => buildFrame().lines.length,
  });
  output.on("resize", resize);
  return captureKeys({
    input,
    rl,
    signal,
    registerCancel,
    render,
    onKey: (text, key) => {
      const result = state.key(text, key);
      if (result?.done) submitted = result.value;
      if (result?.interrupt && onInterrupt) onInterrupt();
      return result;
    },
    onCleanup: () => {
      output.removeListener("resize", resize);
      detach?.();
      output.write("\x1b[?2004l");
      const echo = formatSubmitted
        ? submitted === null
          ? ""
          : formatSubmitted(submitted) + "\r\n"
        : color.orange(label) + visible(state.text) + "\r\n";
      if (output.managedViewport || output.fixedFooter) {
        const start = Math.max(1, output.rows - rowsDrawn + 1);
        output.write(
          `\x1b[${start};1H\x1b[J\x1b[${output.rows};1H` + echo + "\x1b[?25h",
        );
        return;
      }
      output.write("\r\x1b[J" + echo + "\x1b[?25h");
    },
  });
}
