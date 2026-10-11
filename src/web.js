import { VERSION } from "./version.js";

const WEB_AGENT = `MicroCode/${VERSION} (+https://github.com/douglas541/MicroCode)`;
const MAX_BYTES = 2 * 1024 * 1024;
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  laquo: "«",
  raquo: "»",
  eacute: "é",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  atilde: "ã",
  otilde: "õ",
  ccedil: "ç",
};

export function decodeEntities(text) {
  return String(text).replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (match, entity) => {
      if (entity[0] !== "#") return ENTITIES[entity] ?? match;
      const n =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : "�";
    },
  );
}

function attributes(text) {
  const result = {};
  for (const match of text.matchAll(
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  ))
    result[match[1].toLowerCase()] = decodeEntities(
      match[2] ?? match[3] ?? match[4],
    );
  return result;
}

const plain = (text) =>
  decodeEntities(
    String(text)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:)])/g, "$1")
    .trim();

export function webUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error("URL inválida. Informe um endereço http:// ou https://.");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("web_fetch aceita somente URLs HTTP e HTTPS.");
  if (url.username || url.password)
    throw new Error("URLs com credenciais embutidas não são aceitas.");
  return url;
}

async function limitedBody(response, maxBytes) {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        if (remaining > 0)
          chunks.push(Buffer.from(value.subarray(0, remaining)));
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

function decodeBody(buffer, contentType) {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(
    buffer.subarray(0, 4096).toString("ascii"),
  )?.[1];
  try {
    return new TextDecoder(declared || meta || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder().decode(buffer);
  }
}

export async function readWeb(
  url,
  {
    signal,
    timeoutMs = 30000,
    maxBytes = MAX_BYTES,
    maxRedirects = 5,
    fetchImpl = fetch,
  } = {},
) {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  let current = webUrl(url);
  const visited = new Set();
  try {
    for (let redirects = 0; ; redirects++) {
      deadline.throwIfAborted();
      if (visited.has(current.href))
        throw new Error("Loop de redirecionamento detectado.");
      visited.add(current.href);
      const response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": WEB_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
        },
        signal: deadline,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        if (redirects >= maxRedirects)
          throw new Error("Limite de redirecionamentos HTTP excedido.");
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirecionamento HTTP sem Location.");
        current = webUrl(location, current.href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const hint = response.headers.get("retry-after");
        throw new Error(
          `HTTP ${response.status} ao acessar ${current.hostname}${hint ? " · Retry-After: " + hint : ""}.`,
        );
      }
      const contentType = response.headers.get("content-type") || "";
      if (
        contentType &&
        !/^(?:text\/(?!event-stream)|application\/(?:json|[\w.-]+\+json|xml|[\w.-]+\+xml|javascript))/i.test(
          contentType,
        )
      ) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `Conteúdo ${contentType.split(";")[0]} não é textual. PDF, imagens e downloads binários não são lidos por web_fetch.`,
        );
      }
      const body = await limitedBody(response, maxBytes);
      const text = decodeBody(body.buffer, contentType);
      if (text.includes("\0"))
        throw new Error("Conteúdo binário não suportado por web_fetch.");
      return {
        url: current.href,
        status: response.status,
        contentType,
        text,
        bytesRead: body.buffer.length,
        truncated: body.truncated,
      };
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted)
      throw new Error(
        `Tempo limite de ${(timeoutMs / 1000).toFixed(1)}s excedido ao acessar a página.`,
      );
    throw error;
  }
}

function mainHtml(html) {
  for (const kind of ["main", "article", "named"]) {
    for (const opening of html.matchAll(
      /<(main|article|div|section)\b([^>]*)>/gi,
    )) {
      const tag = opening[1].toLowerCase();
      const attrs = attributes(opening[2]);
      if (
        kind === "named"
          ? !/^(?:apicontent|main-content|maincontent|content-main|main)$/i.test(
              attrs.id || "",
            ) && attrs.role !== "main"
          : tag !== kind
      )
        continue;
      const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
      tokens.lastIndex = opening.index + opening[0].length;
      const start = tokens.lastIndex;
      let depth = 1;
      let end = html.length;
      let token;
      while ((token = tokens.exec(html))) {
        depth += token[0].startsWith("</") ? -1 : 1;
        if (!depth) {
          end = token.index;
          break;
        }
      }
      const body = html.slice(start, end);
      if (plain(body)) return body;
    }
  }
  return html;
}

