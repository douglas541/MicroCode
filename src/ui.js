import readline from "node:readline";
import { Writable } from "node:stream";
import { estimateTokens, totals } from "./metrics.js";

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const paint = (code, value) =>
  useColor ? `\x1b[${code}m${value}\x1b[0m` : String(value);
export const color = {
  orange: (v) => paint("38;5;215", v),
  green: (v) => paint("38;5;114", v),
  muted: (v) => paint("90", v),
  red: (v) => paint("31", v),
  bold: (v) => paint("1", v),
};
export const clean = (value) =>
  String(value)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export const money = (value) =>
  value == null ? "n/d" : `$${value.toFixed(value < 0.01 ? 6 : 3)}`;
export const price = (value) =>
  value == null ? "n/d" : value === 0 ? "grátis" : `$${value.toFixed(3)}`;
export const count = (value) =>
  value == null
    ? "n/d"
    : value >= 1e6
      ? `${(value / 1e6).toFixed(2)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(value);

export function modelLine(m) {
  const native =
    m.nativeTools === true
      ? "sim"
      : m.nativeTools === false
        ? "não → texto"
        : "? → texto";
  return `${clean(m.name)}\n     ${clean(m.id)}\n     entrada ${price(m.inputPrice)} · saída ${price(m.outputPrice)} / 1M tokens · tools nativas: ${native} · contexto ${count(m.context)} · ${m.protocol}`;
}

export class UI {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.stdout = output;
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    this.muted = false;
    this.streams = new Map();
    this.progress = false;
    this.output = new Writable({
      write: (chunk, encoding, done) => {
        if (!this.muted) output.write(chunk, encoding);
        done();
      },
    });
    this.rl = readline.createInterface({
      input,
      output: this.output,
      terminal: Boolean(input.isTTY && output.isTTY),
      completer: (line) => {
        const commands = COMMANDS.filter((c) => c.startsWith(line));
        return [commands, line];
      },
    });
    this.rl.on("line", (line) => {
      if (this.waiter) {
        const { resolve, secret } = this.waiter;
        this.waiter = null;
        this.muted = false;
        if (secret) {
          this.rl.history = (this.rl.history || []).filter((h) => h !== line);
          output.write("\n");
        }
        resolve(line);
      } else if (this.onBackgroundLine && line.startsWith("/btw "))
        this.onBackgroundLine(line);
      else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.muted = false;
      if (this.waiter) {
        this.waiter.resolve(null);
        this.waiter = null;
      }
    });
    this.rl.on("SIGINT", () => {
      if (this.onInterrupt) this.onInterrupt();
      else this.close();
    });
  }
  banner(cwd) {
    this.print(
      `\n${color.orange("  ▗▄▖  MICROCODE")} ${color.muted("v0.1.0")}`,
    );
    this.print(color.muted("  native intelligence · text-powered tools"));
    this.print(`  ${clean(cwd)}\n`);
    this.print(
      `  ${color.orange("/connect")} provider   ${color.orange("/models")} modelo   ${color.orange("/help")} comandos\n`,
    );
  }
  print(message = "") {
    this.clearProgress();
    this.stdout.write(message + "\n");
  }
  error(message) {
    this.print(color.red("  × " + clean(message)));
  }
  notice(message) {
    this.print(color.orange("  ◆ " + clean(message)));
  }
  ask(label, { secret = false, signal } = {}) {
    this.clearProgress();
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.queue.length && !secret)
      return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiter = null;
        this.muted = false;
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiter = {
        secret,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
      };
      if (this.stdout.isTTY) {
        this.rl.setPrompt(label);
        this.rl.prompt();
      } else this.stdout.write(label);
      this.muted = secret;
    });
  }
  async confirm(call, signal) {
    this.print(`\n${color.orange("  ◇ Autorizar " + clean(call.name))}`);
    const args = JSON.stringify(call.arguments, null, 2);
    this.print(
      clean(args.length > 1800 ? args.slice(0, 1800) + "\n[…]" : args),
    );
    const answer = await this.ask("  Executar? [s/N] ", { signal });
    return /^(s|sim|y|yes)$/i.test(answer?.trim() || "");
  }
  start(mode, purpose) {
    this.streams.set(purpose, { start: Date.now(), chars: "", mode });
    if (this.stdout.isTTY && !this.timer)
      this.timer = setInterval(() => this.drawProgress(), 150);
  }
  token(token, mode, purpose) {
    const stream = this.streams.get(purpose);
    if (stream) stream.chars += token;
  }
  drawProgress() {
    if (this.waiter || !this.streams.size) return;
    const labels = [...this.streams].map(([purpose, stream]) => {
      const seconds = Math.max(0.1, (Date.now() - stream.start) / 1000);
      const tokens = estimateTokens(stream.chars);
      return `${purpose} · ${stream.mode} · ~${count(tokens)} tokens · ~${(tokens / seconds).toFixed(1)} tok/s · ${seconds.toFixed(1)}s`;
    });
    const text = `  ${["◐", "◓", "◑", "◒"][Math.floor(Date.now() / 150) % 4]} ${labels.join(" | ")}`;
    this.stdout.write(
      "\r\x1b[2K" +
        color.muted(
          text.slice(0, Math.max(30, (this.stdout.columns || 100) - 2)),
        ),
    );
    this.progress = true;
  }
  clearProgress() {
    if (this.progress) {
      this.stdout.write("\r\x1b[2K");
      this.progress = false;
    }
  }
  stop(purpose) {
    this.clearProgress();
    this.streams.delete(purpose);
    if (!this.streams.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  answer(content, purpose = "agent") {
    if (!content.trim()) return;
    this.print(
      `\n${color.orange(purpose === "btw" ? "  ↳ btw" : "  ● MicroCode")}\n${clean(content)}\n`,
    );
  }
  usage(usage) {
    this.print(
      color.muted(
        `  ${usage.purpose} · ${usage.estimatedTokens ? "~" : ""}${count(usage.input)} in / ${count(usage.output)} out · ${usage.tps.toFixed(1)} tok/s · ${usage.estimatedCost ? "~" : ""}${money(usage.cost)} · ${usage.seconds.toFixed(1)}s`,
      ),
    );
  }
  tool(call) {
    const args = call.arguments || {};
    this.print(
      `  ${color.green("› " + clean(call.name))} ${color.muted(clean(args.path || args.command || args.query || "").slice(0, 150))}`,
    );
  }
  toolResult(call, output) {
    if (!output.ok)
      this.print(
        color.red(
          `    ${clean(output.error || output.stderr || (output.timedOut ? "timeout" : output.aborted ? "cancelado" : "exit " + output.exitCode)).slice(0, 800)}`,
        ),
      );
    else if (call.name === "shell")
      this.print(
        color.muted(
          clean(output.stdout).slice(0, 1600) || `    exit ${output.exitCode}`,
        ),
      );
    else
      this.print(
        color.muted(
          `    ${output.bytes != null ? output.bytes + " bytes" : output.matches ? output.matches.length + " resultados" : output.entries ? output.entries.length + " entradas" : output.totalLines + " linhas"}`,
        ),
      );
  }
  status(session, model, mode, stats) {
    const total = totals(session.usage);
    this.print(
      color.muted(
        "  " + "─".repeat(Math.min(84, (this.stdout.columns || 100) - 4)),
      ),
    );
    this.print(
      `  ${color.green(session.plan ? "PLAN" : "BUILD")} · ${clean(model?.id || "selecione um modelo")} · tools ${mode || "auto"}`,
    );
    this.print(
      color.muted(
        `  sessão ${session.id.slice(0, 8)} · ${total.estimatedTokens ? "~" : ""}${count(total.input)} in / ${count(total.output)} out · ${total.seconds ? (total.output / total.seconds).toFixed(1) : "0.0"} tok/s · ${total.estimatedCost ? "~" : ""}${money(total.cost)}${total.unknownCost ? " + custo n/d" : ""}${stats ? ` · contexto ~${count(stats.tokens)}/${count(stats.limit)}${stats.ratio == null ? "" : " (" + (stats.ratio * 100).toFixed(0) + "% útil)"}` : ""}\n`,
      ),
    );
  }
  close() {
    clearInterval(this.timer);
    this.clearProgress();
    this.rl.close();
  }
}

export const COMMANDS = [
  "/help",
  "/connect",
  "/login",
  "/logout",
  "/provider",
  "/models",
  "/model",
  "/tools",
  "/status",
  "/cost",
  "/context",
  "/config",
  "/permissions",
  "/plan",
  "/compact",
  "/btw",
  "/clear",
  "/resume",
  "/rename",
  "/export",
  "/rewind",
  "/undo",
  "/init",
  "/memory",
  "/add-dir",
  "/diff",
  "/doctor",
  "/paste",
  "/exit",
  "/quit",
];
