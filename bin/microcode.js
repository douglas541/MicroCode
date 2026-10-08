#!/usr/bin/env node
import { main } from "../src/cli.js";

main().catch((error) => {
  console.error(`MicroCode: ${error.message}`);
  process.exitCode = 1;
});
