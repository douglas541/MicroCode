import test from "node:test";
import assert from "node:assert/strict";
import { styledRows } from "../src/terminal-layout.js";
import { stripAnsi, visibleWidth } from "../src/markdown.js";

test("Transcript physical rows preserve SGR styles while adapting to width and Unicode", () => {
  const rows = styledRows("\x1b[1mabc 🌱 defghi\x1b[0m", 6);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => visibleWidth(row) <= 6));
  assert.equal(rows.map(stripAnsi).join(""), "abc 🌱 defghi");
  assert.match(rows[0], /\x1b\[1m/);
});

test("Cursor escape sequences are excluded from logical transcript replay", () => {
  const rows = styledRows("before\x1b[2Jafter\nnext", 20);
  assert.deepEqual(rows, ["beforeafter", "next"]);
});
