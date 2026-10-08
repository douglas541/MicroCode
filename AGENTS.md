# MicroCode — development guide

MicroCode is a terminal coding agent, written in JavaScript ESM for Node.js 22+.

- Keep the runtime dependency-free and cross-platform (cmd.exe on Windows, /bin/sh on POSIX).
- `src/agent.js`: inference/tool loop, side questions and compaction.
- `src/protocols.js`: Chat Completions, Messages, Responses and Gemini wire adapters.
- `src/text-tools.js`: reserved text tool protocol; ordinary code blocks must remain inert.
- `src/tools.js`: shared tool schemas/executors, permissions, paths and checkpoints.
- `src/providers.js`: public catalogs, capability detection and prices in USD/1M tokens.
- `src/store.js`: local settings, credentials, catalog cache and sessions.
- `src/cli.js`, `src/ui.js`: commands and terminal presentation.
- Never send native tools or tool-choice fields when operating in text mode.
- Preserve tool call/result pairing in histories, including cancellation and compaction.
- Never treat absent pricing as zero or unknown tool support as confirmed support.
- `/btw` must not append anything to the main conversation or execute tools.
- Keep branded interface and documentation specific to MicroCode.
- Use pnpm 12.10.1 (pinned in `package.json`) and keep `pnpm-lock.yaml` in sync.
- Verify changes with `pnpm check` and `pnpm test`.
- Tests use fake credentials/local HTTP APIs, never paid external inference.
