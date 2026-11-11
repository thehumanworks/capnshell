import { Command } from "commander";
import { addDaemonCommand, addMcpCommand, addPeerCommands } from "./options.js";
import { CNS_VERSION } from "./version.js";

export function createCli(): Command {
  const program = new Command()
    .name("cns")
    .description("Shells, terminals and files on your paired devices, on Linux, macOS and Windows")
    .version(CNS_VERSION, "-V, --version", "Print this cns's version; cns status shows the daemon's")
    .exitOverride()
    .showHelpAfterError();
  addPeerCommands(program, async (config) => {
    // At a terminal, each cns tty DEVICE starts a named session of its own, which survives
    // connection loss; --attach NAME joins one. Piped input gets an unnamed terminal.
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (config.role === "tty" && !config.screen && config.command === undefined && (config.attach || (config.name === undefined && interactive))) {
      const { attachPaired, NO_SESSIONS } = await import("./commands/paired-tty.js");
      const outcome = await attachPaired(config);
      if (typeof outcome === "number") { process.exitCode = outcome; return; }
      void NO_SESSIONS;
      // The device does not let this one start sessions: a terminal that ends with the connection is what remains.
      process.stderr.write(`[cns: ${config.expect.name} does not let this device start sessions; opening a terminal that ends with the connection]\n`);
    }
    const { startPeer } = await import("./commands/peer.js");
    await startPeer(config);
  }, async (config) => {
    const { sessionsEverywhere } = await import("./commands/sessions-everywhere.js");
    process.exitCode = await sessionsEverywhere(config);
  });
  addDaemonCommand(program, async (config) => {
    const { startPeer } = await import("./commands/peer.js");
    await startPeer(config);
  });
  addMcpCommand(program, async (config) => {
    const { startMcp } = await import("./commands/mcp.js");
    await startMcp(config);
  });
  const alias = program.command("peer").description("Manage paired devices: their names, grants and addresses");
  alias.command("remove <name>").description("Unpair a device: forget it here, and end its links at once")
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
  alias.command("list").description("List paired devices")
    .option("--json", "Print a JSON array sorted by name, [] when there are none: { name, fingerprint, publicKey, addresses, grants } per device")
    .action(async (options: { json?: boolean }) => {
      const { listPeers } = await import("./peers.js");
      const peers = listPeers().map((peer) => ({ name: peer.name, fingerprint: peer.fingerprint, publicKey: peer.publicKey, addresses: peer.addresses, grants: peer.grants }));
      if (options.json) console.log(JSON.stringify(peers, null, 2));
      else for (const peer of peers) console.log(`${peer.name}\t${peer.fingerprint}\t${peer.addresses[0] ?? "-"}`);
    });
  const gateway = program.command("gateway").description("Administer the gateway that lets Claude's connectors reach devices paired with it")
    .addHelpText("after", "\nThe gateway is a Cloudflare Worker you deploy (gateway/README.md). Commands are signed with this\ndevice's identity, which the gateway accepts when its public key is in the gateway's OWNER_KEYS.\nThe gateway's address is CNS_GATEWAY, or --url, or https://gateway.cns.nothuman.work.");
  const gatewayCommand = (name: string, description: string) => gateway.command(name).description(description)
    .option("--url <url>", "The gateway's address (default: CNS_GATEWAY, else https://gateway.cns.nothuman.work)")
    .option("--json", "Print the answer as JSON");
  const gatewayCommands = () => import("./commands/gateway.js");
  gatewayCommand("status", "Show the gateway's fingerprint, devices, approved connectors and approvals waiting")
    .action(async (options) => { await (await gatewayCommands()).status(options); });
  gatewayCommand("pair <code...>", "Pair the gateway with the device showing this code, or that printed this cns1: invite (cns pair there)")
    .option("--name <name>", "The gateway's name for the device (default: the name it suggests)")
    .option("--request <grants>", "What the gateway asks to use there (default: shell,files,sessions:create)")
    .addHelpText("after", "\nOn the device: cns pair; it shows a code and asks before saving, showing the gateway's\nfingerprint and what it requests. Compare the fingerprint with cns gateway status. The\ndevice grants at most what was requested; cns pair --grant files there grants less.")
    .action(async (code: string[], options) => { await (await gatewayCommands()).pair(code, options); });
  gatewayCommand("remove <name>", "Forget a device: no connector reaches it from now on")
    .action(async (name: string, options) => { await (await gatewayCommands()).remove(name, options); });
  gatewayCommand("approve <code>", "Approve a connector that is waiting with this code on its sign-in page")
    .option("--devices <names>", "The devices it may reach, comma-separated, or all (default: all paired now)")
    .option("--tools <tools>", "The tools it may use, comma-separated, read (look only) or all (default: all)")
    .option("--yes", "Approve without asking, after checking the details it prints")
    .action(async (code: string, options) => { await (await gatewayCommands()).approve(code, options); });
  gatewayCommand("deny <code>", "Decline a connector that is waiting with this code")
    .action(async (code: string, options) => { await (await gatewayCommands()).deny(code, options); });
  gatewayCommand("grants", "List approved connectors")
    .action(async (options) => { await (await gatewayCommands()).grants(options); });
  gatewayCommand("revoke <id>", "Revoke an approved connector at once, by the ID cns gateway grants shows")
    .action(async (id: string, options) => { await (await gatewayCommands()).revoke(id, options); });
  gatewayCommand("log", "Show the newest tool calls connectors made: when, which device, which tool, the command or path")
    .option("--limit <n>", "How many entries (default: 50, at most 1000)")
    .action(async (options) => { await (await gatewayCommands()).log(options); });
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
    .description("Pair this device with another: show a pairing code, or type the code the other device shows")
    .argument("[code...]", "The code the other device shows, such as 42-orbit-canyon-velvet, or a cns1:... invite")
    .option("--name <name>", "Save the other device under this name")
    .option("--request <grants>", "With an invite: what to ask for on the other device: shell, files, sessions, all, or permissions (default: all)")
    .option("--grant <grants>", "What the other device may do here: none, shell, files, sessions, all, or permissions. Without --grant either side asks, and --yes alone grants nothing; the inviting device grants at most what was requested")
    .option("--expires <minutes>", "How long a code or invite stays valid (default: 5)")
    .option("--long", "Print a cns1: invite to paste instead of a code, for pairing without the relay or from scripts")
    .option("--yes", "Pair without asking; for scripts, after comparing fingerprints yourself")
    .option("--state <path>", "Local daemon state file")
    .addHelpText("after", "\nOn the device you want to reach:  cns pair                        (shows a code and waits)\nOn the other device:              cns pair 42-orbit-canyon-velvet\nThe code works once, through the relay built into cns; the first four letters of each word are\nenough. Three wrong tries end it. Without the relay, cns pair --long prints an invite to paste\nwith cns pair 'cns1:...'. Both sides show the other's fingerprint and ask before saving anything.")
    .action(async (code: string[], options) => { const { pair } = await import("./commands/pairing-cli.js"); await pair(code.length ? code : undefined, options); });
  program.command("peers")
    .description("List paired devices with their status")
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
    .argument("[name]", "A paired device's name; without one, check this device")
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
