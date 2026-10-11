import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { VERSION } from "./version.js";
import { Store, PRESETS, newSession } from "./store.js";
import { configuredProviders, catalog, chooseMode } from "./providers.js";
import { ToolRunner, rewindFiles, allowedPath } from "./tools.js";
import { Agent } from "./agent.js";
import { UI, color, modelLine, count, money, clean, price } from "./ui.js";
import { attachFiles, contextStats, transcript } from "./context.js";
import { textToolPrompt, flattenHistory } from "./text-tools.js";
import { totals } from "./metrics.js";
import {
  conversationMessages,
  historyQuestions,
  sessionOption,
} from "./history.js";
import { normalizeApiKey, validateCredential } from "./credentials.js";
import { checkedShell, diagnose } from "./diagnostics.js";
import { inspectProject, updateInstructions } from "./project.js";
import {
  MEMORY_FILE,
  readMemory,
  editMemory,
  memoryInstructions,
} from "./memory.js";
import {
  createCheckpoint,
  recordChange,
  checkpointChanges,
} from "./checkpoints.js";

export const HELP = `MicroCode — agente de código para o terminal

  microcode                         Chat interativo no diretório atual
  microcode -p "implemente..."       Executar um único pedido
  microcode --cwd CAMINHO            Escolher o projeto
  microcode --provider openrouter    Selecionar provider
  microcode --model ID               Selecionar modelo (ID completo)
  microcode --tools auto|native|text  Definir protocolo de ferramentas
  microcode --resume [ID]            Retomar sessão (última se sem ID)
  microcode --auto-approve           Autorizar ferramentas de edição/shell
  microcode --version                Versão

CONEXÕES E MODELOS
  /connect [provider]     Adicionar provider e API key (entrada oculta)
  /login [provider]       Alias de /connect
  /logout [provider]      Remover a chave salva
  /provider              Listar/escolher provider
  /provider add|remove ID Adicionar ou remover provider
  /models [filtro]        Lista interativa: busca ao digitar, ↑↓ e Enter
  /models --refresh      Atualizar catálogo (cache padrão: 1 hora)
  /model [ID]            Selecionar modelo pelo ID ou abrir seletor
  /tools auto|native|text Escolher ferramentas nativas ou via texto

SESSÃO E CONTEXTO
  /status                Provider, modelo, tokens, tok/s, custo, sessão
  /cost                  Custos e tokens acumulados, inclusive /btw e resumos
  /context               Janela de contexto, reserva de saída e compactação
  /compact [instruções]  Resumir histórico antigo, preservando turnos recentes
  /btw PERGUNTA          Pergunta lateral, sem alterar a conversa principal
  /clear                 Iniciar nova sessão
  /resume [ID]           Selecionar com setas/busca e retomar com histórico
  /rename NOME           Renomear sessão
  /export [arquivo.md]   Exportar conversa para Markdown
  /rewind [N|ID|list]     Escolher turnos e restaurar arquivos capturados
  /undo [N|ID|list]       Alias de /rewind; N reverte os últimos N checkpoints

PROJETO E PREFERÊNCIAS
  /init                  Inspecionar localmente e criar/atualizar AGENTS.md
  /memory [TEXTO]        Listar instruções/notas ou adicionar memória do projeto
  /memory add TEXTO      Adicionar nota persistente
  /memory edit ID TEXTO  Editar nota; /memory remove ID remove uma nota
  /memory search TEXTO   Buscar notas; /memory clear remove todas com confirmação
  /plan [on|off]         Alternar planejamento somente leitura
  /permissions ask|auto  Confirmação de edição e comandos shell
  /permissions reset     Revogar autorizações da sessão e voltar a perguntar
  /config [chave valor]  Mostrar/alterar configuração, inclusive compaction.*
                         Retentativas: retry.maxRetries, retry.baseDelayMs, retry.maxDelayMs
  /add-dir CAMINHO       Incluir diretório nas ferramentas de arquivos
  /diff                  Mostrar git diff do projeto
  /doctor                Verificar Node, pnpm, shell, Git, memória e providers
  /paste                 Entrada multilinha (finalize com .end)
  @arquivo @"com espaços" Anexar arquivos ao pedido
  !comando               Executar comando shell diretamente
  /help                  Esta ajuda (digite / para o menu; Tab completa)
  /exit ou Ctrl+C        Sair; Ctrl+C durante execução cancela o turno
`;

export function parseArgs(args) {
  const options = {};
  const values = {
    "--cwd": "cwd",
    "--provider": "provider",
    "--model": "model",
    "--tools": "tools",
    "-p": "prompt",
    "--print": "prompt",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values[arg]) {
      if (args[i + 1] == null || args[i + 1].startsWith("--"))
        throw new Error(`Falta valor para ${arg}`);
      options[values[arg]] = args[++i];
    } else if (arg === "--resume" || arg === "-r")
      options.resume =
        args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : true;
    else if (arg === "--auto-approve") options.auto = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else throw new Error(`Opção desconhecida: ${arg}. Consulte --help.`);
  }
  return options;
}

