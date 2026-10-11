import readline from "node:readline";
import { Writable } from "node:stream";
import { estimateTokens, totals } from "./metrics.js";
import { interactivePicker, fitLine } from "./picker.js";
import { captureKeys, printable } from "./terminal-input.js";
import { approvalMenu, toolPreview } from "./approval.js";
import { chatInputPanel, interactiveChatInput } from "./chat-input.js";
import { COMMAND_DEFINITIONS } from "./commands.js";
import { renderMarkdown } from "./markdown.js";
import { conversationMessages, isContextSummary } from "./history.js";
import { parseTextTools } from "./text-tools.js";
import { TerminalFooter } from "./terminal-footer.js";
import { styledRows, displayWidth } from "./terminal-layout.js";
import { VERSION } from "./version.js";

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

export function renderUserMessage(
  content,
  { width = 100, color: colored = false } = {},
) {
  const max = Math.max(1, Math.floor(width) - 1);
  const prefix = max >= 6 ? "  ❯ " : max >= 3 ? "❯ " : "";
  const indent = " ".repeat(displayWidth(prefix));
  const rows = styledRows(
    clean(content),
    Math.max(1, max - displayWidth(prefix)),
  );
  const lines = rows.map((row, i) => {
    const lead = i ? indent : prefix;
    const line = lead + row;
    if (!colored) return line;
    const marker =
      i || !prefix ? lead : lead.replace("❯", "\x1b[38;5;215m❯\x1b[38;5;255m");
    return (
      "\x1b[48;5;236;38;5;255;1m" +
      marker +
      row +
      " ".repeat(Math.max(0, max - displayWidth(line))) +
      "\x1b[0m"
    );
  });
  return "\n" + lines.join("\n") + "\n";
}

