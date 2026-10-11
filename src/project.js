import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SNAPSHOT_EXCLUSIONS } from "./checkpoints.js";
import { allowedPath } from "./tools.js";

const START = "<!-- microcode:project:start -->";
const END = "<!-- microcode:project:end -->";
async function readProject(cwd, name) {
  const file = await allowedPath(cwd, name);
  if ((await stat(file)).size > 1024 * 1024)
    throw new Error(`${name} excede 1 MiB.`);
  return readFile(file, "utf8");
}
export async function inspectProject(cwd) {
  const entries = (await readdir(cwd, { withFileTypes: true }))
    .filter((e) => !e.isSymbolicLink() && !SNAPSHOT_EXCLUSIONS.includes(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = entries.map((e) => e.name);
  const facts = [];
  const commands = [];
  if (names.includes("package.json")) {
    const pkg = JSON.parse(await readProject(cwd, "package.json"));
    if (pkg.name) facts.push(`Pacote: ${JSON.stringify(pkg.name)}.`);
    if (pkg.type)
      facts.push(`Tipo de módulos declarado: ${JSON.stringify(pkg.type)}.`);
    if (pkg.engines?.node)
      facts.push(
        `Node declarado em package.json: ${JSON.stringify(pkg.engines.node)}.`,
      );
    const manager =
      pkg.packageManager?.split("@")[0] ||
      (names.includes("pnpm-lock.yaml")
        ? "pnpm"
        : names.includes("yarn.lock")
          ? "yarn"
          : names.includes("bun.lock") || names.includes("bun.lockb")
            ? "bun"
            : "npm");
    if (pkg.packageManager)
      facts.push(
        `Gerenciador declarado: ${JSON.stringify(pkg.packageManager)}.`,
      );
    for (const [key, script] of Object.entries(pkg.scripts || {})) {
      if (
        /^[\w:-]+$/.test(key) &&
        typeof script === "string" &&
        ["npm", "pnpm", "yarn", "bun"].includes(manager)
      )
        commands.push(`${manager} run ${key}`);
    }
  }
  for (const [manifest, label] of [
    ["pyproject.toml", "Python"],
    ["requirements.txt", "dependências Python"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["pom.xml", "Maven/Java"],
    ["build.gradle", "Gradle"],
    ["composer.json", "PHP/Composer"],
    ["Gemfile", "Ruby/Bundler"],
  ])
    if (names.includes(manifest)) {
      await readProject(cwd, manifest);
      facts.push(`${label}: manifesto ${manifest} presente.`);
    }
  if (names.includes("Makefile")) {
    const text = await readProject(cwd, "Makefile");
    for (const match of text.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm))
      commands.push(`make ${match[1]}`);
  }
  const files = entries
    .slice(0, 40)
    .map((e) => JSON.stringify(e.name + (e.isDirectory() ? "/" : "")));
  return {
    facts,
    commands: [...new Set(commands)].sort(),
    files,
    truncated: entries.length > 40,
  };
}
export function generatedInstructions(report) {
  return `${START}\n## Projeto — levantamento local do MicroCode\n\n${report.facts.length ? report.facts.map((f) => "- " + f).join("\n") : "- Nenhum manifesto reconhecido na raiz."}\n\n### Estrutura na raiz\n\n${report.files.map((f) => "- " + f).join("\n")}${report.truncated ? "\n- Listagem limitada às primeiras 40 entradas." : ""}\n\n### Comandos declarados\n\n${report.commands.length ? report.commands.map((c) => "- `" + c + "`").join("\n") : "Nenhum comando identificado em manifestos."}\n\nEstes comandos foram extraídos de manifestos; /init não os executou. Verifique os resultados ao utilizá-los.\n\n### Trabalho no projeto\n\n- Leia os arquivos e estas instruções antes de editar.\n- Preserve o trabalho existente e siga o estilo do código ao redor.\n- Execute as verificações pertinentes à mudança e informe os resultados reais.\n- Não crie commits sem pedido explícito.\n${END}`;
}
export function updateInstructions(existing, report) {
  const block = generatedInstructions(report);
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start < 0 && end < 0)
    return (
      (existing
        ? existing + (existing.endsWith("\n") ? "\n" : "\n\n")
        : "# Instruções do projeto\n\n") +
      block +
      "\n"
    );
  if (
    start < 0 ||
    end < start ||
    existing.indexOf(START, start + START.length) >= 0 ||
    existing.indexOf(END, end + END.length) >= 0
  )
    throw new Error(
      "Bloco gerado de AGENTS.md possui marcadores inválidos; corrija-os antes de /init.",
    );
  return existing.slice(0, start) + block + existing.slice(end + END.length);
}
