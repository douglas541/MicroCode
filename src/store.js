import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PRESETS = {
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
    catalog: "openrouter",
  },
  opencode: {
    name: "OpenCode Zen",
    baseURL: "https://opencode.ai/zen/v1",
    env: "OPENCODE_API_KEY",
    catalog: "opencode",
  },
  "opencode-go": {
    name: "OpenCode Go",
    baseURL: "https://opencode.ai/zen/go/v1",
    env: "OPENCODE_API_KEY",
    catalog: "opencode-go",
  },
};

export class Store {
  constructor(
    home = process.env.MICROCODE_HOME || path.join(homedir(), ".microcode"),
  ) {
    this.home = home;
    this.writes = Promise.resolve();
  }
  async read(name, fallback) {
    try {
      return JSON.parse(await readFile(path.join(this.home, name), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw new Error(`Arquivo inválido: ${name}: ${error.message}`);
    }
  }
  async write(name, data) {
    const snapshot = JSON.stringify(data, null, 2) + "\n";
    const operation = this.writes.then(async () => {
      const target = path.join(this.home, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, target);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async config() {
    const saved = await this.read("config.json", {});
    return {
      providers: {},
      selected: null,
      toolMode: "auto",
      permission: "ask",
      maxSteps: 25,
      maxTokens: 8192,
      ...saved,
      compaction: {
        auto: true,
        threshold: 0.8,
        keepTurns: 4,
        summaryTokens: 2048,
        contextOverride: null,
        ...saved.compaction,
      },
    };
  }
  async key(id, provider) {
    return process.env[provider.env] || (await this.read("auth.json", {}))[id];
  }
  async setKey(id, key) {
    const auth = await this.read("auth.json", {});
    if (key) auth[id] = key;
    else delete auth[id];
    await this.write("auth.json", auth);
  }
  async saveSession(session) {
    session.updatedAt = new Date().toISOString();
    await this.write(`sessions/${session.id}.json`, session);
  }
  async sessions(cwd) {
    let names;
    try {
      names = await readdir(path.join(this.home, "sessions"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const sessions = await Promise.all(
      names
        .filter((n) => /^[\w-]+\.json$/.test(n))
        .map((n) => this.read(`sessions/${n}`, null)),
    );
    return sessions
      .filter((s) => s && path.resolve(s.cwd) === path.resolve(cwd))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async loadSession(id, cwd) {
    if (!/^[\w-]+$/.test(id)) throw new Error("ID de sessão inválido.");
    const session = await this.read(`sessions/${id}.json`, null);
    if (!session || path.resolve(session.cwd) !== path.resolve(cwd))
      throw new Error("Sessão não encontrada neste diretório.");
    session.messages = repairHistory(session.messages);
    return session;
  }
}

export function repairHistory(messages) {
  const repaired = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    repaired.push(message);
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const found = new Set();
    while (messages[i + 1]?.role === "tool") {
      const result = messages[++i];
      found.add(result.toolCallId);
      repaired.push(result);
    }
    for (const call of message.toolCalls)
      if (!found.has(call.id))
        repaired.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({
            ok: false,
            error:
              "Sessão interrompida antes de registrar o resultado. Confira o estado dos arquivos antes de repetir esta ação.",
          }),
        });
  }
  return repaired;
}

export function newSession(cwd, selected) {
  return {
    id: randomUUID(),
    cwd: path.resolve(cwd),
    title: "Nova sessão",
    selected,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    usage: [],
    checkpoints: [],
    addedDirs: [],
    plan: false,
  };
}
