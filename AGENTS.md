# MicroCode — development guide

MicroCode is a terminal coding agent, written in JavaScript ESM for Node.js 22+.

- Keep the runtime dependency-free and cross-platform (cmd.exe on Windows, /bin/sh on POSIX).
- `src/agent.js`: inference/tool loop, side questions and compaction.
- `src/protocols.js`: Chat Completions, Messages, Responses and Gemini wire adapters.
- `src/text-tools.js`: reserved text tool protocol; ordinary code blocks must remain inert.
- `src/tools.js`: shared tool schemas/executors, permissions, paths and checkpoints.
- `src/web.js`: bounded HTTP reading, readable page extraction and keyless search.
- External-directory requests must offer one-operation/session/deny choices at execution time; persist only session grants, using canonical paths.
- `src/providers.js`: public catalogs, capability detection and prices in USD/1M tokens.
- `src/store.js`: local settings, credentials, catalog cache and sessions.
- `src/cli.js`, `src/ui.js`: commands and terminal presentation.
- `src/project.js`: factual local project inspection and managed AGENTS.md block; preserve manual content and distinguish declared commands from actual execution.
- `src/memory.js`: bounded project-scoped notes in .microcode/memory.json; load into agent instructions and use normal permissions/checkpoints for edits.
- `src/diagnostics.js`: independent runtime/provider checks and checked shell output; public catalog access is not proof of authentication.
- `src/checkpoints.js`: bounded shell file snapshots and merged changes; never follow replaced authorized roots, symlinks or invent deletions from incomplete scans.
- Rewind may select an older checkpoint and restores all later captured changes; validate every file before writing, preserve costs and identify partial/legacy shell coverage.
- `src/terminal-footer.js`: persistent lower status area and content viewport; preserve cursor and scroll margins across prompts, alternate screens, resize and exit.
- `src/terminal-layout.js`: physical transcript rows at each terminal width; resize must coordinate transcript replay and overlay redraw rather than reuse old cursor offsets.
- `src/approval.js`: inline numbered approval cards. Tool edit grants are session-scoped; shell grants must match the exact command and canonical cwd.
- `src/commands.js`, `src/chat-input.js`: slash-command catalog and live autocomplete in the chat prompt; keep suggestions separate from approval choices.
- Show slash suggestions above the input line, preserve visible transcript when their height changes, and keep the lower status area to one/two rows; model tool support belongs in the model selector.
- Keep the bordered chat input visible after submission and throughout inference/tool execution. Scroll only the transcript above it; preserve background drafts and /btw input across status updates, dialogs and resize, without replaying UI frames into scrollback.
- `src/markdown.js`: terminal Markdown rendering; apply only to presentation, preserving raw responses in conversation history and code-block contents.
- User requests use a width-aware highlighted block on submission and history replay; preserve literal input, reset background per row, honor NO_COLOR and keep command echoes compact.
- Agent commentary with pending tool calls is a compact progress block; reserve the named assistant heading for final answers and align tool/result continuations across resize.
- `src/history.js`: session picker summaries and full visible conversation history; resume must replay history without executing tools, while compaction archives removed context.
- `/clear` must reset screen/visual transcript and input history as well as the session, so old output does not return after resize; preserve the prior saved conversation.
- Session deletion must confirm before unlinking only a session whose stored project root matches the active project.
- Never send native tools or tool-choice fields when operating in text mode.
- Preserve tool call/result pairing in histories, including cancellation and compaction.
- Never treat absent pricing as zero or unknown tool support as confirmed support.
- `/btw` must not append anything to the main conversation or execute tools.
- Keep branded interface and documentation specific to MicroCode.
- Always update the version for app changes prepared for release. `package.json.version` is the single source of truth for npm metadata and `src/version.js`; the banner, `--version` and HTTP user agents must match it. Never hardcode a separate app version. Automatic releases may advance the version in the runner, and tests must verify the current manifest version rather than a fixed release number.
- Use pnpm 12.10.1 (pinned in `package.json`) and keep `pnpm-lock.yaml` in sync.
- Verify changes with `pnpm check` and `pnpm test`.
- Tests use fake credentials/local HTTP APIs, never paid external inference.
