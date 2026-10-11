import { EventEmitter } from "node:events";
import { terminalDimensions } from "./terminal-layout.js";

const SAVE = "\x1b7";
const RESTORE = "\x1b8";

class ContentViewport extends EventEmitter {
  constructor(footer) {
    super();
    this.footer = footer;
  }
  get isTTY() {
    return Boolean(this.footer.output.isTTY);
  }
  get columns() {
    return this.footer.layout.columns;
  }
  get rows() {
    return this.footer.contentRows;
  }
  get fixedFooter() {
    return this.footer.active;
  }
  get managedViewport() {
    return this.isTTY;
  }
  attachOverlay(overlay) {
    this.footer.overlay = overlay;
    return () => {
      if (this.footer.overlay === overlay) this.footer.overlay = null;
    };
  }
  redrawLayout() {
    this.footer.repaint();
  }
  write(chunk, encoding, done) {
    const callback = typeof encoding === "function" ? encoding : done;
    return this.footer.write(
      Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
      callback,
    );
  }
}

// Resize is one transaction: new margins, a clean screen, logical transcript,
// the active widget and the footer. Never reuse cursor offsets from old geometry.
export class TerminalFooter {
  constructor({
    input,
    output,
    getLines,
    getTranscript = () => [],
    height = 2,
  }) {
    Object.assign(this, { input, output, getLines, getTranscript });
    this.maxHeight = height;
    this.layout = terminalDimensions(output);
    this.active = false;
    this.started = false;
    this.closed = false;
    this.alternate = false;
    this.overlay = null;
    this.repainting = false;
    this.view = new ContentViewport(this);
    this.onResize = () => this.resize();
    output.on?.("resize", this.onResize);
  }
  get supported() {
    return Boolean(
      this.input.isTTY &&
      this.output.isTTY &&
      this.layout.rows >= 6 &&
      this.layout.columns >= 12,
    );
  }
  get height() {
    if (!this.active) return 0;
    return Math.min(
      this.maxHeight,
      this.layout.columns >= 120 || this.layout.rows < 8 ? 1 : 2,
    );
  }
  get contentRows() {
    return Math.max(1, this.layout.rows - this.height);
  }
  get margins() {
    return this.active ? `\x1b[1;${this.contentRows}r` : "\x1b[r";
  }
  frame() {
    if (!this.active || this.closed) return "";
    const lines = this.getLines(this.layout.columns, this.height);
    let frame = SAVE;
    for (let i = 0; i < this.height; i++)
      frame += `\x1b[${this.contentRows + i + 1};1H\x1b[2K${lines[i] || ""}`;
    return frame + RESTORE;
  }
  start() {
    if (this.closed) return false;
    this.started = true;
    this.layout = terminalDimensions(this.output);
    const previous = this.active;
    this.active = this.supported;
    if (this.active && !previous)
      this.output.write(SAVE + this.margins + RESTORE);
    this.redraw();
    return this.active;
  }
  redraw() {
    if (!this.repainting) {
      const frame = this.frame();
      if (frame) this.output.write(frame);
    }
  }
  write(text, done) {
    let content = this.view.isTTY ? text.replace(/\r?\n/g, "\r\n") : text;
    if (this.view.isTTY && !this.closed) {
      if (content.includes("\x1b[?1049h")) this.alternate = true;
      if (content.includes("\x1b[?1049l")) {
        this.alternate = false;
        const before = content.slice(
          0,
          content.indexOf("\x1b[?1049l") + "\x1b[?1049l".length,
        );
        this.output.write(before);
        this.repaint(false);
        content = content.slice(before.length);
      }
      content = content.replaceAll(
        "\x1b[?1049h",
        "\x1b[?1049h" + SAVE + this.margins + RESTORE,
      );
      if (!this.repainting) content += this.frame();
    }
    return this.output.write(content, done);
  }
  repaint(notify = true) {
    if (this.closed || !this.view.isTTY) return;
    this.repainting = true;
    try {
      const reserve = this.alternate
        ? this.contentRows
        : Math.max(
            1,
            Math.min(this.contentRows, this.overlay?.getHeight?.() || 1),
          );
      const available = Math.max(0, this.contentRows - reserve);
      const rows = this.alternate
        ? []
        : this.getTranscript(this.layout.columns, available);
      // ED 2 archives the old viewport in Windows Terminal. Home + ED 0 clears
      // the same cells in place, without adding retired UI frames to scrollback.
      this.output.write(
        "\x1b[?25l\x1b[r\x1b[H\x1b[J" +
          this.margins +
          "\x1b[H" +
          (rows.length ? rows.join("\r\n") + "\r\n" : "") +
          `\x1b[${Math.max(1, this.contentRows - reserve + 1)};1H`,
      );
      if (notify) this.view.emit("resize");
      this.output.write(this.frame() + "\x1b[?25h");
    } finally {
      this.repainting = false;
    }
  }
  resize() {
    if (this.closed) return;
    this.layout = terminalDimensions(this.output);
    if (this.started) {
      this.active = this.supported;
    }
    if (this.view.isTTY) this.repaint();
    else this.view.emit("resize");
  }
  clear() {
    if (this.closed || !this.view.isTTY) return;
    this.output.write("\x1b[?25l\x1b[3J");
    this.repaint(false);
  }
  close() {
    if (this.closed) return;
    if (this.started && this.view.isTTY) {
      let clear = SAVE;
      for (let i = 0; i < this.height; i++)
        clear += `\x1b[${this.contentRows + i + 1};1H\x1b[2K`;
      this.output.write(clear + "\x1b[r" + RESTORE + "\x1b[?25h");
    }
    this.active = false;
    this.closed = true;
    this.output.removeListener?.("resize", this.onResize);
  }
}
