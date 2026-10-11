import test from "node:test";
import assert from "node:assert/strict";
import { ChatInputState } from "../src/chat-input.js";
import { COMMAND_DEFINITIONS } from "../src/commands.js";

test("Slash suggestions use the complete command catalog, filter by prefix and favor exact matches", () => {
  const state = new ChatInputState();
  state.key("/", {});
  assert.equal(state.matches.length, COMMAND_DEFINITIONS.length);
  assert.ok(state.matches.every((c) => c.description));
  state.key("mod", {});
  assert.deepEqual(
    state.matches.map((c) => c.name),
    ["/models", "/model"],
  );
  state.key("el", {});
  assert.equal(state.matches[0].name, "/model");
});

test("Tab completes without submitting, and Enter dispatches optional-argument commands", () => {
  const state = new ChatInputState();
  state.key("/sta", {});
  assert.equal(state.key("", { name: "tab" }), null);
  assert.equal(state.text, "/status ");
  assert.equal(state.matches.length, 0);
  assert.equal(state.key("", { name: "return" }).value, "/status ");
});

test("Required-argument commands insert space and wait for user text", () => {
  for (const command of ["/btw", "/rename", "/add-dir"]) {
    const state = new ChatInputState();
    state.key(command, {});
    assert.equal(state.key("", { name: "return" }), null);
    assert.equal(state.text, command + " ");
    state.key("argument", {});
    assert.equal(
      state.key("", { name: "return" }).value,
      command + " argument",
    );
  }
});

test("Escape dismisses suggestions, further editing reopens them, and bare slash does not call a model", () => {
  const state = new ChatInputState();
  state.key("/", {});
  state.key("", { name: "escape" });
  assert.equal(state.matches.length, 0);
  assert.equal(state.key("", { name: "return" }), null);
  assert.equal(state.text, "");
  state.key("/mod", {});
  state.key("", { name: "escape" });
  state.key("e", {});
  assert.equal(state.matches.length, 2);
});

test("History navigation does not get trapped by slash suggestions and preserves the current draft", () => {
  const state = new ChatInputState({
    history: ["/status", "/help", "older message"],
  });
  state.key("draft", {});
  state.key("", { name: "up" });
  assert.equal(state.text, "/status");
  assert.equal(state.matches.length, 0);
  state.key("", { name: "up" });
  assert.equal(state.text, "/help");
  state.key("", { name: "down" });
  state.key("", { name: "down" });
  assert.equal(state.text, "draft");
});

test("Multiline bracketed paste is retained as one prompt; Unicode and cursor edits remain intact", () => {
  const state = new ChatInputState();
  state.key("", { name: "paste-start" });
  state.key("olá 🌱", {});
  state.key("", { name: "return" });
  state.key("segunda linha", {});
  state.key("", { name: "paste-end" });
  assert.equal(
    state.key("", { name: "return" }).value,
    "olá 🌱\nsegunda linha",
  );
  const edit = new ChatInputState();
  edit.key("ab", {});
  edit.key("", { name: "left" });
  edit.key("🌱", {});
  assert.equal(edit.text, "a🌱b");
  edit.key("", { name: "backspace" });
  assert.equal(edit.text, "ab");
});
