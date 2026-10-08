import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { Store, PRESETS, newSession } from "./store.js";
import { configuredProviders, catalog, chooseMode } from "./providers.js";
import { ToolRunner, rewindFiles, allowedPath, runShell } from "./tools.js";
import { Agent } from "./agent.js";
import { UI, color, modelLine, count, money, clean } from "./ui.js";
import { attachFiles, contextStats, transcript } from "./context.js";
import { textToolPrompt, flattenHistory } from "./text-tools.js";
import { totals } from "./metrics.js";

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
  /logout [provider]      Remover chave salva; variáveis de ambiente têm prioridade
  /provider              Listar/escolher provider
  /provider add|remove ID Adicionar ou remover provider
  /models [filtro]        Navegar modelos: custo/1M, janela e tools nativas
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
  /resume [ID]           Listar/retomar sessão deste projeto
  /rename NOME           Renomear sessão
  /export [arquivo.md]   Exportar conversa para Markdown
  /rewind                Reverter último turno e edições feitas por file tools
  /undo                  Alias de /rewind (shell não é reversível por checkpoint)

PROJETO E PREFERÊNCIAS
  /init                  Inspecionar projeto e criar/atualizar AGENTS.md
  /memory [instruções]   Ver AGENTS.md ou pedir atualização
  /plan [on|off]         Alternar planejamento somente leitura
  /permissions ask|auto  Confirmação de edição e comandos shell
  /config [chave valor]  Mostrar/alterar configuração, inclusive compaction.*
  /add-dir CAMINHO       Incluir diretório nas ferramentas de arquivos
  /diff                  Mostrar git diff do projeto
  /doctor                Verificar runtime, config e conexão do catálogo
  /paste                 Entrada multilinha (finalize com .end)
  @arquivo @"com espaços" Anexar arquivos ao pedido
  !comando               Executar comando shell diretamente
  /help                  Esta ajuda (Tab completa comandos)
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
      entries.forEach(([key, p], i) =>
        this.ui.print(`  ${i + 1}. ${p.name} (${key})`),
      );
      const input = await this.ui.ask(
        "  Provider (número ou ID; Enter cancela): ",
      );
      if (!input?.trim()) return;
      id = entries[Number(input) - 1]?.[0] || input.trim();
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
      Object.entries(PRESETS).forEach(([key, p], i) =>
        this.ui.print(`  ${i + 1}. ${p.name} (${key})`),
      );
      this.ui.print("  4. Provider personalizado (OpenAI-compatible)");
      const answer = await this.ui.ask("  Provider: ");
      if (!answer?.trim()) return;
      id =
        Object.keys(PRESETS)[Number(answer) - 1] ||
        (answer === "4" ? "custom" : answer.trim());
    }
    let provider = PRESETS[id] || this.config.providers[id];
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
    }
    const key = await this.ui.ask(
      `  API key ${provider.name} (Enter usa ${provider.env}${id === "opencode" ? " ou modelos públicos" : ""}): `,
      { secret: true },
    );
    if (key === null) return;
    if (key.trim()) await this.store.setKey(id, key.trim());
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
    let query = filter.toLowerCase();
    let page = 0;
    while (true) {
      const matches = all.filter((m) =>
        `${m.name} ${m.id}`.toLowerCase().includes(query),
      );
      const size = 10;
      const pages = Math.max(1, Math.ceil(matches.length / size));
      page = Math.min(page, pages - 1);
      this.ui.print(
        `\n  ${color.bold("MODELOS")} · ${this.config.selected.provider} · ${matches.length} resultados · página ${page + 1}/${pages}`,
      );
      this.ui.print(
        color.muted(
          "  Preços em USD por 1 milhão de tokens. n/d = indisponível.",
        ),
      );
      for (
        let i = page * size;
        i < Math.min((page + 1) * size, matches.length);
        i++
      )
        this.ui.print(`\n  ${i + 1}. ${modelLine(matches[i])}`);
      const answer = (
        await this.ui.ask(
          "\n  Número/ID · n próxima · p anterior · /filtro · Enter cancela: ",
        )
      )?.trim();
      if (!answer) return;
      if (answer === "n") {
        page = Math.min(pages - 1, page + 1);
        continue;
      }
      if (answer === "p") {
        page = Math.max(0, page - 1);
        continue;
      }
      if (answer.startsWith("/")) {
        query = answer.slice(1).toLowerCase();
        page = 0;
        continue;
      }
      const model =
        matches[Number(answer) - 1] || all.find((m) => m.id === answer);
      if (!model) {
        this.ui.error("Seleção inválida.");
        continue;
      }
      await this.setModel(model.id);
      return;
    }
  }
  runner() {
    return new ToolRunner({
      cwd: this.cwd,
      addedDirs: this.session.addedDirs,
      permission: this.config.permission,
      plan: this.session.plan,
      confirm: (call, signal) => this.ui.confirm(call, signal),
      onTool: (call) => this.ui.tool(call),
    });
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
        answer: (text, purpose) => this.ui.answer(text, purpose),
        toolResult: (call, output) => this.ui.toolResult(call, output),
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
    else this.config[key] = value;
    await this.saveConfig();
    this.ui.notice(`${key} = ${value}`);
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
      case "status":
        await this.activeStatus();
        this.ui.print(
          `  Provider: ${this.config.selected?.provider || "nenhum"} · config ${this.store.home}`,
        );
        break;
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
        this.ui.notice(
          "Nova sessão. A anterior pode ser retomada com /resume.",
        );
        break;
      case "rename":
        if (!args) throw new Error("Use /rename nome.");
        this.session.title = args.slice(0, 120);
        await this.saveSession();
        break;
      case "resume": {
        let id = args;
        if (!id) {
          const list = (await this.store.sessions(this.cwd))
            .filter((s) => s.id !== this.session.id)
            .slice(0, 20);
          if (!list.length) {
            this.ui.notice("Nenhuma outra sessão neste projeto.");
            break;
          }
          list.forEach((s, i) =>
            this.ui.print(
              `  ${i + 1}. ${clean(s.title)} · ${s.id} · ${s.updatedAt}`,
            ),
          );
          const answer = await this.ui.ask("  Sessão (número ou ID): ");
          if (!answer?.trim()) break;
          id = list[Number(answer) - 1]?.id || answer.trim();
        }
        const restored = await this.store.loadSession(id, this.cwd);
        await this.saveSession();
        this.session = restored;
        this.config.selected = restored.selected;
        this.model = null;
        await this.saveConfig();
        this.ui.notice(`Retomada: ${restored.title}`);
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
          const answer = await this.ui.ask(
            "  Arquivo existe. Sobrescrever? [s/N] ",
          );
          if (!/^(s|y|sim|yes)$/i.test(answer || "")) break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await writeFile(
          file,
          `# ${this.session.title}\n\nSessão: ${this.session.id}\n\n\`\`\`text\n${transcript(this.session.messages).replaceAll("```", "~~~")}\n\`\`\`\n`,
          "utf8",
        );
        this.ui.notice(`Exportado: ${file}`);
        break;
      }
      case "rewind":
      case "undo": {
        const checkpoint = this.session.checkpoints.at(-1);
        if (!checkpoint) {
          this.ui.notice("Nenhum checkpoint disponível.");
          break;
        }
        this.ui.print(
          `  ${clean(checkpoint.title)} · ${checkpoint.changes.length} arquivos${checkpoint.shellUsed ? " · alterações via shell não são restauradas" : ""}`,
        );
        const answer = await this.ui.ask(
          "  Reverter este turno e file tools? [s/N] ",
        );
        if (!/^(s|y|sim|yes)$/i.test(answer || "")) break;
        await rewindFiles(checkpoint.changes, this.cwd, this.session.addedDirs);
        this.session.messages.length = checkpoint.messageIndex;
        this.session.checkpoints.pop();
        await this.saveSession();
        this.ui.notice(
          "Turno revertido. Custos já incorridos permanecem contabilizados.",
        );
        break;
      }
      case "init":
        await this.operate((signal) =>
          this.prompt(
            "Inspecione a estrutura e os comandos deste projeto. Crie ou atualize AGENTS.md com instruções concisas e específicas para agentes de código, respeitando o conteúdo existente. Verifique antes de afirmar comandos.",
            signal,
          ),
        );
        break;
      case "memory": {
        if (args)
          await this.operate((signal) =>
            this.prompt(
              `Leia AGENTS.md e atualize as instruções persistentes conforme este pedido: ${args}`,
              signal,
            ),
          );
        else
          this.ui.print(
            await readFile(path.join(this.cwd, "AGENTS.md"), "utf8").catch(
              (error) => {
                if (error.code === "ENOENT")
                  return "  AGENTS.md não existe. Use /init.";
                throw error;
              },
            ),
          );
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
        this.ui.print(
          (await runShell("git diff --stat && git diff", { cwd: this.cwd }))
            .stdout || "  Sem diff rastreado pelo Git.",
        );
        break;
      case "doctor": {
        this.ui.print(
          `  Node ${process.version} · ${process.platform} · ${this.cwd}\n  Config ${this.store.home}`,
        );
        for (const [id, p] of Object.entries(this.providers()))
          this.ui.print(
            `  ${id} · ${p.baseURL} · chave ${(await this.store.key(id, p)) ? "disponível" : "não definida"}`,
          );
        if (this.config.selected?.provider)
          this.ui.print(
            `  Catálogo: ${(await this.loadModel(null, true)).length} modelos`,
          );
        else this.ui.notice("Use /connect para começar.");
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
        if (lines.length)
          await this.operate((signal) => this.prompt(lines.join("\n"), signal));
        break;
      }
      default:
        throw new Error(`Comando desconhecido: /${cmd}. Use /help.`);
    }
    return true;
  }
  async shell(command) {
    await this.operate(async (signal) => {
      const runner = this.runner();
      const call = { name: "shell", arguments: { command } };
      this.ui.toolResult(call, await runner.execute(call, signal));
    });
  }
  async loop() {
    this.ui.banner(this.cwd);
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
      const input = await this.ui.ask(color.orange("  ❯ "));
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
    console.log("MicroCode 0.1.0");
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
      app.session = await store.loadSession(id, cwd);
      config.selected = app.session.selected;
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
