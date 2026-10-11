import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, chatReply, sseResponse } from "./helpers.js";
import { MEMORY_FILE, readMemory, editMemory } from "../src/memory.js";

test("Persistent notes reach inference requests, including later requests without modifying chat history", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.match(
        body.messages[0].content,
        /Always use the project formatter/,
      );
      calls++;
      return sseResponse(chatReply("Done"));
    },
  });
  await f.store.write(
    "memory.json",
    editMemory(
      { version: 1, entries: [] },
      "add",
      "Always use the project formatter.",
    ),
  );
  await f.agent.run("Inspect", undefined);
  const history = JSON.stringify(f.session.messages);
  await f.agent.btw("What convention applies?", undefined);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(f.session.messages), history);
});

test("Memory rejects corrupt files, ambiguous IDs and quota violations", async (t) => {
  const f = await fixture(t);
  await f.store.write("memory.json", { version: 1, entries: [null] });
  await assert.rejects(readMemory(f.cwd), /Entrada de memória inválida/);
  const data = {
    version: 1,
    entries: [
      { id: "abc1", text: "one" },
      { id: "abc2", text: "two" },
    ],
  };
  assert.throws(() => editMemory(data, "remove", "abc"), /ambiguidade/);
  assert.throws(() => editMemory(data, "add", "x".repeat(4001)), /4.000/);
  assert.throws(() => editMemory(data, "remove", "abc1 extra"), /remove ID/);
  await writeFile(path.join(f.cwd, MEMORY_FILE), "{");
  await assert.rejects(readMemory(f.cwd), SyntaxError);
});
