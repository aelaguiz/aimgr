#!/usr/bin/env node
import { main } from "../src/cli.js";
import { formatCliError } from "../src/cli/error.js";

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
}
