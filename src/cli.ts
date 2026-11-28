#!/usr/bin/env bun
// A named session's holder (holder.ts) loads only what it runs, not the whole CLI: one runs per session.
if (process.argv[2] === "daemon" && process.argv[3] === "hold") {
  const { hold } = await import("./holder.js");
  await hold();
} else {
  const [{ CommanderError }, { createCli }, { errorMessage }, { explainDenial }] = await Promise.all([
    import("commander"), import("./cli-program.js"), import("./errors.js"), import("./peers.js"),
  ]);
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
}

export {};
