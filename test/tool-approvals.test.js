import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { ToolRunner } from "../src/tools.js";
import { Application } from "../src/cli.js";
import { Store, newSession } from "../src/store.js";
import { temp } from "./helpers.js";
import { fixture, server, chatReply } from "./helpers.js";

test("One-time tool approval executes exactly once and asks again for the next action", async (t) => {
  const cwd = await temp(t);
  let asks = 0;
  const runner = new ToolRunner({
    cwd,
    confirm: async () => {
      asks++;
      return "once";
    },
  });
  for (const content of ["first", "second"])
    assert.equal(
      (
        await runner.execute({
          name: "write_file",
          arguments: { path: "a.txt", content },
        })
      ).ok,
      true,
    );
  assert.equal(asks, 2);
  assert.equal(runner.approvals.edits, false);
  assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "second");
});

test("A session edit grant covers write/edit tools but does not authorize shell or external directories", async (t) => {
  const root = await temp(t);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  let asks = 0;
  let dirs = 0;
  const runner = new ToolRunner({
    cwd,
    confirm: async () => (++asks === 1 ? "session" : "deny"),
    confirmDirectory: async () => {
      dirs++;
      return "deny";
    },
  });
  assert.equal(
    (
      await runner.execute({
        name: "write_file",
        arguments: { path: "a.txt", content: "before" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await runner.execute({
        name: "edit_file",
        arguments: { path: "a.txt", old_text: "before", new_text: "after" },
      })
    ).ok,
    true,
  );
  assert.equal(asks, 1);
  assert.equal(
    (
      await runner.execute({
        name: "shell",
        arguments: { command: "node --version" },
      })
    ).denied,
    true,
  );
  assert.equal(asks, 2);
  const external = await runner.execute({
    name: "write_file",
    arguments: { path: path.join(root, "external.txt"), content: "denied" },
  });
  assert.equal(external.denied, true);
  assert.equal(dirs, 1);
  await assert.rejects(readFile(path.join(root, "external.txt")), {
    code: "ENOENT",
  });
});

test("Shell session approval applies only to the identical command and canonical working directory", async (t) => {
  const cwd = await temp(t);
  await mkdir(path.join(cwd, "sub"));
  let asks = 0;
  const runner = new ToolRunner({
    cwd,
    confirm: async (_call, _signal, context) => {
      assert.ok(context.cwd);
      return ++asks === 1 ? "session" : "deny";
    },
  });
  const command = 'node -e "console.log(123)"';
  assert.equal(
    (await runner.execute({ name: "shell", arguments: { command } })).ok,
    true,
  );
  assert.equal(
    (await runner.execute({ name: "shell", arguments: { command, cwd: "." } }))
      .ok,
    true,
  );
  assert.equal(asks, 1);
  assert.equal(
    (
      await runner.execute({
        name: "shell",
        arguments: { command: command + " && node --version" },
      })
    ).denied,
    true,
  );
  assert.equal(
    (
      await runner.execute({
        name: "shell",
        arguments: { command, cwd: "sub" },
      })
    ).denied,
    true,
  );
  assert.equal(asks, 3);
  assert.equal(runner.approvals.shell.length, 1);
});

test("Explicit deny strings do not become truthy approvals; cancellation prevents the mutation", async (t) => {
  const cwd = await temp(t);
  const runner = new ToolRunner({ cwd, confirm: async () => "deny" });
  assert.equal(
    (
      await runner.execute({
        name: "write_file",
        arguments: { path: "a", content: "x" },
      })
    ).denied,
    true,
  );
  await assert.rejects(readFile(path.join(cwd, "a")), { code: "ENOENT" });
  const controller = new AbortController();
  runner.confirm = async () => {
    controller.abort(new Error("cancelled"));
    return "session";
  };
  await assert.rejects(
    runner.execute(
      { name: "write_file", arguments: { path: "b", content: "x" } },
      controller.signal,
    ),
    /cancelled/,
  );
  assert.equal(runner.approvals.edits, false);
  await assert.rejects(readFile(path.join(cwd, "b")), { code: "ENOENT" });
});

test("Session tool approvals survive resume, remain read-only in plan mode and can be revoked", async (t) => {
  const root = await temp(t);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const store = new Store(path.join(root, "home"));
  const config = await store.config();
  let asks = 0;
  const ui = {
    confirm: async () => {
      asks++;
      return "session";
    },
    tool() {},
    print() {},
    notice() {},
    confirmDirectory: async () => "deny",
  };
  const app = new Application({
    cwd,
    store,
    config,
    session: newSession(cwd, null),
    ui,
  });
  assert.equal(
    (
      await app.runner().execute({
        name: "write_file",
        arguments: { path: "a", content: "first" },
      })
    ).ok,
    true,
  );
  assert.equal(asks, 1);
  app.session = await store.loadSession(app.session.id, cwd);
  assert.equal(app.session.toolApprovals.edits, true);
  assert.equal(
    (
      await app.runner().execute({
        name: "write_file",
        arguments: { path: "a", content: "second" },
      })
    ).ok,
    true,
  );
  assert.equal(asks, 1);
  app.session.plan = true;
  assert.equal(
    (
      await app.runner().execute({
        name: "write_file",
        arguments: { path: "a", content: "blocked" },
      })
    ).ok,
    false,
  );
  app.session.plan = false;
  app.session.addedDirs.push(root);
  await app.command("/permissions reset");
  assert.equal(app.session.toolApprovals.edits, false);
  assert.deepEqual(app.session.addedDirs, []);
  assert.equal(config.permission, "ask");
  await app.runner().execute({
    name: "write_file",
    arguments: { path: "a", content: "third" },
  });
  assert.equal(asks, 2);
});

for (const native of [false, true])
  test(`A single session approval covers later edits during a ${native ? "native" : "text"} agent turn`, async (t) => {
    let step = 0;
    let confirmations = 0;
    const calls = [
      { name: "write_file", arguments: { path: "a.txt", content: "before" } },
      {
        name: "edit_file",
        arguments: { path: "a.txt", old_text: "before", new_text: "after" },
      },
    ];
    const gateway = await server(t, () => {
      if (step < calls.length) {
        const call = calls[step++];
        return native
          ? chatReply("", [call])
          : chatReply("```microcode_tool\n" + JSON.stringify(call) + "\n```");
      }
      return chatReply("Edições concluídas.");
    });
    const { agent, session, cwd, config, store } = await fixture(t, {
      native,
      url: gateway.url,
    });
    config.permission = "ask";
    const ui = {
      confirm: async () => {
        confirmations++;
        return "session";
      },
      tool() {},
      print() {},
      notice() {},
    };
    const app = new Application({ cwd, config, store, session, ui });
    agent.runner = app.runner();
    assert.equal(
      await agent.run("Crie e edite o arquivo"),
      "Edições concluídas.",
    );
    assert.equal(confirmations, 1);
    assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "after");
    assert.equal(
      (await store.loadSession(session.id, cwd)).toolApprovals.edits,
      true,
    );
  });
