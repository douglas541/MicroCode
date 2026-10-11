import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, readFile, rename, symlink } from "node:fs/promises";
import { ToolRunner } from "../src/tools.js";
import { Application } from "../src/cli.js";
import { Store, newSession } from "../src/store.js";
import { Agent } from "../src/agent.js";
import { temp, server, chatReply } from "./helpers.js";

async function folders(t) {
  const root = await temp(t);
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(path.join(outside, "a.txt"), "external file");
  return { root, cwd, outside, file: path.join(outside, "a.txt") };
}

test("External access pauses for approval; one-operation permission is not retained", async (t) => {
  const { cwd, outside, file } = await folders(t);
  const requests = [];
  const runner = new ToolRunner({
    cwd,
    confirmDirectory: async (request) => {
      requests.push(request);
      return "once";
    },
  });
  const call = { name: "read_file", arguments: { path: file } };
  assert.equal((await runner.execute(call)).ok, true);
  assert.equal((await runner.execute(call)).ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].directory, outside);
  assert.equal(requests[0].tool, "read_file");
  assert.equal(runner.addedDirs.length, 0);
});

test("Session approval permits future reads and subdirectories without re-prompting", async (t) => {
  const { cwd, outside, file } = await folders(t);
  let asks = 0;
  const runner = new ToolRunner({
    cwd,
    confirmDirectory: async () => {
      asks++;
      return "session";
    },
  });
  assert.equal(
    (await runner.execute({ name: "read_file", arguments: { path: file } })).ok,
    true,
  );
  await mkdir(path.join(outside, "nested"));
  await writeFile(path.join(outside, "nested", "b.txt"), "nested");
  assert.equal(
    (
      await runner.execute({
        name: "read_file",
        arguments: { path: path.join(outside, "nested", "b.txt") },
      })
    ).ok,
    true,
  );
  assert.equal(asks, 1);
  assert.deepEqual(runner.addedDirs, [outside]);
});

test("Denied directories are not accessed and repeated attempts do not spam permission prompts", async (t) => {
  const { cwd, outside, file } = await folders(t);
  let asks = 0;
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    confirmDirectory: async () => {
      asks++;
      return "deny";
    },
  });
  const first = await runner.execute({
    name: "read_file",
    arguments: { path: file },
  });
  assert.equal(first.denied, true);
  assert.equal(first.content, undefined);
  const second = await runner.execute({
    name: "list_files",
    arguments: { path: outside },
  });
  assert.equal(second.denied, true);
  assert.equal(asks, 1);
  assert.equal(runner.addedDirs.length, 0);
});

test("Directory permission also supports external writes/new directories, list/search and shell cwd", async (t) => {
  const { cwd, outside } = await folders(t);
  const requested = [];
  const runner = new ToolRunner({
    cwd,
    permission: "auto",
    confirmDirectory: async (request) => {
      requested.push(request);
      return "once";
    },
  });
  const created = path.join(outside, "new", "a.txt");
  assert.equal(
    (
      await runner.execute({
        name: "write_file",
        arguments: { path: created, content: "created" },
      })
    ).ok,
    true,
  );
  assert.equal(await readFile(created, "utf8"), "created");
  assert.equal(
    (await runner.execute({ name: "list_files", arguments: { path: outside } }))
      .ok,
    true,
  );
  assert.equal(
    (
      await runner.execute({
        name: "search",
        arguments: { path: outside, query: "created" },
      })
    ).matches.length,
    1,
  );
  const shell = await runner.execute({
    name: "shell",
    arguments: {
      cwd: outside,
      command: 'node -e "console.log(process.cwd())"',
    },
  });
  assert.equal(shell.ok, true);
  assert.match(shell.stdout, /outside/);
  assert.equal(requested.length, 4);
});

test("Symlink escapes request approval for the actual target directory", async (t) => {
  const { cwd, outside } = await folders(t);
  const requested = [];
  await symlink(
    outside,
    path.join(cwd, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const runner = new ToolRunner({
    cwd,
    confirmDirectory: async (request) => {
      requested.push(request);
      return "once";
    },
  });
  assert.equal(
    (
      await runner.execute({
        name: "read_file",
        arguments: { path: "link/a.txt" },
      })
    ).ok,
    true,
  );
  assert.equal(requested[0].directory, outside);
  assert.equal(requested[0].reason, "symlink");
});

test("An approved directory replaced with a symlink cannot silently grant a different root", async (t) => {
  const { root, cwd, outside, file } = await folders(t);
  const other = path.join(root, "other");
  await mkdir(other);
  await writeFile(path.join(other, "a.txt"), "other");
  let asks = 0;
  const runner = new ToolRunner({
    cwd,
    confirmDirectory: async () => (++asks === 1 ? "session" : "deny"),
  });
  assert.equal(
    (await runner.execute({ name: "read_file", arguments: { path: file } })).ok,
    true,
  );
  await rename(outside, path.join(root, "original"));
  await symlink(
    other,
    outside,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await runner.execute({
    name: "read_file",
    arguments: { path: file },
  });
  assert.equal(result.denied, true);
  assert.equal(result.content, undefined);
  assert.equal(asks, 2);
});

test("Cancelling while waiting for directory approval stops before reading/writing", async (t) => {
  const { cwd, file } = await folders(t);
  const controller = new AbortController();
  const runner = new ToolRunner({
    cwd,
    confirmDirectory: async () => {
      controller.abort(new Error("cancelled"));
      return "session";
    },
  });
  await assert.rejects(
    runner.execute(
      { name: "read_file", arguments: { path: file } },
      controller.signal,
    ),
    /cancelled/,
  );
  assert.equal(runner.addedDirs.length, 0);
});

for (const native of [false, true])
  test(`External directory approval works during a ${native ? "native" : "text"} agent turn and survives resume`, async (t) => {
    const { cwd, outside, file, root } = await folders(t);
    const store = new Store(path.join(root, "home"));
    const config = await store.config();
    const session = newSession(cwd, { provider: "local", model: "demo" });
    let step = 0;
    let asks = 0;
    const gateway = await server(t, (body) => {
      if (!step++) {
        const call = { name: "read_file", arguments: { path: file } };
        return native
          ? chatReply("", [call])
          : chatReply("```microcode_tool\n" + JSON.stringify(call) + "\n```");
      }
      assert.match(JSON.stringify(body.messages), /external file/);
      return chatReply("Arquivo externo lido.");
    });
    const ui = {
      confirmDirectory: async () => {
        asks++;
        return "session";
      },
      confirm: async () => true,
      tool() {},
      notice() {},
      print() {},
    };
    const app = new Application({ cwd, store, config, session, ui });
    const runner = app.runner();
    const agent = new Agent({
      provider: { baseURL: gateway.url },
      model: {
        id: "demo",
        protocol: "chat",
        nativeTools: native,
        context: 64000,
      },
      key: "test-key",
      config,
      session,
      runner,
      store,
    });
    assert.equal(
      await agent.run("Leia o arquivo fora do projeto"),
      "Arquivo externo lido.",
    );
    assert.equal(asks, 1);
    assert.deepEqual((await store.loadSession(session.id, cwd)).addedDirs, [
      outside,
    ]);
    const restored = await store.loadSession(session.id, cwd);
    app.session = restored;
    assert.equal(
      (
        await app
          .runner()
          .execute({ name: "read_file", arguments: { path: file } })
      ).ok,
      true,
    );
    assert.equal(asks, 1);
  });
