import { randomUUID } from "node:crypto";
import { readdir, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_EXCLUSIONS = [
  ".git",
  ".microcode",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
];
const excluded = new Set(SNAPSHOT_EXCLUSIONS);
export function createCheckpoint(session, title) {
  const checkpoint = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    messageIndex: session.messages.length,
    title: title.slice(0, 100),
    changes: [],
    shellUsed: false,
  };
  session.checkpoints.push(checkpoint);
  if (session.checkpoints.length > 10) session.checkpoints.shift();
  return checkpoint;
}
const encoded = (value, encoding) =>
  value === null
    ? null
    : encoding === "base64"
      ? value
      : Buffer.from(value, "utf8").toString("base64");
export function recordChange(checkpoint, change) {
  const previous = checkpoint.changes.find((item) => item.path === change.path);
  if (!previous) {
    checkpoint.changes.push({ ...change });
    return;
  }
  if (previous.encoding === "base64" || change.encoding === "base64") {
    previous.before = encoded(previous.before, previous.encoding);
    previous.after = encoded(change.after, change.encoding);
    previous.encoding = "base64";
  } else previous.after = change.after;
  if (change.afterMode != null) previous.afterMode = change.afterMode;
}
export function checkpointChanges(checkpoints) {
  const merged = { changes: [] };
  for (const checkpoint of checkpoints)
    for (const change of checkpoint.changes) recordChange(merged, change);
  return merged.changes.filter(
    (c) =>
      c.before !== c.after ||
      (c.beforeMode != null &&
        c.afterMode != null &&
        c.beforeMode !== c.afterMode),
  );
}

export async function snapshotFiles(
  roots,
  {
    signal,
    maxFiles = 5000,
    maxBytes = 16 * 1024 * 1024,
    maxFileBytes = 1024 * 1024,
  } = {},
) {
  const files = new Map();
  const skipped = new Set();
  const issues = [];
  const visited = new Set();
  let bytes = 0;
  let count = 0;
  let complete = true;
  for (const input of new Set(roots)) {
    signal?.throwIfAborted();
    let root;
    try {
      root = await realpath(input);
      if (root !== path.resolve(input)) {
        complete = false;
        issues.push(`Raiz autorizada alterada: ${input}`);
        continue;
      }
    } catch (error) {
      complete = false;
      issues.push(`${input}: ${error.code}`);
      continue;
    }
    const queue = [root];
    while (queue.length) {
      signal?.throwIfAborted();
      const dir = queue.pop();
      if (visited.has(dir)) continue;
      visited.add(dir);
      let entries;
      try {
        if ((await realpath(dir)) !== dir) {
          complete = false;
          issues.push(`Diretório alterado: ${dir}`);
          continue;
        }
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        complete = false;
        issues.push(`${dir}: ${error.code}`);
        continue;
      }
      for (const entry of entries) {
        if (excluded.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (++count > maxFiles) {
          complete = false;
          issues.push(`Limite de ${maxFiles} entradas.`);
          return { files, skipped, issues, complete };
        }
        try {
          const info = await lstat(file);
          if (info.isSymbolicLink()) {
            skipped.add(file);
            continue;
          }
          if (info.isDirectory()) {
            queue.push(file);
            continue;
          }
          if (!info.isFile() || info.size > maxFileBytes) {
            skipped.add(file);
            continue;
          }
          if (bytes + info.size > maxBytes) {
            complete = false;
            issues.push(`Limite de ${maxBytes} bytes.`);
            return { files, skipped, issues, complete };
          }
          if ((await realpath(file)) !== file) {
            skipped.add(file);
            continue;
          }
          const content = await readFile(file);
          if (content.length > maxFileBytes) {
            skipped.add(file);
            continue;
          }
          bytes += content.length;
          if (bytes > maxBytes) {
            complete = false;
            issues.push(`Limite de ${maxBytes} bytes.`);
            return { files, skipped, issues, complete };
          }
          files.set(file, {
            content: content.toString("base64"),
            mode: info.mode & 0o777,
          });
        } catch (error) {
          skipped.add(file);
          issues.push(`${file}: ${error.code}`);
        }
      }
    }
  }
  return { files, skipped, issues, complete };
}
export function snapshotChanges(before, after) {
  if (!before.complete || !after.complete) return [];
  const changes = [];
  for (const file of new Set([...before.files.keys(), ...after.files.keys()])) {
    if (before.skipped.has(file) || after.skipped.has(file)) continue;
    const old = before.files.get(file);
    const current = after.files.get(file);
    if (old?.content === current?.content && old?.mode === current?.mode)
      continue;
    changes.push({
      path: file,
      before: old?.content ?? null,
      after: current?.content ?? null,
      encoding: "base64",
      beforeMode: old?.mode ?? null,
      afterMode: current?.mode ?? null,
    });
  }
  return changes;
}
