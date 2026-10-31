import { Command } from "commander";
import { addMcpCommand, addPeerCommands } from "./options.js";

export function createCli(): Command {
  const program = new Command()
    .name("cns")
    .description("Bidirectional remote shells on Linux, macOS and Windows")
    .exitOverride()
    .showHelpAfterError();
  addPeerCommands(program, async (config) => {
    if (config.daemon) {
      const { startDaemon } = await import("./commands/daemon.js");
      const daemon = await startDaemon(config);
      console.log(`Daemon listening at ${daemon.url}. State: ${daemon.state}\nLog: ${daemon.log}`);
    } else {
      const { startPeer } = await import("./commands/peer.js");
      await startPeer(config);
    }
  });
  addMcpCommand(program, async (config) => {
    const { startMcp } = await import("./commands/mcp.js");
    await startMcp(config);
  });
  program.command("attach")
    .description("Attach an interactive console to a local daemon")
    .option("--state <path>", "Local daemon state file")
    .action(async (options: { state?: string }) => {
      const { attachDaemon } = await import("./commands/daemon.js");
      await attachDaemon(options.state);
    });
  program.command("stop")
    .description("Stop a local daemon and its peer connections")
    .option("--state <path>", "Local daemon state file")
    .action(async (options: { state?: string }) => {
      const { stopDaemon } = await import("./commands/daemon.js");
      await stopDaemon(options.state);
      console.log("Daemon stopped.");
    });
  return program;
}
