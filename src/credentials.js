import { APIError, request } from "./http.js";

export function normalizeApiKey(value) {
  if (typeof value !== "string") return "";
  let key = value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (
    key.length >= 2 &&
    ((key[0] === '"' && key.at(-1) === '"') ||
      (key[0] === "'" && key.at(-1) === "'"))
  )
    key = key.slice(1, -1).trim();
  // A repeated paste is recoverable only when the full OpenRouter key repeats
  // exactly. Never guess, truncate arbitrary keys, or silently repair corruption.
  const repeated = /^(sk-or-v1-[a-fA-F0-9]{64})\1+$/.exec(key);
  return repeated ? repeated[1] : key;
}

export async function validateCredential(
  provider,
  value,
  { fetchImpl = fetch, signal } = {},
) {
  const key = normalizeApiKey(value);
  if (!key) throw new Error(`API key ausente para ${provider.name}.`);
  if (/\s/.test(key))
    throw new Error("A API key contém espaços internos. Cole somente a chave.");
  const normalized = key !== value;
  const base = provider.baseURL.replace(/\/$/, "");
  if (["opencode", "opencode-go"].includes(provider.catalog)) {
    // /models is public for legacy Zen keys. Go usage authenticates the same
    // workspace key before checking the subscription, and never generates tokens.
    const endpoint = base.replace(/\/zen\/v1$/, "/zen/go/v1") + "/usage";
    try {
      const response = await request(endpoint, {
        key,
        fetchImpl,
        signal,
        timeout: 30000,
      });
      const data = await response.json();
      if (!data.usage || typeof data.usage !== "object")
        throw new Error("Resposta de autenticação inválida do OpenCode.");
      return { key, verified: true, normalized, endpoint };
    } catch (error) {
      if (
        provider.catalog === "opencode" &&
        error.status === 403 &&
        error.errorType === "EntitlementError"
      )
        return {
          key,
          verified: true,
          normalized,
          endpoint,
          note: "Chave autenticada; sem assinatura Go.",
        };
      throw error;
    }
  }
  if (provider.catalog !== "openrouter") {
    const endpoint = new URL(base + (provider.authPath || "/models"));
    if (endpoint.origin !== new URL(base).origin)
      throw new Error(
        "Endpoint de autenticação deve usar a origem do provider.",
      );
    const response = await request(endpoint.href, {
      key,
      fetchImpl,
      signal,
      timeout: 30000,
    });
    const data = await response.json();
    if (!provider.authPath && !Array.isArray(data.data))
      throw new Error("Catálogo de modelos inválido.");
    let protectedEndpoint = false;
    try {
      const anonymous = await request(endpoint.href, {
        fetchImpl,
        signal,
        timeout: 30000,
      });
      await anonymous.body?.cancel();
    } catch (error) {
      if (![401, 403].includes(error.status)) throw error;
      protectedEndpoint = true;
    }
    return {
      key,
      verified: protectedEndpoint,
      normalized,
      endpoint: endpoint.href,
      note: protectedEndpoint
        ? "Autenticação confirmada em endpoint protegido."
        : "Endpoint público acessível; a API não comprovou a validade da chave.",
    };
  }
  try {
    const response = await request(provider.baseURL + "/key", {
      key,
      fetchImpl,
      signal,
      timeout: 30000,
    });
    const data = await response.json();
    if (!data.data || typeof data.data !== "object")
      throw new Error("Resposta de autenticação inválida do OpenRouter.");
    return { key, verified: true, normalized, endpoint: base + "/key" };
  } catch (error) {
    if (error.status === 401 || /user not found/i.test(error.message))
      throw new APIError(
        "OpenRouter recusou a API key (401 / User not found). Use /connect openrouter e informe uma chave válida de https://openrouter.ai/settings/keys.",
        401,
      );
    throw error;
  }
}
