import { access, constants } from "node:fs/promises";
import path from "node:path";
import { runShell } from "./tools.js";
import { catalog, chooseMode } from "./providers.js";
import { validateCredential } from "./credentials.js";
import { projectInstructions } from "./context.js";

export async function checkedShell(command, options) {
  const result = await runShell(command, options);
  if (result.exitCode !== 0 || result.timedOut || result.aborted)
    throw new Error(
      result.stderr.trim() ||
        (result.timedOut
          ? "Comando excedeu o timeout."
          : result.aborted
            ? "Comando cancelado."
            : `Comando falhou (exit ${result.exitCode}).`),
    );
  return result;
}

export async function diagnose(app, signal) {
  const checks = [];
  const check = async (name, fn) => {
    signal?.throwIfAborted();
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      checks.push({ name, ok: false, detail: error.message });
    }
    const item = checks.at(-1);
    app.ui.print(`  ${item.ok ? "✓" : "×"} ${name}: ${item.detail}`);
  };
  await check("Node", async () => {
    if (Number(process.versions.node.split(".")[0]) < 22)
      throw new Error(`Node ${process.version}; requer 22 ou superior.`);
    return `${process.version} · ${process.platform}`;
  });
  await check("Projeto", async () => {
    await access(app.cwd, constants.R_OK);
    return app.cwd;
  });
  await check(
    "Instruções e memória",
    async () =>
      `${(await projectInstructions(app.cwd)).length} caracteres carregados`,
  );
  await check("Config", async () => {
    await app.store.read("config.json", {});
    let parent = app.store.home;
    while (true) {
      try {
        await access(parent, constants.R_OK | constants.W_OK);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || path.dirname(parent) === parent)
          throw error;
        parent = path.dirname(parent);
      }
    }
    return `${app.store.home} · armazenamento acessível`;
  });
  await check("Shell", async () =>
    (
      await checkedShell(
        process.platform === "win32" ? "ver" : "echo shell-ok",
        { cwd: app.cwd, timeout: 10000, signal },
      )
    ).stdout.trim(),
  );
  await check("pnpm", async () => {
    const version = (
      await checkedShell("pnpm --version", {
        cwd: app.cwd,
        timeout: 10000,
        signal,
      })
    ).stdout.trim();
    if (version !== "12.10.1")
      throw new Error(`${version}; versão esperada 12.10.1.`);
    return version;
  });
  await check("Git", async () =>
    (
      await checkedShell("git --version", {
        cwd: app.cwd,
        timeout: 10000,
        signal,
      })
    ).stdout.trim(),
  );
  for (const [id, provider] of Object.entries(app.providers())) {
    await check(`${id} · autenticação`, async () => {
      const credential = await app.store.credential(id, provider);
      if (!credential.key) {
        if (provider.catalog === "custom" || provider.catalog === "opencode")
          return "sem chave; acesso público/local";
        throw new Error(`Chave não definida. Use /connect ${id}.`);
      }
      const result = await validateCredential(provider, credential.key, {
        signal,
      });
      if (credential.normalized && credential.source === "saved")
        await app.store.setKey(id, result.key);
      return `${result.verified ? "autenticação confirmada" : "não comprovada (endpoint público)"} · origem ${credential.source}${result.note ? " · " + result.note : ""}`;
    });
    await check(`${id} · catálogo`, async () => {
      const result = await catalog(id, provider, app.store, {
        refresh: true,
        signal,
      });
      if (result.stale)
        throw new Error(`Somente cache disponível: ${result.warning}`);
      if (app.config.selected?.provider === id && app.config.selected.model) {
        const model = result.models.find(
          (m) => m.id === app.config.selected.model,
        );
        if (!model) throw new Error("Modelo selecionado não está no catálogo.");
        if (model.protocolKnown === false)
          throw new Error("Protocolo do modelo selecionado desconhecido.");
        chooseMode(app.config.toolMode, model);
      }
      return `${result.models.length} modelos`;
    });
  }
  if (!Object.keys(app.providers()).length)
    app.ui.notice("Use /connect para configurar um provider.");
  app.ui.print(
    `  Diagnóstico: ${checks.filter((c) => c.ok).length}/${checks.length} verificações aprovadas.`,
  );
  return checks;
}
