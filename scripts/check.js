import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(name);
    else if (name.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", name], {
        stdio: "inherit",
      });
      if (result.status !== 0) process.exit(1);
    }
  }
}
for (const directory of ["bin", "src", "test", "scripts"])
  await check(directory);
console.log("Syntax OK");
