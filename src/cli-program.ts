import { Command } from "commander";
import { addMcpCommand, addPeerCommands } from "./options.js";

export function createCli(): Command {
  const program = new Command()
    .name("cns")
    .description("Bidirectional remote shells on Linux, macOS and Windows")
    .exitOverride()
    .showHelpAfterError();
  addPeerCommands(program, async (config) => {
    // A paired device's named session survives connection loss: --attach NAME, or `main` when
    // run at a terminal. Piped input goes to a terminal of its own, never a shared session.
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (config.role === "tty" && config.expect && !config.screen && config.command === undefined && (config.attach || (config.name === undefined && interactive))) {
      const { attachPaired, NO_SESSIONS } = await import("./commands/paired-tty.js");
      const outcome = await attachPaired(config);
      if (typeof outcome === "number") { process.exitCode = outcome; return; }
      void NO_SESSIONS;
      // The device grants no session access: a terminal that ends with the connection is what remains.
      process.stderr.write(`[cns: ${config.expect.name} grants this device no sessions; opening a terminal that ends with the connection]\n`);
    }
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
  alias.command("remove <name>").description("Remove a saved peer; for a paired device, its links end at once")
    .option("--state <path>", "Local daemon state file")
    .action(async (name: string, options: { state?: string }) => { const { removePeer } = await import("./commands/pairing-cli.js"); await removePeer(name, options); });
  alias.command("grant <name> <grants...>").description("Let a paired device use more of this device: shell, files, sessions, all or permissions")
    .option("--state <path>", "Local daemon state file")
    .action(async (name: string, grants: string[], options: { state?: string }) => { const { grant } = await import("./commands/pairing-cli.js"); await grant(name, grants, options); });
  alias.command("revoke <name> [grants...]").description("Take access away from a paired device, now; without grants, all of it")
    .option("--state <path>", "Local daemon state file")
    .action(async (name: string, grants: string[], options: { state?: string }) => { const { revoke } = await import("./commands/pairing-cli.js"); await revoke(name, grants, options); });
  alias.command("address <name> <urls...>").description("Add where to reach a paired device, or remove addresses with --remove")
    .option("--remove", "Remove these addresses instead of adding them")
    .option("--state <path>", "Local daemon state file")
    .action(async (name: string, urls: string[], options: { remove?: boolean; state?: string }) => { const { address } = await import("./commands/pairing-cli.js"); await address(name, urls, options); });
  alias.command("list").description("List saved peers: address aliases and paired devices")
    .option("--json", "Print a JSON array sorted by name, [] when there are none: { name, url } per alias, plus paired, fingerprint, publicKey, addresses and grants per paired device")
    .action(async (options: { json?: boolean }) => {
      const { listPeers } = await import("./peers.js");
      const peers = listPeers().map((peer) => peer.kind === "address"
        ? { name: peer.name, url: peer.url }
        : { name: peer.name, url: peer.addresses[0] ?? null, paired: true, fingerprint: peer.fingerprint, publicKey: peer.publicKey, addresses: peer.addresses, grants: peer.grants });
      if (options.json) console.log(JSON.stringify(peers, null, 2));
      else for (const peer of peers) console.log(`${peer.name}\t${peer.url ?? "-"}${"paired" in peer ? `\tpaired ${peer.fingerprint}` : ""}`);
    });
  program.command("up")
    .description("Run this device as a paired peer: start its daemon, or report the running one")
    .option("--bind <address>", "Interface to listen on (default: every interface; CNS_BIND)")
    .option("--port <port>", "TCP port (default: 47381; CNS_PORT)")
    .option("--state <path>", "Local daemon state file")
    .option("--install", "Run the daemon as a service that starts at login and restarts if it fails: a launchd agent on macOS, a systemd user service on Linux")
    .option("--uninstall", "Stop the service's daemon and remove the service")
    .addHelpText("after", "\nOnly paired devices can connect, after authenticating; each gets what cns pair granted it.\nThe daemon also registers at the relay built into cns, so paired devices on other networks reach it\nwith nothing to set up. Links are encrypted end to end, directly or through the relay. Pair with cns pair.\n--install keeps the running daemon's --bind and --port unless given; run it again to change them.")
    .action(async (options) => { const { up } = await import("./commands/pairing-cli.js"); await up(options); });
  program.command("pair")
    .description("Pair this device with another: print an invite, or paste one from the other device")
    .argument("[invite]", "The cns1:... invite the other device printed")
    .option("--name <name>", "Save the other device under this name")
    .option("--request <grants>", "With an invite: what to ask for on the other device: shell, files, sessions, all, or permissions (default: all)")
    .option("--grant <grants>", "What the other device may do here: none, shell, files, sessions, all, or permissions. Without --grant either side asks, and --yes alone grants nothing; the inviting device grants at most what was requested")
    .option("--expires <minutes>", "How long a printed invite stays valid (default: 5)")
    .option("--yes", "Pair without asking; for scripts, after comparing fingerprints yourself")
    .option("--state <path>", "Local daemon state file")
    .addHelpText("after", "\nOn the device you want to reach:  cns pair          (prints an invite and waits)\nOn the other device:              cns pair 'cns1:...'\nBoth sides show the other's fingerprint and ask before saving anything.")
    .action(async (invite: string | undefined, options) => { const { pair } = await import("./commands/pairing-cli.js"); await pair(invite, options); });
  program.command("peers")
    .description("List paired devices and saved addresses with their status")
    .option("--json", "Print the list as JSON")
    .option("--state <path>", "Local daemon state file")
    .action(async (options) => { const { peers } = await import("./commands/pairing-cli.js"); await peers(options); });
  program.command("status")
    .description("Show this device's identity, its daemon and its links")
    .option("--json", "Print the status as JSON")
    .option("--state <path>", "Local daemon state file")
    .action(async (options) => { const { status } = await import("./commands/pairing-cli.js"); await status(options); });
  program.command("doctor")
    .description("Check this device (identity, daemon, relay, addresses), or how it reaches a paired device: each saved address, authentication and grants")
    .argument("[name]", "A saved peer name; without one, check this device")
    .option("--json", "Print the report as JSON")
    .option("--state <path>", "Local daemon state file")
    .addHelpText("after", "\nWith NAME: exit 0 when an address answered as the paired device, 3 when it answered as another device or refused the pairing, 5 when none answered or none is saved.\nWithout: exit 0 when paired devices can reach this device (warnings, such as only private addresses, do not change it), 3 when the daemon runs as another identity, 5 when there is no identity, no paired daemon or no address.")
    .action(async (name: string | undefined, options) => { const { doctor } = await import("./commands/pairing-cli.js"); await doctor(name, options); });
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
