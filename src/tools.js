import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const string = (description) => ({ type: "string", description });
const integer = (description, minimum, maximum) => ({
  type: "integer",
  description,
  minimum,
  maximum,
});
const tool = (name, description, properties, required, writes = false) => ({
  name,
  description,
  parameters: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
  writes,
});

export const TOOL_DEFINITIONS = [
  tool(
    "read_file",
    "Read UTF-8 source files before editing. Returns numbered lines. Paths are workspace-relative.",
    {
      path: string("File path"),
      offset: integer("First line (1-based, default 1)", 1, 1000000),
      limit: integer("Maximum lines (default 200, max 2000)", 1, 2000),
    },
    ["path"],
  ),
  tool(
    "list_files",
    "List files/directories recursively. Skips dependencies and Git internals; optionally filter by glob (*, **, ?).",
    {
      path: string("Directory path, default ."),
      pattern: string("Relative path glob such as **/*.js"),
      limit: integer("Maximum entries, default 200", 1, 1000),
    },
    [],
  ),
  tool(
    "search",
    "Search source files for literal text or a JavaScript regular expression. Returns path, line and text.",
    {
      query: string("Text or regex to search"),
      path: string("Directory, default ."),
      pattern: string("Relative file path glob"),
      regex: {
        type: "boolean",
        description: "Interpret query as regex, default false",
      },
      limit: integer("Maximum matches, default 100", 1, 500),
    },
    ["query"],
  ),
  tool(
    "write_file",
    "Create or replace a UTF-8 file. Read existing files first. Parent directories are created.",
    { path: string("File path"), content: string("Entire new file contents") },
    ["path", "content"],
    true,
  ),
  tool(
    "edit_file",
    "Replace exact text in a UTF-8 file. old_text must be unique unless replace_all=true. Read the file first.",
    {
      path: string("File path"),
      old_text: string("Exact, nonempty text to replace"),
      new_text: string("Replacement text"),
      replace_all: {
        type: "boolean",
        description: "Replace every match, default false",
      },
    },
    ["path", "old_text", "new_text"],
    true,
  ),
  tool(
    "shell",
    "Run a shell command in the project (cmd.exe on Windows, /bin/sh on POSIX). Use for Git, builds, tests and terminal operations. Prefer file tools for editing.",
    {
      command: string("Command with correct shell quoting"),
      cwd: string("Working directory, default project root"),
      timeout_ms: integer(
        "Timeout in milliseconds, default 120000",
        100,
        600000,
      ),
    },
    ["command"],
    true,
  ),
];

