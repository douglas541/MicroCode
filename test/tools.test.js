import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import {
  ToolRunner,
  rewindFiles,
  allowedPath,
  runShell,
} from "../src/tools.js";
import { temp } from "./helpers.js";

test("Filesystem tools create/read/edit/search and rewind actual files", async (t) => {
  const cwd = await temp(t);
  const changes = [];
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    onChange: (c) => changes.push(c),
  });
  assert.equal(
    (
      await runner.execute({
        name: "write_file",
        arguments: {
          path: "src/a.js",
          content: "const a = 1;\nconst b = 1;\n",
        },
      })
    ).ok,
    true,
  );
  const read = await runner.execute({
    name: "read_file",
    arguments: { path: "src/a.js", offset: 2, limit: 1 },
  });
  assert.match(read.content, /2: const b/);
  const ambiguous = await runner.execute({
    name: "edit_file",
    arguments: { path: "src/a.js", old_text: "1", new_text: "2" },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(
    (
      await runner.execute({
        name: "edit_file",
        arguments: {
          path: "src/a.js",
          old_text: "1",
          new_text: "2",
          replace_all: true,
        },
      })
    ).ok,
    true,
  );
  const search = await runner.execute({
    name: "search",
    arguments: { query: "const", pattern: "**/*.js" },
  });
  assert.equal(search.matches.length, 2);
  const list = await runner.execute({
    name: "list_files",
    arguments: { pattern: "**/*.js" },
  });
  assert.deepEqual(list.entries, ["src/a.js"]);
  await rewindFiles([{ ...changes[0], after: changes.at(-1).after }], cwd);
  await assert.rejects(readFile(path.join(cwd, "src/a.js")), {
    code: "ENOENT",
  });
});

test("Permissions and plan mode prevent mutations; argument schema is enforced", async (t) => {
  const cwd = await temp(t);
  const runner = new ToolRunner({ cwd, confirm: async () => false });
  assert.equal(
    (
      await runner.execute({
        name: "write_file",
        arguments: { path: "a", content: "x" },
      })
    ).denied,
    true,
  );
  assert.equal(
    (
      await runner.execute({
        name: "read_file",
        arguments: { path: "a", offset: -1 },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await runner.execute({ name: "shell", arguments: { command: 1 } })).ok,
    false,
  );
  assert.equal(
    (await runner.execute({ name: "unknown", arguments: {} })).ok,
    false,
  );
  const plan = new ToolRunner({ cwd, permission: "auto", plan: true });
  assert.ok(!plan.definitions().some((d) => d.name === "shell"));
  assert.equal(
    (
      await plan.execute({
        name: "shell",
        arguments: { command: "echo dangerous" },
      })
    ).ok,
    false,
  );
});

test("Traversal and symlink escapes are rejected, explicit added roots work", async (t) => {
  const root = await temp(t);
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await assert.rejects(allowedPath(cwd, "../outside/new.txt"), /fora/);
  await symlink(
    outside,
    path.join(cwd, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(allowedPath(cwd, "link/new/sub.txt"), /Symlink/);
  assert.equal(
    await allowedPath(cwd, "../outside/new.txt", [outside]),
    path.join(outside, "new.txt"),
  );
});

test("Rewind refuses to overwrite subsequent manual edits", async (t) => {
  const cwd = await temp(t);
  const file = path.join(cwd, "a.txt");
  await writeFile(file, "manual");
  await assert.rejects(
    rewindFiles([{ path: file, before: "before", after: "agent" }], cwd),
    /mudou/,
  );
  assert.equal(await readFile(file, "utf8"), "manual");
});

test("Shell captures stdout/stderr and nonzero exit codes", async (t) => {
  const cwd = await temp(t);
  const result = await runShell(
    'node -e "console.log(123); console.error(456); process.exit(2)"',
    { cwd },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /123/);
  assert.match(result.stderr, /456/);
});

test("Shell timeout terminates the process tree", async (t) => {
  const cwd = await temp(t);
  const start = Date.now();
  const result = await runShell('node -e "setTimeout(()=>{},30000)"', {
    cwd,
    timeout: 200,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - start < 10000);
});

test("Shell cancellation terminates execution", async (t) => {
  const cwd = await temp(t);
  const controller = new AbortController();
  const pending = runShell('node -e "setTimeout(()=>{},30000)"', {
    cwd,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);
  assert.equal((await pending).aborted, true);
});
