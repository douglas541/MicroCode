import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  nextReleaseVersion,
  prepareRelease,
} from "../scripts/release-version.js";
import { temp } from "./helpers.js";

test("Automatic releases select a new stable patch using numeric version ordering", () => {
  assert.equal(nextReleaseVersion("0.1.0", []), "0.1.0");
  assert.equal(nextReleaseVersion("0.1.0", ["0.1.0"]), "0.1.1");
  assert.equal(
    nextReleaseVersion("0.1.0", ["0.1.9", "0.1.10", "0.1.2", "0.2.0-rc.1"]),
    "0.1.11",
  );
  assert.equal(nextReleaseVersion("0.1.0", ["1.2.3", "0.9.99"]), "1.2.4");
  assert.equal(nextReleaseVersion("0.2.0", ["0.1.10"]), "0.2.0");
  assert.equal(nextReleaseVersion("0.1.0", ["0.1.0-rc.1"]), "0.1.0");
  assert.throws(() => nextReleaseVersion("0.1.0-beta.1", []), /stable/);
  assert.throws(() => nextReleaseVersion("00.1.0", []), /stable/);
  assert.throws(() => nextReleaseVersion("0.1.0", null), /array/);
  assert.throws(
    () => nextReleaseVersion("0.1.0", [`0.1.${Number.MAX_SAFE_INTEGER}`]),
    /Cannot increment/,
  );
});

test("Release preparation reads the public registry and changes only the manifest version", async (t) => {
  const cwd = await temp(t);
  const packageFile = path.join(cwd, "package.json");
  const pkg = {
    name: "@microcode-org/microcode",
    version: "0.1.0",
    bin: { microcode: "bin/microcode.js" },
    publishConfig: { access: "public" },
  };
  await writeFile(packageFile, JSON.stringify(pkg));
  const release = await prepareRelease({
    packageFile,
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://registry.npmjs.org/%40microcode-org%2Fmicrocode",
      );
      assert.deepEqual(Object.keys(options.headers), ["Accept"]);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ versions: { "0.1.2": {}, "0.1.10": {} } });
    },
  });
  assert.deepEqual(release, { name: pkg.name, version: "0.1.11" });
  assert.deepEqual(JSON.parse(await readFile(packageFile, "utf8")), {
    ...pkg,
    version: "0.1.11",
  });
});

test("Registry failures never change the local version; a missing package keeps the initial version", async (t) => {
  const cwd = await temp(t);
  const packageFile = path.join(cwd, "package.json");
  const original = JSON.stringify({
    name: "@microcode-org/microcode",
    version: "0.1.0",
  });
  await writeFile(packageFile, original);
  const failures = [
    async () => new Response("Unavailable", { status: 503 }),
    async () => Response.json({}),
    async () => Response.json({ versions: [] }),
    async () => {
      throw new Error("Network unavailable");
    },
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(prepareRelease({ packageFile, fetchImpl }));
    assert.equal(await readFile(packageFile, "utf8"), original);
  }
  const release = await prepareRelease({
    packageFile,
    fetchImpl: async () => new Response("Not found", { status: 404 }),
  });
  assert.equal(release.version, "0.1.0");
});