export class UI {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.transcriptRecords = [];
    this.chatInputVisible = false;
    this.chatLabel = "  ❯ ";
    this.footer = new TerminalFooter({
      input,
      output,
      getLines: (width, height) => this.footerLines(width, height),
      getTranscript: (width, rows) => this.viewportTranscript(width, rows),
      getInput: (columns, rows) => this.backgroundInput(columns, rows),
    });
    this.stdout = this.footer.view;
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    this.muted = false;
    this.streams = new Map();
    this.progress = false;
    this.deferredOutput = [];
    this.chatHistory = [];
    this.output = new Writable({
      write: (chunk, encoding, done) => {
        if (!this.muted) {
          if (this.footer.inputFrame) this.footer.redraw();
          else this.stdout.write(chunk, encoding);
        }
        done();
      },
    });
    Object.defineProperties(this.output, {
      columns: { get: () => this.stdout.columns },
      rows: { get: () => this.stdout.rows },
    });
    this.output.isTTY = Boolean(this.stdout.isTTY);
    this.stdout.on("resize", () => {
      if (!this.rawInputActive) this.output.emit("resize");
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
      if (this.rawInputActive) return;
      if (this.waiter) {
        const { resolve, secret, label, commands } = this.waiter;
        this.waiter = null;
        this.muted = false;
        if (secret) {
          this.rl.history = (this.rl.history || []).filter((h) => h !== line);
          output.write("\n");
        } else this.recordInput(label || "", line, { conversation: commands });
        resolve(line);
      } else if (this.onBackgroundLine && line.startsWith("/btw ")) {
        this.recordInput("  ❯ ", line);
        if (this.footer.inputFrame)
          this.stdout.write(this.submittedInput("  ❯ ", line) + "\n");
        this.onBackgroundLine(line);
      } else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.cancelInput?.();
      this.muted = false;
      if (this.waiter) {
        this.waiter.resolve(null);
        this.waiter = null;
      }
      this.footer.close();
    });
    this.rl.on("SIGINT", () => {
      if (this.onInterrupt) this.onInterrupt();
      else this.close();
    });
  }
  banner(cwd) {
    this.print(this.bannerText(cwd, this.stdout.columns || 100), {
      render: (width) => this.bannerText(cwd, width),
    });
  }
  bannerText(cwd, columns) {
    const width = Math.max(1, Math.min(86, columns - 1));
    const version = `v${VERSION}`;
    const gap = Math.max(2, width - "  </>  MicroCode".length - version.length);
    return `\n  ${color.green("</>")}  ${color.bold("Micro")}${color.orange(color.bold("Code"))}${" ".repeat(gap)}${color.muted(version)}\n${color.muted("  Agente de código para o terminal")}\n\n  ${color.muted("Projeto")}  ${clean(cwd)}\n\n  ${color.orange("/connect")} conectar   ${color.orange("/models")} modelos   ${color.orange("/")} comandos\n`;
  }
  recordTranscript(message, render) {
    this.transcriptRecords.push({ message, render, width: null, rows: null });
  }
  clearConversation(cwd, session) {
    this.clearProgress();
    this.transcriptRecords = [];
    this.deferredOutput = [];
    this.chatHistory = [];
    this.rl.history = [];
    const selected = session.selected?.model;
    this.statusState = {
      session,
      model:
        this.statusState?.model?.id === selected
          ? this.statusState.model
          : selected
            ? { id: selected }
            : null,
      mode: this.statusState?.mode || "auto",
      stats: null,
    };
    if (this.stdout.isTTY) {
      this.recordTranscript(
        this.bannerText(cwd, this.stdout.columns || 100),
        (width) => this.bannerText(cwd, width),
      );
      this.footer.clear();
    } else {
      this.banner(cwd);
      this.notice("Nova sessão. A anterior pode ser retomada com /resume.");
    }
  }
  submittedInput(label, content, width = this.stdout.columns || 100) {
    if (content.trim() && !content.startsWith("/") && !content.startsWith("!"))
      return renderUserMessage(content, {
        width,
        color: Boolean(this.stdout.isTTY && !process.env.NO_COLOR),
      });
    return `${color.orange(clean(label))}${clean(content).replaceAll("\n", "↵").replaceAll("\t", "⇥")}`;
  }
  userMessage(content) {
    const render = (width) =>
      renderUserMessage(content, {
        width,
        color: Boolean(this.stdout.isTTY && !process.env.NO_COLOR),
      });
    this.print(render(this.stdout.columns || 100), { render });
  }
  recordInput(
    label,
    content,
    { conversation = clean(label).includes("❯") } = {},
  ) {
    if (!content) return;
    if (
      conversation &&
      content.trim() &&
      !content.startsWith("/") &&
      !content.startsWith("!")
    ) {
      const render = (width) => this.submittedInput(label, content, width);
      this.recordTranscript(render(this.stdout.columns || 100), render);
    } else this.recordTranscript(`${clean(label)}${clean(content)}`);
  }
  viewportTranscript(width, rows) {
    if (!rows) return [];
    const result = [];
    for (
      let i = this.transcriptRecords.length - 1;
      i >= 0 && result.length < rows;
      i--
    ) {
      const record = this.transcriptRecords[i];
      if (record.width !== width) {
        record.rows = styledRows(
          record.render ? record.render(width) : record.message,
          Math.max(1, width - 1),
        );
        record.width = width;
      }
      result.unshift(...record.rows.slice(-rows));
    }
    return result.slice(-rows);
  }
  print(message = "", { render } = {}) {
    if (this.rawInputActive) {
      this.deferredOutput.push({ message, render });
      return;
    }
    this.recordTranscript(message, render);
    this.clearProgress();
    this.stdout.write(message + "\n");
  }
  error(message) {
    this.print(color.red("  × " + clean(message)));
  }
  notice(message) {
    this.print(color.orange("  ◆ " + clean(message)));
  }
  flushOutput() {
    if (!this.rawInputActive)
      for (const record of this.deferredOutput.splice(0))
        this.print(record.message, { render: record.render });
  }
  backgroundInput(columns, rows) {
    if (!this.chatInputVisible || this.rawInputActive || this.closed)
      return null;
    const line = clean(this.rl.line || "");
    return chatInputPanel({
      characters: [...line],
      cursor: [...clean((this.rl.line || "").slice(0, this.rl.cursor))].length,
      label: this.chatLabel,
      columns,
      rows: Math.max(1, rows - 1),
      theme: color,
    });
  }
  inputDraft() {
    return this.footer.inputFrame
      ? { line: this.rl.line, cursor: this.rl.cursor }
      : null;
  }
  restoreChatInput(draft) {
    if (draft) {
      this.rl.line = draft.line;
      this.rl.cursor = draft.cursor;
    }
    if (!this.closed) this.footer.restoreInput();
  }
  ask(label, { secret = false, signal, commands = false } = {}) {
    this.clearProgress();
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (secret && this.input.isTTY && this.stdout.isTTY && !this.closed)
      return this.secret(label, signal);
    if (this.queue.length) {
      const value = this.queue.shift();
      if (commands && this.stdout.isTTY) {
        this.recordInput(label, value, { conversation: true });
        this.stdout.write(this.submittedInput(label, value) + "\n");
        this.chatLabel = clean(label);
        this.chatInputVisible = true;
        this.restoreChatInput();
      }
      return Promise.resolve(value);
    }
    if (this.closed) return Promise.resolve(null);
    if (commands && this.input.isTTY && this.stdout.isTTY)
      return this.chatPrompt(label, signal);
    return new Promise((resolve, reject) => {
      const draft = this.inputDraft();
      if (draft) {
        this.rl.line = "";
        this.rl.cursor = 0;
      }
      const detach = this.stdout.attachOverlay?.({
        kind: "readline",
        getHeight: () => 1,
      });
      const abort = () => {
        detach?.();
        this.waiter = null;
        this.muted = false;
        this.restoreChatInput(draft);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiter = {
        secret,
        label,
        commands,
        resolve: (value) => {
          detach?.();
          signal?.removeEventListener("abort", abort);
          this.restoreChatInput(draft);
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
  async chatPrompt(label, signal) {
    this.chatLabel = clean(label);
    this.rawInputActive = true;
    try {
      const value = await interactiveChatInput({
        input: this.input,
        output: this.stdout,
        rl: this.rl,
        label: clean(label),
        history: this.chatHistory,
        theme: color,
        formatSubmitted: (value) => this.submittedInput(label, value),
        initialText: this.rl.line || "",
        initialCursor: [...(this.rl.line || "").slice(0, this.rl.cursor)]
          .length,
        signal,
        registerCancel: (cancel) => {
          this.cancelInput = cancel;
        },
        onInterrupt: () => this.onInterrupt?.(),
      });
      if (value?.trim() && this.chatHistory[0] !== value) {
        this.chatHistory.unshift(value);
        this.chatHistory.length = Math.min(1000, this.chatHistory.length);
      }
      if (value != null)
        this.recordInput(clean(label), value, { conversation: true });
      this.chatInputVisible = true;
      return value;
    } finally {
      this.rawInputActive = false;
      this.restoreChatInput();
      this.flushOutput();
    }
  }
  async secret(label, signal) {
    const draft = this.inputDraft();
    const value = [];
    this.rawInputActive = true;
    const render = () => {
      const width = Math.max(1, (this.stdout.columns || 100) - 1);
      const text = fitLine(
        label +
          "*".repeat(Math.min(value.length, 16)) +
          (value.length ? ` [${value.length} caracteres]` : ""),
        width,
      );
      this.stdout.write(
        (this.stdout.managedViewport ? `\x1b[${this.stdout.rows};1H` : "\r") +
          "\x1b[2K" +
          text,
      );
    };
    const detach = this.stdout.attachOverlay?.({
      kind: "secret",
      getHeight: () => 1,
    });
    this.stdout.on("resize", render);
    try {
      return await captureKeys({
        input: this.input,
        rl: this.rl,
        signal,
        registerCancel: (cancel) => {
          this.cancelInput = cancel;
        },
        render,
        onKey: (text, key) => {
          if (key.name === "return" || key.name === "enter")
            return { done: true, value: value.join("") };
          if (key.name === "escape" || (key.name === "c" && key.ctrl))
            return { done: true, value: null };
          if (key.name === "backspace") value.pop();
          else if (key.name === "u" && key.ctrl) value.length = 0;
          else
            value.push(
              ...[...printable(text, key)].slice(
                0,
                Math.max(0, 4096 - value.length),
              ),
            );
          return null;
        },
      });
    } finally {
      detach?.();
      this.stdout.removeListener("resize", render);
      this.stdout.write("\n");
      this.rawInputActive = false;
      this.restoreChatInput(draft);
      this.flushOutput();
    }
  }
  async select({
    title,
    hint = "",
    items,
    initialQuery = "",
    selectedValue,
    signal,
    allowDelete = false,
  }) {
    this.clearProgress();
    if (this.closed && !this.queue.length) return null;
    if (this.input.isTTY && this.stdout.isTTY) {
      const draft = this.inputDraft();
      this.rawInputActive = true;
      try {
        return await interactivePicker({
          input: this.input,
          output: this.stdout,
          rl: this.rl,
          title,
          hint,
          items,
          initialQuery,
          selectedValue,
          theme: color,
          signal,
          allowDelete,
          registerCancel: (cancel) => {
            this.cancelInput = cancel;
          },
          onInterrupt: () => this.onInterrupt?.(),
        });
      } finally {
        this.rawInputActive = false;
        this.restoreChatInput(draft);
        this.flushOutput();
      }
    }
    // Line-oriented input remains usable for pipes and non-TTY automation.
    let filter = initialQuery;
    while (true) {
      const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = items.filter((item) =>
        terms.every((term) =>
          (item.search || item.label).toLowerCase().includes(term),
        ),
      );
      this.print(`\n  ${title} · ${matches.length} resultados`);
      for (const item of matches.slice(0, 20))
        this.print("  " + clean(item.label) + " [" + clean(item.value) + "]");
      const answer = (
        await this.ask("  ID exato ou busca (Enter cancela): ", { signal })
      )?.trim();
      if (!answer) return null;
      const selected = items.find((item) => item.value === answer);
      if (selected) return selected.value;
      filter = answer;
    }
  }
  async approve({ title, preview = [], items, selectedValue, signal }) {
    this.clearProgress();
    if (this.closed && !this.queue.length) return "deny";
    if (this.input.isTTY && this.stdout.isTTY) {
      const draft = this.inputDraft();
      this.rawInputActive = true;
      try {
        return await approvalMenu({
          input: this.input,
          output: this.stdout,
          rl: this.rl,
          title,
          preview,
          items,
          selectedValue,
          theme: color,
          signal,
          registerCancel: (cancel) => {
            this.cancelInput = cancel;
          },
          onInterrupt: () => this.onInterrupt?.(),
          onSummary: (summary) =>
            this.recordTranscript(`  ◇ ${summary.title}\n  ${summary.label}`),
        });
      } finally {
        this.rawInputActive = false;
        this.restoreChatInput(draft);
        this.flushOutput();
      }
    }
    this.print("\n  " + title);
    for (const row of preview.slice(0, 12))
      this.print("  " + clean(typeof row === "string" ? row : row.text));
    items.forEach((item, i) =>
      this.print(`  ${i + 1}. ${item.label} [${item.value}]`),
    );
    while (true) {
      const answer = (
        await this.ask(`  Escolha 1–${items.length} (Enter cancela): `, {
          signal,
        })
      )?.trim();
      if (!answer) return "deny";
      const item =
        items[Number(answer) - 1] ||
        items.find((item) => item.value === answer);
      if (item) return item.value;
      this.error("Escolha uma das opções numeradas.");
    }
  }
  async confirm(call, signal, context = {}) {
    const shell = call.name === "shell";
    return await this.approve({
      title: shell ? "APROVAR COMANDO" : "APROVAR EDIÇÃO",
      preview: toolPreview(call, context),
      signal,
      items: [
        {
          value: "once",
          label: "Permitir uma vez",
          description: "Executar somente esta ação.",
        },
        {
          value: "session",
          label: shell
            ? "Permitir este comando nesta sessão"
            : "Permitir edições nesta sessão",
          description: shell
            ? "Somente o comando exato neste mesmo diretório."
            : "Libera write_file/edit_file; diretórios externos continuam pedindo aprovação.",
        },
        {
          value: "deny",
          label: "Negar",
          description: "O agente receberá a negativa e não deve contorná-la.",
        },
      ],
    });
  }
  async confirmAction({ title, preview, acceptLabel, signal }) {
    return (
      (await this.approve({
        title,
        preview,
        signal,
        selectedValue: "deny",
        items: [
          { value: "accept", label: acceptLabel },
          { value: "deny", label: "Cancelar" },
        ],
      })) === "accept"
    );
  }
  async confirmDirectory(request, signal) {
    return await this.approve({
      title: "PERMISSÃO DE DIRETÓRIO",
      preview: [
        request.directory,
        "Alvo: " + request.path,
        "Ferramenta: " + request.tool,
      ],
      signal,
      items: [
        {
          value: "once",
          label: "Permitir apenas esta operação",
          description:
            "O próximo acesso externo solicitará aprovação novamente.",
        },
        {
          value: "session",
          label: "Permitir durante esta sessão",
          description:
            "Autoriza o diretório e subdiretórios; permanece ao retomar a sessão.",
        },
        {
          value: "deny",
          label: "Negar acesso",
          description: "A ferramenta não acessará este diretório.",
        },
      ],
    });
  }
  start(mode, purpose) {
    this.streams.set(purpose, { start: Date.now(), chars: "", mode });
    this.footer.redraw();
    if (this.stdout.isTTY && !this.timer)
      this.timer = setInterval(() => this.drawProgress(), 150);
  }
  token(token, mode, purpose) {
    const stream = this.streams.get(purpose);
    if (stream) stream.chars += token;
  }
  drawProgress() {
    if (this.footer.active) {
      this.footer.redraw();
      return;
    }
    if (this.waiter || this.rawInputActive || !this.streams.size) return;
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
    this.footer.redraw();
    if (!this.streams.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  answer(content, purpose = "agent", { phase = "final" } = {}) {
    if (!content.trim()) return;
    if (purpose === "agent" && phase === "progress") {
      const render = (width) => {
        const lines = renderMarkdown(content, {
          width: Math.max(8, width - 1),
          indent: 4,
          color: Boolean(this.stdout.isTTY && !process.env.NO_COLOR),
        }).split("\n");
        return `\n${color.muted("  ●")} ${lines[0].replace(/^ {4}/, "")}${lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""}`;
      };
      this.print(render(this.stdout.columns || 100), { render });
      return;
    }
    const render = (width) =>
      `\n${color.orange(purpose === "btw" ? "  ↳ btw" : "  ● MicroCode")}\n${renderMarkdown(
        content,
        {
          width: Math.max(20, width - 2),
          color: Boolean(this.stdout.isTTY && !process.env.NO_COLOR),
          indent: 2,
        },
      )}\n`;
    this.print(render(this.stdout.columns || 100), { render });
  }
  history(session) {
    this.print(`\n${color.muted("  ── HISTÓRICO DA SESSÃO ──")}\n`);
    const calls = new Map();
    let shown = 0;
    const showResult = (message) => {
      let result;
      try {
        result = JSON.parse(message.content);
      } catch {
        result = null;
      }
      const call = calls.get(message.toolCallId);
      const name = message.name || call?.name || "ferramenta";
      if (!call) this.detail(`${clean(name)} (histórico)`, { prefix: "  › " });
      if (
        result &&
        typeof result === "object" &&
        (result.ok === false ||
          result.stdout != null ||
          result.results ||
          result.totalLines != null ||
          result.bytes != null ||
          result.matches ||
          result.entries ||
          (name === "web_fetch" && result.content))
      )
        this.toolResult({ name, arguments: call?.arguments || {} }, result);
      else
        this.detail(
          result?.ok === true
            ? "Concluído anteriormente."
            : "Resultado anterior disponível no contexto.",
        );
    };
    for (const message of conversationMessages(session)) {
      if (isContextSummary(message)) {
        this.print(
          color.muted("  ◆ Resumo preservado de mensagens anteriores"),
        );
        const content = message.content
          .slice("MICROCODE_CONTEXT_SUMMARY\n".length)
          .replace(
            /^This is a summary of earlier turns, not a new user request\. Continue using the recent messages below\.\n/,
            "",
          );
        this.print(
          renderMarkdown(content, {
            width: (this.stdout.columns || 100) - 2,
            color: Boolean(this.stdout.isTTY && !process.env.NO_COLOR),
            indent: 2,
          }),
        );
        shown++;
        continue;
      }
      if (message.role === "user" && message.internal) {
        if (message.content?.startsWith("MICROCODE_TOOL_RESULTS\n")) {
          try {
            const legacy = JSON.parse(
              message.content.slice("MICROCODE_TOOL_RESULTS\n".length),
            );
            showResult({
              name: legacy.name,
              toolCallId: legacy.id,
              content:
                typeof legacy.result === "string"
                  ? legacy.result
                  : JSON.stringify(legacy.result),
            });
          } catch {
            /* protocol repair messages are not user conversation */
          }
        }
        continue;
      }
      if (message.role === "user") {
        this.userMessage(message.content || "");
        shown++;
        continue;
      }
      if (message.role === "assistant") {
        const parsed = parseTextTools(message.content || "");
        const toolCalls = message.toolCalls || parsed.calls;
        if (parsed.display) {
          this.answer(parsed.display, "agent", {
            phase: toolCalls.length ? "progress" : "final",
          });
          shown++;
        }
        for (const call of toolCalls) {
          calls.set(call.id, call);
          this.tool(call, { historical: true });
        }
      } else if (message.role === "tool") showResult(message);
    }
    if (!shown)
      this.print(
        color.muted("  Esta sessão ainda não tem perguntas ou respostas."),
      );
  }
  usage(usage) {
    if (this.footer.active) {
      this.footer.redraw();
      return;
    }
    this.print(
      color.muted(
        `  ${usage.purpose} · ${usage.estimatedTokens ? "~" : ""}${count(usage.input)} in / ${count(usage.output)} out · ${usage.tps.toFixed(1)} tok/s · ${usage.estimatedCost ? "~" : ""}${money(usage.cost)} · ${usage.seconds.toFixed(1)}s${usage.retries ? " · " + usage.retries + " retentativas" : ""}`,
      ),
    );
  }
  detail(content, { prefix = "    └ ", paint: tone = color.muted } = {}) {
    const render = (width) => {
      const max = Math.max(1, width - 1);
      const first = fitLine(prefix, Math.max(0, max - 1));
      const indent = " ".repeat(displayWidth(first));
      return styledRows(clean(content), Math.max(1, max - displayWidth(first)))
        .map((row, i) => tone((i ? indent : first) + row))
        .join("\n");
    };
    this.print(render(this.stdout.columns || 100), { render });
  }
  tool(call, { historical = false } = {}) {
    const args = call.arguments || {};
    this.detail(
      `${clean(call.name)} ${clean(args.path || args.command || args.query || args.url || "").slice(0, 150)}${historical ? " (histórico)" : ""}`,
      { prefix: "  › " },
    );
  }
  toolResult(call, output) {
    if (!output.ok)
      this.detail(
        clean(
          output.error ||
            output.stderr ||
            (output.timedOut
              ? "timeout"
              : output.aborted
                ? "cancelado"
                : "exit " + output.exitCode),
        ).slice(0, 800),
        { paint: color.red },
      );
    else if (call.name === "shell")
      this.detail(
        clean(output.stdout).slice(0, 1600).trimEnd() ||
          `exit ${output.exitCode}`,
      );
    else if (call.name === "web_search")
      this.detail(
        `${output.results.length} resultados · ${output.provider}${output.fallback ? " · fallback" : ""}`,
      );
    else if (call.name === "web_fetch")
      this.detail(
        `${clean(output.title).slice(0, 120)} · ${output.content.length} caracteres${output.truncated ? " · truncado" : ""}`,
      );
    else
      this.detail(
        `${output.bytes != null ? output.bytes + " bytes" : output.matches ? output.matches.length + " resultados" : output.entries ? output.entries.length + " entradas" : output.totalLines + " linhas"}`,
      );
  }
  status(session, model, mode, stats) {
    this.statusState = { session, model, mode, stats };
    if (this.footer.start()) return;
    this.statusDetails(session, model, mode, stats);
  }
  statusDetails(session, model, mode, stats) {
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
    if (session.lastError)
      this.print(
        color.red(
          `  Última chamada falhou${session.lastError.status ? " (HTTP " + session.lastError.status + ")" : ""}${session.lastError.provider ? " / " + clean(session.lastError.provider) : ""}; nenhuma resposta concluída nessa chamada.\n`,
        ),
      );
  }
  footerLines(width, height = 2) {
    const state = this.statusState;
    if (!state) return [];
    const { session, model, stats } = state;
    const total = totals(session.usage);
    const max = Math.max(1, width - 2);
    const modelLabel = clean(
      model?.name || model?.id?.split("/").at(-1) || "selecione um modelo",
    );
    const speed = total.seconds
      ? (total.output / total.seconds).toFixed(1)
      : "0.0";
    const context =
      stats?.ratio == null
        ? "ctx n/d"
        : `ctx ${(stats.ratio * 100).toFixed(0)}%`;
    const cost = `${total.estimatedCost ? "~" : ""}${total.cost === 0 ? "$0.00" : money(total.cost)}${total.unknownCost ? " +n/d" : ""}`;
    let metrics = `${total.estimatedTokens ? "~" : ""}${count(total.input)} in/${count(total.output)} out · ${speed} tok/s · ${cost}`;
    let activity = "";
    const stream = [...this.streams.entries()].at(-1);
    if (stream) {
      const [purpose, progress] = stream;
      const elapsed = Math.max(0.1, (Date.now() - progress.start) / 1000);
      const generated = estimateTokens(progress.chars);
      activity = `${purpose === "agent" ? "gerando" : purpose} ~${count(generated)} tk · ~${(generated / elapsed).toFixed(1)} tk/s`;
    } else if (session.lastError)
      activity = `falha${session.lastError.status ? " HTTP " + session.lastError.status : ""}`;
    const modeLine = `  ${session.plan ? "PLAN" : "BUILD"} · ${modelLabel} · ${context}`;
    const statusPaint = session.lastError && !stream ? color.red : color.muted;
    if (height === 1)
      return [
        statusPaint(
          fitLine(
            `${modeLine} · ${activity || metrics}${width >= 160 ? " · s:" + session.id.slice(0, 8) : ""}`,
            max,
          ),
        ),
      ];
    if (width >= 80) metrics += ` · s:${session.id.slice(0, 8)}`;
    return [
      color.green(fitLine(modeLine, max)),
      statusPaint(fitLine(`  ${activity || metrics}`, max)),
    ];
  }
  updateContext(stats, mode) {
    if (this.statusState) {
      this.statusState.stats = stats;
      this.statusState.mode = mode;
    }
    this.footer.redraw();
  }
  bindSession(session) {
    if (!this.statusState) return;
    const model = session.selected?.model
      ? { id: session.selected.model }
      : null;
    this.statusState = {
      session,
      model,
      mode: session.historyMode || "auto",
      stats: null,
    };
    this.footer.redraw();
  }
  close() {
    this.cancelInput?.();
    clearInterval(this.timer);
    this.clearProgress();
    this.rl.close();
    this.footer.close();
  }
}

export const COMMANDS = COMMAND_DEFINITIONS.map((command) => command.name);
