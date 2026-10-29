import { Command } from "commander";
import { addPeerCommands } from "./options.js";

export function createCli(): Command {
  const program = new Command()
    .name("capnweb-shell")
    .description("Bidirectional Cap’n Web shell peers and local setup commands")
    .exitOverride()
    .showHelpAfterError();
  addPeerCommands(program, async (config) => {
    const { startPeer } = await import("./commands/peer.js");
    startPeer(config);
  });
  program.command("bundle-mac")
    .description("Create a portable source archive for the Mac peer (no system tar required)")
    .option("--output <file>", "Archive path (default: ./dist/capnweb-shell-mac.tar.gz)")
    .option("--source <path>", "Source checkout (Nix packages include a source copy)")
    .action(async (options: { output?: string; source?: string }) => {
      const { createMacBundle } = await import("./commands/bundle.js");
      console.log(`Created ${await createMacBundle(options)}`);
    });
  program.command("install-windows")
    .description("Install/build the native Windows copy; run from Windows or WSL")
    .option("--destination <path>", "Absolute Windows path (default: LOCALAPPDATA/capnweb-shell)")
    .option("--source <path>", "Source checkout to install")
    .action(async (options: { destination?: string; source?: string }) => {
      const { installWindows } = await import("./commands/install-windows.js");
      await installWindows(options);
    });
  program.command("integration-smoke")
    .description("Test the installed native Windows peer against WSL")
    .option("--long", "Also run 31-second commands in both directions")
    .action(async (options: { long?: boolean }) => {
      const { runIntegrationSmoke } = await import("./commands/integration-smoke.js");
      await runIntegrationSmoke(options);
    });
  return program;
}
