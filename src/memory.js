import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { allowedPath } from "./tools.js";

export const MEMORY_FILE = ".microcode/memory.json";
export const MEMORY_LIMIT = 24000;
export async function readMemory(cwd) {
  try {
    const file = await allowedPath(cwd, MEMORY_FILE);
    if ((await stat(file)).size > 128 * 1024)
      throw new Error("Arquivo de memória excede 128 KiB.");
    const data = JSON.parse(await readFile(file, "utf8"));
    if (!data || data.version !== 1 || !Array.isArray(data.entries))
      throw new Error("Formato de memória inválido.");
    const ids = new Set();
    for (const entry of data.entries) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !/^[\w-]+$/.test(entry.id) ||
        typeof entry.text !== "string" ||
        !entry.text.trim() ||
        entry.text.length > 4000 ||
        ids.has(entry.id)
      )
        throw new Error("Entrada de memória inválida.");
      ids.add(entry.id);
    }
    if (
      data.entries.length > 100 ||
      data.entries.reduce((n, e) => n + e.text.length, 0) > MEMORY_LIMIT
    )
      throw new Error("Memória do projeto excede o limite.");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, entries: [] };
    throw error;
  }
}
export function editMemory(data, operation, value) {
  const result = { version: 1, entries: data.entries.map((e) => ({ ...e })) };
  const now = new Date().toISOString();
  if (operation === "clear") result.entries = [];
  else if (operation === "add") {
    const text = value.trim();
    if (result.entries.some((e) => e.text === text)) return result;
    result.entries.push({
      id: randomUUID().slice(0, 8),
      text,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const [id] = value.split(/\s+/, 1);
    if (operation === "remove" && value.trim() !== id)
      throw new Error("Use /memory remove ID.");
    const matches = result.entries.filter(
      (e) => e.id === id || e.id.startsWith(id),
    );
    if (!id || matches.length !== 1)
      throw new Error("Informe um ID de memória existente e sem ambiguidade.");
    if (operation === "remove")
      result.entries = result.entries.filter((e) => e !== matches[0]);
    else if (operation === "edit") {
      matches[0].text = value.slice(id.length).trim();
      matches[0].updatedAt = now;
    } else throw new Error("Operação de memória inválida.");
  }
  if (
    result.entries.some((e) => !e.text || e.text.length > 4000) ||
    result.entries.length > 100 ||
    result.entries.reduce((n, e) => n + e.text.length, 0) > MEMORY_LIMIT
  )
    throw new Error(
      "Memória: até 100 notas, 4.000 caracteres por nota e 24.000 no total.",
    );
  return result;
}
export function memoryInstructions(data) {
  return data.entries.length
    ? "--- Memória persistente do projeto ---\n" +
        data.entries.map((e) => `[${e.id}] ${e.text}`).join("\n\n")
    : "";
}