export function htmlToReadable(html, url, format = "markdown") {
  const title = plain(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "",
  );
  let content = mainHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(
        /<(script|style|noscript|template|svg|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        "",
      ),
  );
  const blocks = [];
  const links = [];
  const placeholder = (value) => {
    const i = blocks.push(value) - 1;
    return `\uE000WEB_${i}\uE001`;
  };
  content = content.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, code) => {
      const alternatives = [
        ...code.matchAll(/<code\b([^>]*)>([\s\S]*?)<\/code>/gi),
      ];
      const examples = alternatives.length
        ? alternatives.map((match) => ({ attrs: match[1], text: match[2] }))
        : [
            {
              attrs: "",
              text: code.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, ""),
            },
          ];
      return (
        "\n\n" +
        examples
          .map((example) => {
            const language =
              /(?:language-|lang-)([\w+-]+)/i.exec(example.attrs)?.[1] || "";
            const text = decodeEntities(
              example.text
                .replace(/<br\s*\/?\s*>/gi, "\n")
                .replace(/<[^>]+>/g, ""),
            ).trim();
            const fence = "`".repeat(
              Math.max(2, ...(text.match(/`+/g) || []).map((s) => s.length)) +
                1,
            );
            return placeholder(
              format === "markdown"
                ? `${fence}${language}\n${text}\n${fence}`
                : text,
            );
          })
          .join("\n\n") +
        "\n\n"
      );
    },
  );
  content = content.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, code) => {
      const text = plain(code);
      const fence = "`".repeat(
        Math.max(0, ...(text.match(/`+/g) || []).map((s) => s.length)) + 1,
      );
      return placeholder(format === "markdown" ? fence + text + fence : text);
    },
  );
  content = content.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, attrs, inner) => {
      const text = plain(inner);
      const href = attributes(attrs).href;
      if (!href || !text) return text;
      let target;
      try {
        target = webUrl(href, url).href;
      } catch {
        return text;
      }
      if (links.length < 50 && !links.some((link) => link.url === target))
        links.push({ text, url: target });
      return format === "markdown"
        ? `[${text.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${target.replaceAll("(", "%28").replaceAll(")", "%29")})`
        : `${text} (${target})`;
    },
  );
  content = content
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level, inner) =>
        `\n\n${format === "markdown" ? "#".repeat(Number(level)) + " " : ""}${inner}\n\n`,
    )
    .replace(/<img\b([^>]*)>/gi, (_match, attrs) => attributes(attrs).alt || "")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) =>
      format === "markdown" ? "**" + text + "**" : text,
    )
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) =>
      format === "markdown" ? "*" + text + "*" : text,
    )
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(
      /<\/?(?:p|div|section|article|main|header|footer|ul|ol|blockquote|table|tr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]*>/g, "");
  content = decodeEntities(content)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  content = content.replace(
    /\uE000WEB_(\d+)\uE001/g,
    (_match, i) => blocks[Number(i)] || "",
  );
  return { title, content, links };
}

export async function webFetch(args, { signal, fetchImpl = fetch } = {}) {
  const maxChars = args.max_chars ?? 20000;
  const format = args.format || "markdown";
  const page = await readWeb(args.url, {
    signal,
    fetchImpl,
    timeoutMs: args.timeout_ms ?? 30000,
  });
  const html =
    /html/i.test(page.contentType) ||
    /^\s*(?:<!doctype html|<html|<head|<body|<main|<article)/i.test(page.text);
  const extracted = html
    ? htmlToReadable(page.text, page.url, format)
    : { title: "", content: page.text, links: [] };
  if (!extracted.content.trim())
    throw new Error(
      "A página não tem texto extraível; pode exigir JavaScript ou login.",
    );
  return {
    ok: true,
    source: "web",
    untrusted: true,
    url: page.url,
    title: extracted.title || page.url,
    status: page.status,
    contentType: page.contentType,
    format,
    content: extracted.content.slice(0, maxChars),
    links: extracted.links,
    truncated: page.truncated || extracted.content.length > maxChars,
    bytesRead: page.bytesRead,
    fetchedAt: new Date().toISOString(),
  };
}

function resultUrl(href, base) {
  let url;
  try {
    url = webUrl(href, base);
  } catch {
    return null;
  }
  const destination = url.searchParams.get("uddg");
  if (destination && /(?:^|\.)duckduckgo\.com$/i.test(url.hostname)) {
    try {
      url = webUrl(destination);
    } catch {
      return null;
    }
  }
  if (
    (/(?:^|\.)duckduckgo\.com$/i.test(url.hostname) &&
      /^\/(?:l\/|y\.js|html\/|lite\/)/i.test(url.pathname)) ||
    (/(?:^|\.)bing\.com$/i.test(url.hostname) &&
      /^\/search(?:\/|$)/i.test(url.pathname))
  )
    return null;
  return url.href;
}

export function parseSearch(html, engine, base) {
  const results = [];
  if (engine === "bing") {
    for (const match of html.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const get = (tag) =>
        plain(
          new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(
            match[1],
          )?.[1] || "",
        );
      const url = resultUrl(get("link"), base);
      const title = get("title");
      if (url && title)
        results.push({
          title,
          url,
          snippet: get("description").slice(0, 1000),
        });
    }
    return { results, valid: /<rss\b/i.test(html), blocked: false };
  }
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(
    (match) =>
      /(?:^|\s)(?:result__a|result-link)(?:\s|$)/.test(
        attributes(match[1]).class || "",
      ),
  );
  for (const [i, match] of anchors.entries()) {
    const url = resultUrl(attributes(match[1]).href, base);
    const title = plain(match[2]);
    const tail = html.slice(
      match.index + match[0].length,
      anchors[i + 1]?.index ?? html.length,
    );
    const snippet =
      /class\s*=\s*["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(
        tail,
      )?.[1] || "";
    if (url && title)
      results.push({ title, url, snippet: plain(snippet).slice(0, 1000) });
  }
  return {
    results,
    valid: Boolean(anchors.length || /no-results|no results found/i.test(html)),
    blocked: /anomaly-modal|challenge-form|bots use DuckDuckGo/i.test(html),
  };
}

export async function webSearch(args, { signal, fetchImpl = fetch } = {}) {
  const query = args.query.trim();
  const limit = args.limit ?? 5;
  const timeoutMs = args.timeout_ms ?? 20000;
  if (!query || query.length > 1000)
    throw new Error("A busca deve ter entre 1 e 1000 caracteres.");
  const deadline = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const failures = [];
  for (const [engine, base] of [
    ["duckduckgo", "https://html.duckduckgo.com/html/"],
    ["bing", "https://www.bing.com/search"],
  ]) {
    const url = new URL(base);
    url.searchParams.set("q", query);
    if (engine === "bing") url.searchParams.set("format", "rss");
    try {
      const page = await readWeb(url.href, {
        signal: deadline,
        fetchImpl,
        timeoutMs,
        maxBytes: 512 * 1024,
      });
      const parsed = parseSearch(page.text, engine, page.url);
      if (parsed.blocked)
        throw new Error("O buscador retornou um desafio anti-bot.");
      if (!parsed.valid)
        throw new Error("Formato de resultados não reconhecido.");
      const seen = new Set();
      const results = parsed.results
        .filter((item) => {
          if (seen.has(item.url)) return false;
          seen.add(item.url);
          return true;
        })
        .slice(0, limit);
      return {
        ok: true,
        source: "web",
        untrusted: true,
        query,
        provider: engine,
        results,
        totalReturned: results.length,
        searchedAt: new Date().toISOString(),
        ...(failures.length ? { fallback: true, warnings: failures } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      failures.push(`${engine}: ${error.message}`);
      if (deadline.aborted) break;
    }
  }
  throw new Error("Busca web indisponível. " + failures.join(" | "));
}
