#!/usr/bin/env bun
import { CommanderError } from "commander";
import { createCli } from "./cli-program.js";
import { errorMessage } from "./errors.js";

try {
  await createCli().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander already emitted help or the parsing error.
    process.exitCode = error.exitCode;
  } else {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
