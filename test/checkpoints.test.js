import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { ToolRunner, rewindFiles } from "../src/tools.js";
import {
  createCheckpoint,
  recordChange,
  snapshotFiles,
} from "../src/checkpoints.js";
import { newSession } from "../src/store.js";
import { temp, fixture, chatReply, sseResponse } from "./helpers.js";

function command(code) {
  return `node -e "${code.replaceAll('"', '\\"')}"`;
}

test("Snapshots do not follow an approved root replaced by a symlink", async (t) => {
  const base = await temp(t);
  const root = path.join(base, "approved");
  const foreign = path.join(base, "foreign");
  await mkdir(root);
  await mkdir(foreign);
  await writeFile(path.join(foreign, "private"), "secret");
  await rename(root, path.join(base, "old"));
  await symlink(
    foreign,
    root,
    process.platform === "win32" ? "junction" : "dir",
  );
  const snapshot = await snapshotFiles([root]);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.files.size, 0);
  assert.match(snapshot.issues[0], /alterada/);
});

test("Shell snapshots restore edits, deletions and binary files, including failed commands", async (t) => {
  const cwd = await temp(t);
  const changes = [];
  await writeFile(path.join(cwd, "edit.txt"), "original");
  await writeFile(path.join(cwd, "remove.txt"), "keep");
  await writeFile(path.join(cwd, "image.bin"), Buffer.from([0, 255, 1]));
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    onChange: (c) => changes.push(c),
  });
  const result = await runner.execute({
    name: "shell",
    arguments: {
      command: command(
        "const fs=require('fs');fs.writeFileSync('edit.txt','changed');fs.unlinkSync('remove.txt');fs.writeFileSync('image.bin',Buffer.from([3,0,4]));fs.writeFileSync('new.txt','new');process.exit(2)",
      ),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.checkpoint.files, 4);
  assert.equal(result.checkpoint.complete, true);
  await rewindFiles(changes, cwd);
  assert.equal(await readFile(path.join(cwd, "edit.txt"), "utf8"), "original");
  assert.equal(await readFile(path.join(cwd, "remove.txt"), "utf8"), "keep");
  assert.deepEqual(
    await readFile(path.join(cwd, "image.bin")),
    Buffer.from([0, 255, 1]),
  );
  await assert.rejects(readFile(path.join(cwd, "new.txt")), { code: "ENOENT" });
});

test("Mixed file tools and shell changes merge into one reversible checkpoint", async (t) => {
  const cwd = await temp(t);
  const session = newSession(cwd, null);
  const checkpoint = createCheckpoint(session, "mixed");
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    onChange: (c) => recordChange(checkpoint, c),
  });
  await writeFile(path.join(cwd, "file.txt"), "original");
  await runner.execute({
    name: "write_file",
    arguments: { path: "file.txt", content: "first" },
  });
  await runner.execute({
    name: "shell",
    arguments: {
      command: command("require('fs').writeFileSync('file.txt','second')"),
    },
  });
  await runner.execute({
    name: "edit_file",
    arguments: { path: "file.txt", old_text: "second", new_text: "last" },
  });
  assert.equal(checkpoint.changes.length, 1);
  await rewindFiles(checkpoint.changes, cwd);
  assert.equal(await readFile(path.join(cwd, "file.txt"), "utf8"), "original");
});

test("Rewind validates every captured file before overwriting any manual change", async (t) => {
  const cwd = await temp(t);
  const changes = [];
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    onChange: (c) => changes.push(c),
  });
  await writeFile(path.join(cwd, "one"), "before");
  await writeFile(path.join(cwd, "two"), "before");
  await runner.execute({
    name: "shell",
    arguments: {
      command: command(
        "const fs=require('fs');fs.writeFileSync('one','after');fs.writeFileSync('two','after')",
      ),
    },
  });
  await writeFile(path.join(cwd, "two"), "manual");
  await assert.rejects(rewindFiles(changes, cwd), /mudou/);
  assert.equal(await readFile(path.join(cwd, "one"), "utf8"), "after");
  assert.equal(await readFile(path.join(cwd, "two"), "utf8"), "manual");
});

test("Shell cancellation still records completed file changes", async (t) => {
  const cwd = await temp(t);
  const changes = [];
  const controller = new AbortController();
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    onChange: (c) => changes.push(c),
  });
  const pending = runner.execute(
    {
      name: "shell",
      arguments: {
        command: command(
          "require('fs').writeFileSync('created','done');setTimeout(()=>{},30000)",
        ),
        timeout_ms: 5000,
      },
    },
    controller.signal,
  );
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(path.join(cwd, "created"));
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  controller.abort(new Error("cancelled"));
  await pending;
  assert.equal(changes.length, 1);
  await rewindFiles(changes, cwd);
  await assert.rejects(readFile(path.join(cwd, "created")), { code: "ENOENT" });
});

test("Snapshot limits and exclusions are explicit and never turn omitted existing files into creations", async (t) => {
  const cwd = await temp(t);
  const changes = [];
  await writeFile(path.join(cwd, "large"), "xxxxxxxxxx");
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "node_modules", "dep"), "original");
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    snapshotOptions: { maxFileBytes: 5 },
    onChange: (c) => changes.push(c),
  });
  const result = await runner.execute({
    name: "shell",
    arguments: {
      command: command(
        "const fs=require('fs');fs.writeFileSync('large','x');fs.writeFileSync('small','ok');fs.writeFileSync('node_modules/dep','edited')",
      ),
    },
  });
  assert.equal(result.checkpoint.skipped, 1);
  assert.ok(result.checkpoint.exclusions.includes("node_modules"));
  assert.equal(changes.length, 1);
  assert.equal(path.basename(changes[0].path), "small");
  await rewindFiles(changes, cwd);
  assert.equal(await readFile(path.join(cwd, "large"), "utf8"), "x");
});

test("Agent shell checkpoints survive persistence and carry coverage metadata", async (t) => {
  const f = await fixture(t, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return sseResponse(
        chatReply(
          body.messages.at(-1).content.includes("MICROCODE_TOOL_RESULTS")
            ? "Done"
            : "```microcode_tool\n" +
                JSON.stringify({
                  name: "shell",
                  arguments: {
                    command: command(
                      "require('fs').writeFileSync('agent.txt','saved')",
                    ),
                  },
                }) +
                "\n```",
        ),
      );
    },
  });
  await f.agent.run("Create a file", undefined);
  const stored = await f.store.loadSession(f.session.id, f.cwd);
  const checkpoint = stored.checkpoints[0];
  assert.equal(checkpoint.shellCoverage[0].files, 1);
  assert.equal(checkpoint.changes[0].encoding, "base64");
  await rewindFiles(checkpoint.changes, f.cwd);
  await assert.rejects(readFile(path.join(f.cwd, "agent.txt")), {
    code: "ENOENT",
  });
});
