#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err?.message ?? String(err));
    process.exit(err?.exitCode ?? 1);
  },
);
