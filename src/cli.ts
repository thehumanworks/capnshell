#!/usr/bin/env bun
import { CommanderError } from "commander";
import { createCli } from "./cli-program.js";
import { errorMessage } from "./errors.js";
import { explainDenial } from "./peers.js";

try {
  await createCli().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander already emitted help or the parsing error.
    process.exitCode = error.exitCode;
  } else {
    console.error(explainDenial(errorMessage(error)));
    // Peer-mode commands set 3 for an unpaired or changed device; a refused operation is 4.
    process.exitCode = /^Permission denied/.test(errorMessage(error)) ? 4 : process.exitCode || 1;
  }
}