export function validateArguments(definition, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Argumentos devem ser um objeto JSON válido.");
  for (const key of definition.parameters.required)
    if (!(key in args)) throw new Error(`Argumento obrigatório: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const p = definition.parameters.properties[key];
    if (!p) throw new Error(`Argumento desconhecido: ${key}`);
    if (
      p.type === "integer" ? !Number.isInteger(value) : typeof value !== p.type
    )
      throw new Error(`Tipo inválido para ${key}: esperado ${p.type}`);
    if (p.type === "integer" && (value < p.minimum || value > p.maximum))
      throw new Error(`${key} fora do intervalo ${p.minimum}–${p.maximum}`);
    if (typeof value === "string" && Buffer.byteLength(value) > 1024 * 1024)
      throw new Error(`${key} excedeu 1 MB.`);
  }
}

function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function allowedPath(cwd, input = ".", addedDirs = []) {
  const roots = await Promise.all([cwd, ...addedDirs].map((r) => realpath(r)));
  const target = path.resolve(cwd, input);
  if (!roots.some((root) => within(root, target)))
    throw new Error("Caminho fora dos diretórios autorizados. Use /add-dir.");
  // Check every existing ancestor, including symlinks, even for not-yet-created files.
  let ancestor = target;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (!roots.some((root) => within(root, resolved)))
        throw new Error("Symlink aponta para fora dos diretórios autorizados.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return target;
}

const SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  ".microcode",
  "dist",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
]);

export function globRegex(pattern = "**") {
  let source = "^";
  const normalized = pattern.replaceAll("\\", "/");
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === "*" && normalized[i + 1] === "*") {
      i++;
      if (normalized[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

async function* walk(root, { signal, maxVisited = 15000 } = {}) {
  const queue = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < maxVisited) {
    signal?.throwIfAborted();
    const { dir, depth } = queue.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > maxVisited) return;
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      yield {
        file,
        relative: path.relative(root, file).replaceAll("\\", "/"),
        directory: entry.isDirectory(),
      };
      if (entry.isDirectory() && depth < 30)
        queue.push({ dir: file, depth: depth + 1 });
    }
  }
}

const bounded = (value) =>
  value.length > 20000
    ? value.slice(0, 20000) + "\n[saída truncada em 20.000 caracteres]"
    : value;

export function runShell(command, { cwd, timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, {
      cwd,
      shell:
        process.platform === "win32"
          ? process.env.ComSpec || "cmd.exe"
          : "/bin/sh",
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32")
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => child.kill());
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const abort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // Drain both pipes even after the display cap to prevent the child blocking.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s) => {
      if (stdout.length < 20001) stdout += s.slice(0, 20001 - stdout.length);
    });
    child.stderr.on("data", (s) => {
      if (stderr.length < 20001) stderr += s.slice(0, 20001 - stderr.length);
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        exitCode: code,
        stdout: bounded(stdout),
        stderr: bounded(stderr),
        timedOut,
        aborted,
      });
    });
  });
}

export class ToolRunner {
  constructor({
    cwd,
    addedDirs = [],
    permission = "ask",
    plan = false,
    confirm = async () => false,
    onTool = () => {},
    onChange = async () => {},
  }) {
    Object.assign(this, {
      cwd,
      addedDirs,
      permission,
      plan,
      confirm,
      onTool,
      onChange,
    });
  }
  definitions() {
    return TOOL_DEFINITIONS.filter((t) => !this.plan || !t.writes).map(
      ({ writes, ...t }) => t,
    );
  }
  async execute(call, signal) {
    const definition = TOOL_DEFINITIONS.find((t) => t.name === call.name);
    try {
      signal?.throwIfAborted();
      if (!definition) throw new Error(`Ferramenta desconhecida: ${call.name}`);
      validateArguments(definition, call.arguments);
      if (this.plan && definition.writes)
        throw new Error("Modo plan: edição e shell desativados.");
      if (
        definition.writes &&
        this.permission !== "auto" &&
        !(await this.confirm(call, signal))
      )
        return {
          ok: false,
          denied: true,
          error: "Usuário negou a execução. Não tente contornar essa decisão.",
        };
      signal?.throwIfAborted();
      this.onTool(call);
      const args = call.arguments;
      const resolve = (input) => allowedPath(this.cwd, input, this.addedDirs);
      switch (call.name) {
        case "read_file": {
          const file = await resolve(args.path);
          const text = await this.readText(file);
          const lines = text.split("\n");
          const start = args.offset || 1;
          const end = Math.min(lines.length, start - 1 + (args.limit || 200));
          return {
            ok: true,
            path: args.path,
            totalLines: lines.length,
            content: bounded(
              lines
                .slice(start - 1, end)
                .map((line, i) => `${start + i}: ${line}`)
                .join("\n"),
            ),
            truncated: end < lines.length,
          };
        }
        case "list_files": {
          const root = await resolve(args.path || ".");
          const pattern = globRegex(args.pattern);
          const entries = [];
          const limit = args.limit || 200;
          for await (const entry of walk(root, { signal })) {
            if (!pattern.test(entry.relative)) continue;
            entries.push(entry.relative + (entry.directory ? "/" : ""));
            if (entries.length > limit) break;
          }
          return {
            ok: true,
            entries: entries.slice(0, limit),
            truncated: entries.length > limit,
            scanLimit: 15000,
          };
        }
        case "search": {
          const root = await resolve(args.path || ".");
          const pattern = globRegex(args.pattern);
          const matches = [];
          const limit = args.limit || 100;
          const regex = args.regex ? new RegExp(args.query) : null;
          for await (const entry of walk(root, { signal })) {
            if (entry.directory || !pattern.test(entry.relative)) continue;
            let text;
            try {
              text = await this.readText(entry.file);
            } catch {
              continue;
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++)
              if (
                regex ? regex.test(lines[i]) : lines[i].includes(args.query)
              ) {
                matches.push({
                  path: entry.relative,
                  line: i + 1,
                  text: lines[i].slice(0, 500),
                });
                if (matches.length > limit) break;
              }
            if (matches.length > limit) break;
          }
          return {
            ok: true,
            matches: matches.slice(0, limit),
            truncated: matches.length > limit,
            scanLimit: 15000,
          };
        }
        case "write_file":
        case "edit_file": {
          const file = await resolve(args.path);
          let before = null;
          try {
            before = await this.readText(file);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          let after = args.content;
          if (call.name === "edit_file") {
            if (before === null) throw new Error("Arquivo não existe.");
            if (!args.old_text)
              throw new Error("old_text não pode estar vazio.");
            const occurrences = before.split(args.old_text).length - 1;
            if (!occurrences)
              throw new Error("old_text não encontrado; releia o arquivo.");
            if (occurrences > 1 && !args.replace_all)
              throw new Error(
                "old_text é ambíguo; forneça mais contexto ou replace_all=true.",
              );
            after = args.replace_all
              ? before.replaceAll(args.old_text, args.new_text)
              : before.replace(args.old_text, args.new_text);
          }
          if (Buffer.byteLength(after) > 1024 * 1024)
            throw new Error("Arquivo final excedeu 1 MB.");
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, after, "utf8");
          await this.onChange({ path: file, before, after });
          return { ok: true, path: args.path, bytes: Buffer.byteLength(after) };
        }
        case "shell": {
          const output = await runShell(args.command, {
            cwd: await resolve(args.cwd || "."),
            timeout: args.timeout_ms,
            signal,
          });
          return {
            ok: output.exitCode === 0 && !output.timedOut && !output.aborted,
            ...output,
          };
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, error: error.message };
    }
  }
  async readText(file) {
    if ((await stat(file)).size > 1024 * 1024)
      throw new Error(
        "Arquivo excedeu 1 MB; use shell para operações em arquivos grandes.",
      );
    const text = await readFile(file, "utf8");
    if (text.includes("\0")) throw new Error("Arquivo binário não suportado.");
    return text;
  }
}

export async function rewindFiles(changes, cwd, addedDirs = []) {
  // Validate all files before changing anything. Never overwrite subsequent manual edits.
  for (const change of changes) {
    await allowedPath(cwd, change.path, addedDirs);
    const current = await readFile(change.path, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (current !== change.after)
      throw new Error(
        `Arquivo mudou após o checkpoint: ${change.path}. Rewind cancelado.`,
      );
  }
  for (const change of [...changes].reverse()) {
    if (change.before === null) await unlink(change.path);
    else await writeFile(change.path, change.before, "utf8");
  }
}