export class Application {
  constructor({ cwd, store, ui, config, session }) {
    Object.assign(this, { cwd, store, ui, config, session });
    this.background = Promise.resolve();
  }
  providers() {
    return configuredProviders(this.config);
  }
  async saveConfig() {
    await this.store.write("config.json", this.config);
  }
  async saveSession() {
    await this.store.saveSession(this.session);
  }
  async selectProvider(id) {
    if (!id) {
      const entries = Object.entries(this.providers());
      if (!entries.length) return this.connect();
      id = await this.ui.select({
        title: "PROVIDERS",
        hint: "Digite para filtrar · Enter para escolher",
        selectedValue: this.config.selected?.provider,
        items: entries.map(([key, p]) => ({
          value: key,
          label: `${p.name} (${key})`,
          search: `${p.name} ${key}`,
          details: [p.baseURL],
        })),
      });
      if (!id) return;
    }
    if (!this.providers()[id])
      throw new Error(`Provider não conectado: ${id}. Use /connect ${id}.`);
    if (this.config.selected?.provider !== id)
      this.config.selected = { provider: id, model: null };
    this.session.selected = this.config.selected;
    this.model = null;
    await this.saveConfig();
    await this.saveSession();
    this.ui.notice(`Provider: ${this.providers()[id].name}. Use /models.`);
  }
  async connect(id) {
    if (!id) {
      id = await this.ui.select({
        title: "CONECTAR PROVIDER",
        hint: "Digite para filtrar · ↑↓ para navegar",
        items: [
          ...Object.entries(PRESETS).map(([key, p]) => ({
            value: key,
            label: p.name,
            search: `${key} ${p.name}`,
            details: [p.baseURL],
          })),
          {
            value: "custom",
            label: "Provider personalizado (OpenAI-compatible)",
            search: "custom local personalizado",
            details: ["Informe sua própria base URL."],
          },
        ],
      });
      if (!id) return;
    }
    let provider = PRESETS[id]
      ? { ...PRESETS[id], ...this.config.providers[id] }
      : this.config.providers[id];
    if (!provider) {
      if (id === "custom")
        id = (await this.ui.ask("  ID do provider: "))?.trim();
      if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id))
        throw new Error("ID inválido: use letras minúsculas, números, _ ou -.");
      const url = (
        await this.ui.ask("  Base URL (ex.: http://localhost:1234/v1): ")
      )?.trim();
      if (!url) return;
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("Base URL inválida.");
      provider = {
        name: id,
        baseURL: url.replace(/\/$/, ""),
        env: `${id.toUpperCase().replaceAll("-", "_")}_API_KEY`,
        catalog: "custom",
      };
      const authPath = (
        await this.ui.ask(
          "  Endpoint GET protegido para validar chave (Enter usa /models): ",
        )
      )?.trim();
      if (authPath) {
        if (
          !authPath.startsWith("/") ||
          authPath.startsWith("//") ||
          /[?#\\]/.test(authPath)
        )
          throw new Error(
            "Informe um caminho relativo à base URL, como /auth/status.",
          );
        provider.authPath = authPath;
      }
    }
    const key = await this.ui.ask(
      `  API key ${provider.name} (Enter usa ${provider.env}${id === "opencode" ? " ou modelos públicos" : ""}): `,
      { secret: true },
    );
    if (key === null) return;
    if (key.trim()) {
      const normalized = normalizeApiKey(key);
      this.ui.notice("Validando credencial…");
      const checked = await validateCredential(provider, normalized);
      await this.store.setKey(id, checked.key);
      provider.keySource = "saved";
      if (normalized !== key.trim())
        this.ui.notice(
          "Colagem normalizada: removidos prefixo, aspas ou repetição idêntica da chave.",
        );
      if (checked.verified)
        this.ui.notice(
          `${provider.name}: credencial autenticada, sem geração de tokens.`,
        );
      if (checked.note) this.ui.notice(checked.note);
    } else {
      const preferEnvironment = Boolean(process.env[provider.env]);
      const credential = await this.store.credential(id, {
        ...provider,
        ...(preferEnvironment ? { keySource: "environment" } : {}),
      });
      if (credential.key) {
        const checked = await validateCredential(provider, credential.key);
        this.ui.notice(
          `${provider.name}: ${checked.verified ? "credencial autenticada" : "conexão verificada; autenticação não comprovada"}.`,
        );
        if (checked.note) this.ui.notice(checked.note);
        provider.keySource =
          credential.source === "environment" ? "environment" : "saved";
        if (credential.source === "saved" && credential.normalized)
          await this.store.setKey(id, checked.key);
      } else if (
        provider.catalog !== "opencode" &&
        provider.catalog !== "custom"
      )
        throw new Error(`Informe uma API key ou defina ${provider.env}.`);
    }
    this.config.providers[id] = { ...provider };
    await this.selectProvider(id);
  }
  async loadModel(id, refresh = false) {
    const selection = this.config.selected;
    if (!selection?.provider)
      throw new Error("Use /connect e /models primeiro.");
    const provider = this.providers()[selection.provider];
    if (!provider) throw new Error("Provider removido; use /connect.");
    const result = await catalog(selection.provider, provider, this.store, {
      refresh,
    });
    if (result.stale)
      this.ui.notice(
        `Catálogo em cache de ${new Date(result.fetchedAt).toLocaleString()}: ${result.warning}`,
      );
    if (!id) return result.models;
    const model = result.models.find((m) => m.id === id);
    if (!model)
      throw new Error(`Modelo não encontrado: ${id}. Use /models --refresh.`);
    if (model.protocolKnown === false)
      throw new Error(
        "Metadados do protocolo OpenCode indisponíveis. Atualize /models --refresh antes de selecionar este modelo.",
      );
    return model;
  }
  async setModel(id) {
    const model = await this.loadModel(id);
    chooseMode(this.config.toolMode, model);
    const previous = this.config.selected.model;
    this.config.selected.model = id;
    this.session.selected = { ...this.config.selected };
    this.model = model;
    // Provider-specific reasoning signatures must not cross model boundaries.
    if (previous !== id)
      this.session.messages = flattenHistory(this.session.messages);
    await this.saveConfig();
    await this.saveSession();
    this.ui.print("\n  " + modelLine(model));
    this.ui.notice(`Ferramentas: ${chooseMode(this.config.toolMode, model)}.`);
  }
  async models(filter = "") {
    if (!this.config.selected?.provider) {
      await this.selectProvider();
      if (!this.config.selected?.provider) return;
    }
    const refresh = filter === "--refresh";
    if (refresh) filter = "";
    const all = await this.loadModel(null, refresh);
    const selected = await this.ui.select({
      title: `MODELOS / ${this.config.selected.provider}`,
      hint: "Preços em USD por 1M tokens · n/d = indisponível",
      initialQuery: filter,
      selectedValue: this.config.selected.model,
      items: all.map((m) => ({
        value: m.id,
        label: `${m.name} · ${price(m.inputPrice)}/${price(m.outputPrice)} · ${m.nativeTools === true ? "tools nativas" : "tools por texto"}`,
        search: `${m.name} ${m.id}`,
        details: [
          m.id,
          `Entrada ${price(m.inputPrice)} · saída ${price(m.outputPrice)} / 1M tokens`,
          `Tools nativas: ${m.nativeTools === true ? "sim" : m.nativeTools === false ? "não — execução por texto" : "desconhecido — execução por texto"}`,
          `Contexto ${count(m.context)} · protocolo ${m.protocol}`,
        ],
      })),
    });
    if (selected) await this.setModel(selected);
  }
  runner() {
    this.session.toolApprovals ??= { edits: false, shell: [] };
    return new ToolRunner({
      cwd: this.cwd,
      addedDirs: this.session.addedDirs,
      permission: this.config.permission,
      plan: this.session.plan,
      confirm: (call, signal, context) =>
        this.ui.confirm(call, signal, context),
      approvals: this.session.toolApprovals,
      onApprovalGranted: async () => this.saveSession(),
      confirmDirectory: (request, signal) =>
        this.ui.confirmDirectory(request, signal),
      onDirectoryGranted: async ({ directory, scope }) => {
        if (scope === "session") {
          if (!this.session.addedDirs.includes(directory))
            this.session.addedDirs.push(directory);
          await this.saveSession();
        }
        this.ui.notice(
          `Acesso permitido ${scope === "session" ? "nesta sessão" : "nesta operação"}: ${directory}`,
        );
      },
      onTool: (call) => this.ui.tool(call),
    });
  }
  async restoreSession(id, { saveCurrent = true, replay = true } = {}) {
    const restored = await this.store.loadSession(id, this.cwd);
    if (saveCurrent && restored.id !== this.session.id)
      await this.saveSession();
    this.session = restored;
    this.config.selected = restored.selected || null;
    this.model = null;
    this.ui.chatHistory = historyQuestions(restored);
    this.ui.bindSession?.(restored);
    await this.saveConfig();
    if (replay) this.showResumedHistory();
    else this.historyPending = true;
    return restored;
  }
  showResumedHistory() {
    this.ui.notice(`Retomada: ${this.session.title}`);
    this.ui.history(this.session);
    this.historyPending = false;
  }
  async deleteStoredSession(id) {
    const target = await this.store.loadSession(id, this.cwd);
    const confirmed = await this.ui.confirmAction({
      title: "EXCLUIR SESSÃO",
      acceptLabel: "Excluir esta sessão",
      preview: [
        target.title || "Nova sessão",
        `ID: ${id}`,
        `Projeto: ${this.cwd}`,
        "Exclusão permanente da conversa, uso e checkpoints desta sessão.",
      ],
    });
    if (!confirmed) return false;
    await this.store.deleteSession(id, this.cwd);
    this.ui.notice(`Sessão excluída: ${target.title || id}`);
    return true;
  }
  async pickStoredSession() {
    let query = "";
    let selectedValue;
    while (true) {
      const sessions = (await this.store.sessions(this.cwd)).filter(
        (s) => s.id !== this.session.id,
      );
      if (!sessions.length) {
        this.ui.notice("Nenhuma outra sessão neste projeto.");
        return null;
      }
      const selection = await this.ui.select({
        title: "RETOMAR SESSÃO",
        hint: "Digite para filtrar · ↑↓ e Enter para escolher · Del para excluir",
        allowDelete: true,
        initialQuery: query,
        selectedValue,
        items: sessions.map(sessionOption),
      });
      if (!selection) return null;
      if (typeof selection === "object" && selection.action === "delete") {
        query = selection.query || "";
        const index = sessions.findIndex((s) => s.id === selection.value);
        const next = sessions[index + 1] || sessions[index - 1];
        const removed = await this.deleteStoredSession(selection.value);
        selectedValue = removed ? next?.id : selection.value;
        continue;
      }
      return selection;
    }
  }
  async agent() {
    const selection = this.config.selected;
    if (!selection?.model) throw new Error("Selecione um modelo com /models.");
    const provider = this.providers()[selection.provider];
    if (!provider) throw new Error("Conecte o provider com /connect.");
    if (this.model?.id !== selection.model)
      this.model = await this.loadModel(selection.model);
    let key = await this.store.key(selection.provider, provider);
    if (
      !key &&
      provider.catalog === "opencode" &&
      this.model.inputPrice === 0 &&
      this.model.outputPrice === 0
    )
      key = "public";
    if (!key && provider.catalog !== "custom")
      throw new Error(
        `API key ausente. Use /connect ${selection.provider} ou defina ${provider.env}.`,
      );
    return new Agent({
      provider,
      key,
      model: this.model,
      config: this.config,
      session: this.session,
      runner: this.runner(),
      store: this.store,
      ui: {
        start: (mode, purpose) => this.ui.start(mode, purpose),
        token: (token, mode, purpose) => this.ui.token(token, mode, purpose),
        stop: (purpose) => this.ui.stop(purpose),
        usage: (usage) => this.ui.usage(usage),
        notice: (text) => this.ui.notice(text),
        answer: (text, purpose, presentation) =>
          this.ui.answer(text, purpose, presentation),
        toolResult: (call, output) => this.ui.toolResult(call, output),
        context: (stats, mode) => this.ui.updateContext(stats, mode),
      },
    });
  }
  async activeStatus() {
    let mode = this.config.toolMode;
    let stats;
    if (this.config.selected?.model) {
      if (!this.model)
        this.model = await this.loadModel(this.config.selected.model);
      mode =
        this.config.toolMode === "auto" &&
        this.session.textFallback?.includes(this.model.id)
          ? "text"
          : chooseMode(this.config.toolMode, this.model);
      const agent = await this.agent();
      const definitions = agent.runner.definitions();
      const system =
        (await agent.baseSystem()) +
        (mode === "text" ? "\n" + textToolPrompt(definitions) : "");
      stats = contextStats(
        system,
        this.session.messages,
        definitions,
        this.model,
        this.config,
      );
    }
    this.ui.status(this.session, this.model, mode, stats);
    return stats;
  }
  async operate(fn) {
    this.controller = new AbortController();
    this.ui.onBackgroundLine = (line) => {
      this.background = this.background.then(async () => {
        try {
          const side = await this.agent();
          await side.btw(line.slice(5).trim(), this.controller?.signal);
        } catch (error) {
          this.ui.error(error.message);
        }
      });
    };
    try {
      return await fn(this.controller.signal);
    } finally {
      await this.background;
      this.controller = null;
      this.ui.onBackgroundLine = null;
    }
  }
  async prompt(input, signal) {
    const agent = await this.agent();
    await agent.run(await attachFiles(input, agent.runner), signal);
  }
  async configCommand(args) {
    if (!args) {
      this.ui.print(JSON.stringify(this.config, null, 2));
      return;
    }
    const [key, raw] = args.split(/\s+/, 2);
    const schemas = {
      maxSteps: { type: "number", min: 1, max: 200, integer: true },
      maxTokens: { type: "number", min: 256, max: 131072, integer: true },
      "retry.maxRetries": { type: "number", min: 0, max: 5, integer: true },
      "retry.baseDelayMs": {
        type: "number",
        min: 250,
        max: 30000,
        integer: true,
      },
      "retry.maxDelayMs": {
        type: "number",
        min: 1000,
        max: 120000,
        integer: true,
      },
      "compaction.auto": { type: "boolean" },
      "compaction.threshold": { type: "number", min: 0.1, max: 0.95 },
      "compaction.keepTurns": {
        type: "number",
        min: 1,
        max: 50,
        integer: true,
      },
      "compaction.summaryTokens": {
        type: "number",
        min: 256,
        max: 8192,
        integer: true,
      },
      "compaction.contextOverride": {
        type: "number",
        min: 4096,
        max: 10000000,
        integer: true,
        nullable: true,
      },
    };
    const schema = schemas[key];
    if (!schema)
      throw new Error(
        "Configuração inválida. Chaves: " + Object.keys(schemas).join(", "),
      );
    let value;
    if (raw === "null" && schema.nullable) value = null;
    else if (schema.type === "boolean" && ["true", "false"].includes(raw))
      value = raw === "true";
    else if (schema.type === "number" && raw != null && raw.trim() !== "")
      value = Number(raw);
    else throw new Error("Valor inválido.");
    if (
      value !== null &&
      schema.type === "number" &&
      (!Number.isFinite(value) ||
        value < schema.min ||
        value > schema.max ||
        (schema.integer && !Number.isInteger(value)))
    )
      throw new Error(`Use valor entre ${schema.min} e ${schema.max}.`);
    if (key.startsWith("compaction."))
      this.config.compaction[key.slice(11)] = value;
    else if (key.startsWith("retry.")) this.config.retry[key.slice(6)] = value;
    else this.config[key] = value;
    await this.saveConfig();
    this.ui.notice(`${key} = ${value}`);
  }
  async localOperation(title, action) {
    return this.operate(async (signal) => {
      const previous = this.session.checkpoints.slice();
      const checkpoint = createCheckpoint(this.session, title);
      const runner = this.runner();
      runner.onChange = async (change) => {
        recordChange(checkpoint, change);
        await this.saveSession();
      };
      runner.onShellTracked = async (coverage) => {
        checkpoint.shellUsed = true;
        (checkpoint.shellCoverage ??= []).push(coverage);
        await this.saveSession();
      };
      await this.saveSession();
      try {
        return await action(runner, signal, checkpoint);
      } finally {
        if (!checkpoint.changes.length && !checkpoint.shellUsed)
          this.session.checkpoints = previous;
        await this.saveSession();
      }
    });
  }
  async initProject() {
    await this.localOperation("/init", async (runner, signal) => {
      const report = await inspectProject(this.cwd);
      const file = await allowedPath(this.cwd, "AGENTS.md");
      const before = await readFile(file, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const content = updateInstructions(before, report);
      if (content === before) {
        this.ui.notice("AGENTS.md já está atualizado.");
        return;
      }
      const result = await runner.execute(
        { name: "write_file", arguments: { path: "AGENTS.md", content } },
        signal,
      );
      if (!result.ok) throw new Error(result.error);
      this.ui.notice(
        `AGENTS.md ${before ? "atualizado" : "criado"} por inspeção local · ${report.commands.length} comandos declarados identificados.`,
      );
    });
  }
  async memoryCommand(args) {
    const data = await readMemory(this.cwd);
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
    const word = match?.[1] || "list";
    const operations = [
      "list",
      "show",
      "search",
      "add",
      "edit",
      "remove",
      "clear",
      "help",
    ];
    const operation = operations.includes(word) ? word : "add";
    const value =
      operation === "add" && word !== "add" ? args : match?.[2] || "";
    if (operation === "help") {
      this.ui.print(
        "  /memory [list|search TEXTO|add TEXTO|edit ID TEXTO|remove ID|clear]\n  /memory TEXTO adiciona uma nota persistente neste projeto.",
      );
      return;
    }
    if (["list", "show", "search"].includes(operation)) {
      if (operation !== "search") {
        for (const name of ["AGENTS.md", "MICROCODE.md"]) {
          const file = await allowedPath(this.cwd, name);
          const text = await readFile(file, "utf8").catch((error) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          if (text) this.ui.print(`\n  ${name}\n${clean(text)}`);
        }
      }
      const normal = (text) =>
        text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const entries =
        operation === "search"
          ? data.entries.filter((e) => normal(e.text).includes(normal(value)))
          : data.entries;
      this.ui.print(
        entries.length
          ? clean(memoryInstructions({ entries }))
          : "  Nenhuma nota de memória encontrada. Use /memory add TEXTO.",
      );
      return;
    }
    const updated = editMemory(data, operation, value);
    if (JSON.stringify(updated) === JSON.stringify(data)) {
      this.ui.notice("Memória já contém esse conteúdo.");
      return;
    }
    if (
      operation === "clear" &&
      !(await this.ui.confirmAction({
        title: "LIMPAR MEMÓRIA DO PROJETO",
        preview: [`${data.entries.length} notas serão removidas.`, this.cwd],
        acceptLabel: "Remover todas as notas",
      }))
    )
      return;
    await this.localOperation(
      `/memory ${operation}`,
      async (runner, signal) => {
        const result = await runner.execute(
          {
            name: "write_file",
            arguments: {
              path: MEMORY_FILE,
              content: JSON.stringify(updated, null, 2) + "\n",
            },
          },
          signal,
        );
        if (!result.ok) throw new Error(result.error);
        this.ui.notice(
          `Memória atualizada · ${updated.entries.length} notas · carregadas nas próximas consultas.`,
        );
      },
    );
  }
  async rewindCommand(args) {
    const checkpoints = this.session.checkpoints;
    if (!checkpoints.length) {
      this.ui.notice("Nenhum checkpoint disponível.");
      return;
    }
    if (args === "list") {
      checkpoints
        .slice()
        .reverse()
        .forEach((c, i) =>
          this.ui.print(
            `  ${i + 1}. ${clean(c.title)} · ${c.id || "legado"} · ${c.changes.length} arquivos`,
          ),
        );
      return;
    }
    if (this.session.plan)
      throw new Error("Modo plan: edição e rewind desativados.");
    let index;
    if (/^[1-9]\d*$/.test(args)) index = checkpoints.length - Number(args);
    else if (args) {
      const matches = checkpoints
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.id?.startsWith(args));
      if (matches.length !== 1)
        throw new Error(
          "Informe um ID de checkpoint existente e sem ambiguidade.",
        );
      index = matches[0].i;
    } else {
      const selection = await this.ui.select({
        title: "REVERTER CONVERSA",
        hint: "Escolha o turno; ele e os seguintes serão revertidos · Esc cancela",
        selectedValue: String(checkpoints.length - 1),
        items: checkpoints
          .map((c, i) => ({
            value: String(i),
            label: c.title,
            search: `${c.title} ${c.id || ""}`,
            details: [
              `${checkpoints.length - i} turnos · ${c.changes.length} arquivos neste checkpoint`,
              c.createdAt || "Checkpoint legado",
            ],
          }))
          .reverse(),
      });
      if (selection == null) return;
      index = Number(selection);
    }
    if (!Number.isInteger(index) || index < 0 || index >= checkpoints.length)
      throw new Error("Quantidade de turnos inválida.");
    const selected = checkpoints.slice(index);
    const changes = checkpointChanges(selected);
    const partial = selected.some(
      (c) =>
        c.shellUsed &&
        (!c.shellCoverage?.length ||
          c.shellCoverage.some((s) => !s.complete || s.skipped > 0)),
    );
    if (
      !(await this.ui.confirmAction({
        title: "REVERTER TURNOS",
        preview: [
          checkpoints[index].title,
          `${selected.length} turnos e ${changes.length} arquivos serão revertidos.`,
          ...(partial
            ? [
                "Há comandos com cobertura parcial/legada; somente arquivos capturados serão restaurados.",
              ]
            : []),
          ...(selected.some((c) => c.shellUsed)
            ? [
                "Snapshots não revertem estado Git, dependências/builds ou efeitos externos ao filesystem autorizado.",
              ]
            : []),
        ],
        acceptLabel: "Reverter conversa e arquivos capturados",
      }))
    )
      return;
    await this.operate(async (signal) => {
      const runner = this.runner();
      const granted = [];
      for (const change of changes)
        await runner.accessPath(
          change.path,
          "file",
          { name: "rewind" },
          signal,
          granted,
        );
      signal?.throwIfAborted();
      await rewindFiles(changes, this.cwd, [
        ...this.session.addedDirs,
        ...granted,
      ]);
      this.session.messages.length = Math.min(
        this.session.messages.length,
        checkpoints[index].messageIndex,
      );
      this.session.checkpoints.splice(index);
      await this.saveSession();
      this.ui.clearConversation?.(this.cwd, this.session);
      this.ui.chatHistory = historyQuestions(this.session);
      this.ui.history?.(this.session);
      this.ui.notice(
        `${selected.length} turnos revertidos · ${changes.length} arquivos restaurados. Custos já incorridos permanecem contabilizados.`,
      );
    });
  }
  async command(line) {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    if (!match) return this.operate((signal) => this.prompt(line, signal));
    const cmd = match[1].toLowerCase();
    const args = (match[2] || "").trim();
    switch (cmd) {
      case "help":
        this.ui.print(HELP);
        break;
      case "exit":
      case "quit":
        return false;
      case "connect":
      case "login":
        await this.connect(args);
        break;
      case "logout": {
        const id = args || this.config.selected?.provider;
        if (!id) throw new Error("Informe o provider.");
        await this.store.setKey(id, null);
        this.ui.notice(
          `Chave salva de ${id} removida. Variáveis de ambiente continuam ativas se definidas.`,
        );
        break;
      }
      case "provider": {
        if (args === "add" || args.startsWith("add "))
          await this.connect(args.slice(4).trim());
        else if (args.startsWith("remove ")) {
          const id = args.slice(7).trim();
          delete this.config.providers[id];
          await this.store.setKey(id, null);
          if (this.config.selected?.provider === id) {
            this.config.selected = null;
            this.session.selected = null;
            this.model = null;
          }
          await this.saveConfig();
          await this.saveSession();
          this.ui.notice(`Provider ${id} removido da configuração.`);
        } else await this.selectProvider(args);
        break;
      }
      case "models":
        await this.models(args);
        break;
      case "model":
        if (args) await this.setModel(args);
        else await this.models();
        break;
      case "tools": {
        if (!args) {
          this.ui.print("  " + this.config.toolMode);
          break;
        }
        if (!["auto", "native", "text"].includes(args))
          throw new Error("Use /tools auto|native|text.");
        if (this.model) chooseMode(args, this.model);
        this.config.toolMode = args;
        await this.saveConfig();
        break;
      }
      case "permissions": {
        if (!args) {
          this.ui.print("  " + this.config.permission);
          this.ui.print(
            `  Autorizações da sessão: edições ${this.session.toolApprovals?.edits ? "permitidas" : "sob confirmação"} · ${this.session.toolApprovals?.shell?.length || 0} comandos · ${this.session.addedDirs.length} diretórios`,
          );
          break;
        }
        if (args === "reset") {
          this.session.toolApprovals = { edits: false, shell: [] };
          this.session.addedDirs = [];
          this.config.permission = "ask";
          await this.saveConfig();
          await this.saveSession();
          this.ui.notice(
            "Autorizações da sessão revogadas. Edições, comandos e diretórios externos voltarão a pedir aprovação.",
          );
          break;
        }
        if (!["ask", "auto"].includes(args))
          throw new Error("Use /permissions ask|auto.");
        this.config.permission = args;
        await this.saveConfig();
        this.ui.notice("Permissões: " + args);
        break;
      }
      case "plan": {
        if (args && !["on", "off"].includes(args))
          throw new Error("Use /plan [on|off].");
        this.session.plan = args ? args === "on" : !this.session.plan;
        await this.saveSession();
        this.ui.notice(
          this.session.plan
            ? "PLAN — somente leitura"
            : "BUILD — implementação",
        );
        break;
      }
      case "status": {
        const stats = await this.activeStatus();
        if (this.ui.footer?.active)
          this.ui.statusDetails(
            this.session,
            this.model,
            this.ui.statusState?.mode || this.config.toolMode,
            stats,
          );
        this.ui.print(`  Sessão: ${this.session.id}`);
        this.ui.print(
          `  Provider: ${this.config.selected?.provider || "nenhum"} · config ${this.store.home}`,
        );
        break;
      }
      case "cost": {
        const total = totals(this.session.usage);
        this.ui.print(
          `  ${total.requests} requisições · ${count(total.input)} tokens de entrada · ${count(total.output)} saída\n  USD ${money(total.cost)}${total.estimatedCost ? " (inclui estimativas)" : ""}${total.unknownCost ? " + requisições com custo desconhecido" : ""}`,
        );
        for (const purpose of ["agent", "compact", "btw"]) {
          const part = totals(
            this.session.usage.filter((r) => r.purpose === purpose),
          );
          this.ui.print(
            `  ${purpose}: ${part.requests} req · ${money(part.cost)}${part.unknownCost ? " + n/d" : ""}`,
          );
        }
        break;
      }
      case "context": {
        const stats = await this.activeStatus();
        if (stats)
          this.ui.print(
            `  Estimativa ~${stats.tokens} · janela ${stats.limit || "desconhecida"} · reserva saída ${stats.reserve}\n  Compactação ${JSON.stringify(this.config.compaction)} · ${this.session.compactions || 0} resumos`,
          );
        break;
      }
      case "config":
        await this.configCommand(args);
        break;
      case "compact":
        await this.operate(async (signal) => {
          const result = await (await this.agent()).compact(args, signal);
          this.ui.notice(
            result.changed
              ? `Contexto compactado: ${result.before} → ${result.after} caracteres de histórico.`
              : result.reason,
          );
        });
        break;
      case "btw":
        if (!args) throw new Error("Use /btw sua pergunta.");
        await this.operate(async (signal) => {
          await (await this.agent()).btw(args, signal);
        });
        break;
      case "clear":
        await this.saveSession();
        this.session = newSession(this.cwd, this.config.selected);
        await this.saveSession();
        this.historyPending = false;
        this.ui.clearConversation(this.cwd, this.session);
        break;
      case "rename":
        if (!args) throw new Error("Use /rename nome.");
        this.session.title = args.slice(0, 120);
        await this.saveSession();
        break;
      case "resume": {
        const id = args || (await this.pickStoredSession());
        if (!id) break;
        await this.restoreSession(id);
        break;
      }
      case "export": {
        const file = await allowedPath(
          this.cwd,
          args || `microcode-${this.session.id.slice(0, 8)}.md`,
          this.session.addedDirs,
        );
        try {
          await stat(file);
          if (
            !(await this.ui.confirmAction({
              title: "SOBRESCREVER EXPORTAÇÃO",
              preview: [file],
              acceptLabel: "Sobrescrever este arquivo",
            }))
          )
            break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await writeFile(
          file,
          `# ${this.session.title}\n\nSessão: ${this.session.id}\n\n\`\`\`text\n${transcript(conversationMessages(this.session)).replaceAll("```", "~~~")}\n\`\`\`\n`,
          "utf8",
        );
        this.ui.notice(`Exportado: ${file}`);
        break;
      }
      case "rewind":
      case "undo": {
        await this.rewindCommand(args);
        break;
      }
      case "init":
        await this.initProject();
        break;
      case "memory": {
        await this.memoryCommand(args);
        break;
      }
      case "add-dir": {
        if (!args) throw new Error("Use /add-dir caminho.");
        const dir = await realpath(
          path.resolve(this.cwd, args.replace(/^"|"$/g, "")),
        );
        if (!(await stat(dir)).isDirectory())
          throw new Error("Informe um diretório.");
        this.session.addedDirs = [...new Set([...this.session.addedDirs, dir])];
        await this.saveSession();
        this.ui.notice(`Diretório adicionado: ${dir}`);
        break;
      }
      case "diff":
        await this.operate(async (signal) =>
          this.ui.print(
            (
              await checkedShell(
                "git --no-pager diff --no-ext-diff --stat && git --no-pager diff --no-ext-diff",
                { cwd: this.cwd, signal },
              )
            ).stdout || "  Sem diff rastreado pelo Git.",
          ),
        );
        break;
      case "doctor": {
        await this.operate((signal) => diagnose(this, signal));
        break;
      }
      case "paste": {
        this.ui.print(
          "  Cole o pedido multilinha. Termine com .end em uma linha isolada.",
        );
        const lines = [];
        while (true) {
          const next = await this.ui.ask("");
          if (next === null || next === ".end") break;
          lines.push(next);
        }
        if (lines.length) {
          this.ui.userMessage?.(lines.join("\n"));
          await this.operate((signal) => this.prompt(lines.join("\n"), signal));
        }
        break;
      }
      default:
        throw new Error(`Comando desconhecido: /${cmd}. Use /help.`);
    }
    return true;
  }
  async shell(command) {
    await this.localOperation("!" + command, async (runner, signal) => {
      const call = { name: "shell", arguments: { command } };
      this.ui.toolResult(call, await runner.execute(call, signal));
    });
  }
  async loop() {
    this.ui.banner(this.cwd);
    if (this.historyPending) this.showResumedHistory();
    this.ui.onInterrupt = () => {
      if (this.controller) {
        this.controller.abort(new Error("Cancelado pelo usuário."));
        this.ui.notice("Cancelando execução…");
      } else this.ui.close();
    };
    while (!this.ui.closed || this.ui.queue.length) {
      try {
        await this.activeStatus();
      } catch (error) {
        this.ui.error(error.message);
      }
      const input = await this.ui.ask(color.orange("  ❯ "), { commands: true });
      if (input === null) break;
      if (!input.trim()) continue;
      try {
        if (input.startsWith("!")) await this.shell(input.slice(1));
        else if ((await this.command(input)) === false) break;
      } catch (error) {
        this.ui.error(error.message);
      }
    }
    await this.saveSession();
    this.ui.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(`MicroCode ${VERSION}`);
    return;
  }
  const cwd = await realpath(path.resolve(options.cwd || process.cwd()));
  const store = new Store();
  const config = await store.config();
  const ui = new UI();
  const session = newSession(cwd, config.selected);
  const app = new Application({ cwd, store, ui, config, session });
  try {
    if (options.resume) {
      const id =
        options.resume === true
          ? (await store.sessions(cwd))[0]?.id
          : options.resume;
      if (!id) throw new Error("Nenhuma sessão para retomar.");
      await app.restoreSession(id, { saveCurrent: false, replay: false });
    }
    if (options.provider) await app.selectProvider(options.provider);
    if (options.tools) {
      if (!["auto", "native", "text"].includes(options.tools))
        throw new Error("--tools: use auto|native|text");
      config.toolMode = options.tools;
    }
    if (options.auto) config.permission = "auto";
    if (options.model) await app.setModel(options.model);
    if (options.prompt) {
      const controller = new AbortController();
      ui.onInterrupt = () =>
        controller.abort(new Error("Cancelado pelo usuário."));
      const onSigint = () =>
        controller.abort(new Error("Cancelado pelo usuário."));
      process.on("SIGINT", onSigint);
      try {
        await app.prompt(options.prompt, controller.signal);
        await app.activeStatus();
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    } else await app.loop();
  } finally {
    ui.close();
  }
}
