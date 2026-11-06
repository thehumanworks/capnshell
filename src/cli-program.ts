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
  const alias = program.command("peer").description("Manage locally saved peer addresses (not authenticated identities)");
  alias.command("add <name> <url>").description("Save a new peer address without replacing an existing alias")
    .action(async (name: string, url: string) => { const { addAlias } = await import("./aliases.js"); addAlias(name, url); console.log(`Saved ${name}.`); });
  alias.command("remove <name>").description("Remove a saved peer address")
    .action(async (name: string) => { const { removeAlias } = await import("./aliases.js"); removeAlias(name); console.log(`Removed ${name}.`); });
  alias.command("list").description("List saved peer addresses")
    .option("--json", "Print a JSON array of { name, url } objects sorted by name, [] when there are none")
    .action(async (options: { json?: boolean }) => {
      const { listAliases } = await import("./aliases.js");
      const peers = listAliases();
      if (options.json) console.log(JSON.stringify(peers, null, 2));
      else for (const peer of peers) console.log(`${peer.name}\t${peer.url}`);
    });
  program.command("identity")
    .description("Show this device's identity for pairing, creating it on first use")
    .option("--json", "Print { publicKey, fingerprint, createdAt, path } as JSON")
    .action(async (options: { json?: boolean }) => {
      const { ensureIdentity, identityPath } = await import("./identity.js");
      const { identity, created } = ensureIdentity();
      if (options.json) {
        console.log(JSON.stringify({ publicKey: identity.publicKey, fingerprint: identity.fingerprint, createdAt: identity.createdAt, path: identityPath() }, null, 2));
        return;
      }
      if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
      console.log(`Fingerprint: ${identity.fingerprint}\nPublic key:  ${identity.publicKey}`);
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
