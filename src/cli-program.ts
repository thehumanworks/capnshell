import { Command } from "commander";
import { addDaemonCommand, addMcpCommand, addPeerCommands, deviceAndRest, deviceOption, oneDevice } from "./options.js";
import { CNS_VERSION } from "./version.js";

export function createCli(): Command {
  // Positional options keep flags for remote commands intact. Also accept this one directly on "up".
  const tokenFileOption = ["-f, --token-file <path>", "Read the mesh bot token directly from this file instead of CNS_TOKEN"] as const;
  /**
   * A paired device named as an action's first operand or with --device, the operands after it,
   * and the options without --device, which the commands behind these actions do not take.
   */
  const paired = <T extends { device?: string }>(name: string, usage: string, operands: (string | undefined)[], options: T) => {
    const { device: option, ...rest } = options;
    const { device, rest: after } = deviceAndRest(name, operands.filter((operand): operand is string => operand !== undefined), option, usage);
    return { device, after, options: rest as Omit<T, "device"> };
  };
  const once = (name: string, usage: string, after: string[]) => {
    if (after.length) throw new Error(`${name} takes one device: cns ${name} ${usage}, or --device NAME without the argument.`);
  };
  const program = new Command()
    .name("cns")
    .description("Shells, terminals and files on your paired devices, on Linux, macOS and Windows")
    .version(CNS_VERSION, "-V, --version", "Print this cns's version; cns status shows the daemon's")
    .option(...tokenFileOption)
    .exitOverride()
    .showHelpAfterError()
    // A mesh bot token makes this machine the bot it names before any command runs (mesh-token.ts).
    .hook("preAction", async (_root, command) => {
      const file: string | undefined = command.optsWithGlobals().tokenFile;
      const token = process.env.CNS_TOKEN;
      if (file === undefined && token === undefined) return;
      const { readBotTokenFile, startAsBot } = await import("./mesh-token.js");
      if (file !== undefined) startAsBot(readBotTokenFile(file), "token file");
      else startAsBot(token!);
      // Children use the saved identity. Never pass them a private key or bootstrap the daemon a second time.
      delete process.env.CNS_TOKEN;
    });
  addPeerCommands(program, async (config) => {
    // --secret: read and open the secrets here, before anything connects. They travel as the
    // program's environment in the command's options, never in the command's text.
    if (config.secrets) {
      const { secretEnv } = await import("./commands/secret-cli.js");
      config = { ...config, env: await secretEnv(config.secrets) };
    }
    // At a terminal, each cns shell DEVICE starts a named session of its own, which survives
    // connection loss; --attach NAME joins one. Piped input gets an unnamed terminal.
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (config.role === "shell" && !config.detached && !config.screen && config.command === undefined && (config.attach || (config.name === undefined && interactive))) {
      const { attachPaired, NO_SESSIONS } = await import("./commands/paired-shell.js");
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
  const pairedDevice = "A paired device's name, or --device";
  alias.command("remove").usage("[options] <name>").argument("[name]", pairedDevice).description("Unpair a device: forget it here, and end its links at once")
    .addOption(deviceOption("The paired device, in place of the NAME argument"))
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string | undefined, given: { device?: string; state?: string }) => {
      const { device, after, options } = paired("peer remove", "NAME", [name], given);
      once("peer remove", "NAME", after);
      const { removePeer } = await import("./commands/pairing-cli.js"); await removePeer(device, options);
    });
  alias.command("grant").usage("[options] <name> <grants...>").argument("[name]", pairedDevice).argument("[grants...]").description("Let a paired device use more of this device: shell, files, sessions, all or permissions")
    .addOption(deviceOption("The paired device, in place of the NAME argument"))
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string | undefined, grants: string[], given: { device?: string; state?: string }) => {
      const { device, after, options } = paired("peer grant", "NAME GRANTS...", [name, ...grants], given);
      const { grant } = await import("./commands/pairing-cli.js"); await grant(device, after, options);
    });
  alias.command("revoke").usage("[options] <name> [grants...]").argument("[name]", pairedDevice).argument("[grants...]").description("Take access away from a paired device, now; without grants, all of it")
    .addOption(deviceOption("The paired device, in place of the NAME argument"))
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string | undefined, grants: string[], given: { device?: string; state?: string }) => {
      const { device, after, options } = paired("peer revoke", "NAME [GRANTS...]", [name, ...grants], given);
      const { revoke } = await import("./commands/pairing-cli.js"); await revoke(device, after, options);
    });
  alias.command("address").usage("[options] <name> <urls...>").argument("[name]", pairedDevice).argument("[urls...]").description("Add where to reach a paired device, or remove addresses with --remove")
    .addOption(deviceOption("The paired device, in place of the NAME argument"))
    .option("-r, --remove", "Remove these addresses instead of adding them")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string | undefined, urls: string[], given: { device?: string; remove?: boolean; state?: string }) => {
      const { device, after, options } = paired("peer address", "NAME URLS...", [name, ...urls], given);
      if (!after.length) throw new Error("peer address requires at least one address: cns peer address NAME URLS....");
      const { address } = await import("./commands/pairing-cli.js"); await address(device, after, options);
    });
  alias.command("list").description("List paired devices")
    .option("-j, --json", "Print a JSON array sorted by name, [] when there are none: { name, fingerprint, publicKey, addresses, grants, mesh? } per device")
    .action(async (options: { json?: boolean }) => {
      const { listPeers } = await import("./peers.js");
      const peers = listPeers().map((peer) => ({ name: peer.name, fingerprint: peer.fingerprint, publicKey: peer.publicKey, addresses: peer.addresses, grants: peer.grants, ...peer.mesh === undefined ? {} : { mesh: peer.mesh } }));
      if (options.json) console.log(JSON.stringify(peers, null, 2));
      else for (const peer of peers) console.log(`${peer.name}\t${peer.fingerprint}\t${peer.addresses[0] ?? "-"}`);
    });
  const mesh = program.command("mesh").description("Let a group of devices all reach each other: one device runs the mesh, the others join through their pairing with it")
    .addHelpText("after", [
      "",
      "On the device that runs it:  cns mesh create home",
      "                             cns mesh add home laptop studio     (devices paired with this one)",
      "On each of those:            cns mesh join home --via NAME --allow shell",
      "                             (NAME: its name for the device that runs the mesh)",
      "Every member then reaches every other one, without pairing with each, as far as each allows:",
      "--allow, or later cns mesh allow, sets what members may use on that device, and the admin's",
      "cns mesh add --limit narrows it for one member. The member list is signed by the device that runs",
      "the mesh, and devices pass the newest one to each other over their encrypted links.",
    ].join("\n"));
  const meshCommands = () => import("./commands/mesh-cli.js");
  mesh.command("create <name>").description("Start a mesh that this device runs")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string, options) => { await (await meshCommands()).createMesh(name, options); });
  mesh.command("add <name> <devices...>").description("Put devices paired with this one in the mesh, or change the limit of ones in it")
    .option("-l, --limit <grants>", "The most each may use on other members, whatever they allow: shell, files, sessions, all, or permissions")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string, devices: string[], options) => { await (await meshCommands()).addMembers(name, devices, options); });
  mesh.command("token <name> <bot>").description("Print a token that makes a machine nobody sits at, such as a CI runner, a member of the mesh as BOT")
    .option("-a, --allow <grants>", "Required: what other members may use on the bot: none, shell, files, sessions, all, or permissions")
    .option("-l, --limit <grants>", "The most the bot may use on other members, whatever they allow")
    .option("-c, --code", "Show a short code to type on the bot's machine, with cns mesh join --code, instead of printing the token")
    .option("-e, --expires <minutes>", "With --code: how long the code stays valid (default: 5)")
    .option("-S, --state <path>", "Local daemon state file")
    .addHelpText("after", "\nThe token goes to stdout, once; store it as a secret. On the bot's machine, set CNS_TOKEN to it:\nany cns command there first makes the machine the bot, and CNS_TOKEN=... cns up runs it as a member\nthe others reach. For a mounted secret, use cns up --token-file PATH instead of CNS_TOKEN.\nThe token works again on a new machine, one machine at a time. To revoke it\nand free its name on this device: cns mesh remove NAME BOT --unpair.\n\nTo type it by hand instead, on a machine with no other way in:\nOn this device:       cns mesh token home box --allow shell --code   (shows a code and waits)\nOn the bot's machine: cns mesh join --code 42-orbit-canyon-velvet, then cns up\nThe code works once, through the relay, like a pairing code. Three wrong tries end it, and\nnothing is added to the mesh until the right code is typed.")
    .action(async (name: string, bot: string, options) => { await (await meshCommands()).botToken(name, bot, options); });
  mesh.command("remove <name> <devices...>").description("Take devices out of the mesh; the other members drop them")
    .option("-u, --unpair", "Also remove their direct pairings on this admin, end their links and free their names")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string, devices: string[], options) => { await (await meshCommands()).removeMembers(name, devices, options); });
  mesh.command("join [name]").description("Take part in a mesh run by a paired device that added this one, or join as a bot with a code")
    .option("-v, --via <device>", "The device that runs the mesh, by its name here")
    .option("-a, --allow <grants>", "What members may use on this device: none, shell, files, sessions, all, or permissions (default: none)")
    .option("-c, --code <code...>", "The code cns mesh token --code shows on the admin: this machine, new to cns, becomes that bot")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string, options) => { await (await meshCommands()).joinMesh(name, options); });
  mesh.command("allow <name> <grants...>").description("Set what every member of the mesh may use on this device; none takes it all away")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string, grants: string[], options) => { await (await meshCommands()).allowMembers(name, grants, options); });
  mesh.command("leave <name>").description("Forget the mesh and its members here; the device that runs it deletes it instead")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (name: string, options) => { await (await meshCommands()).leaveMesh(name, options); });
  mesh.command("delete <name>").description("Delete a mesh this device runs, once every other member has been removed from it")
    .option("-S, --state <path>", "Local daemon state file")
    .addHelpText("after", "\nOnly the device that runs a mesh deletes it, and only when it is the last member: take the others\nout first with cns mesh remove NAME DEVICE..., which names them when any are left. Deleting\nforgets the mesh and its secrets here. Pairings made by hand stay.")
    .action(async (name: string, options) => { await (await meshCommands()).deleteMesh(name, options); });
  mesh.command("list [name]").description("List this device's meshes and their members")
    .option("-j, --json", "Print a JSON array: { name, admin, version, issuedAt, allow, members: [{ name, fingerprint, admin, limit }] } per mesh")
    .action(async (name: string | undefined, options) => { (await meshCommands()).listMeshesCommand(name, options); });
  const secret = program.command("secret").description("Keep secrets, such as API keys, that every member of a mesh can read, or one member only")
    .addHelpText("after", [
      "",
      "laptop $ cns secret set OPENAI_API_KEY                       (asks for the value, hidden)",
      "laptop $ op read op://dev/npm/token | cns secret set home:NPM_TOKEN --device ci",
      "studio $ cns secret get OPENAI_API_KEY                       (prints the value)",
      "studio $ cns secret run --only OPENAI_API_KEY -- 'python agent.py'",
      "laptop $ cns run studio --secret OPENAI_API_KEY -- 'python agent.py'",
      "",
      "A secret is named NAME, or MESH:NAME to say which mesh. The mesh may be left out when it is",
      "clear: for get, rm, run and --secret, when one mesh holds the name; for set, when this device is",
      "in one mesh. When two meshes hold the name, the command stops and shows both ways to write it.",
      "MESH NAME as two words works as well.",
      "",
      "A secret set without --device reaches every member of the mesh, now and later, bots included;",
      "with --device, only that member and the device that set it can read it. On a device, get returns",
      "the one set for it alone before the mesh's. Values are never arguments, so they stay out of ps",
      "and shell history. Each device keeps its copies encrypted to its own key, and daemons pass them",
      "on over their encrypted links, sealed to each member that may read them. Only the device that set",
      "a secret changes or removes it. A member removed from the mesh drops its copies and gets no new",
      "versions, but keeps what it read.",
    ].join("\n"));
  const secretCommands = () => import("./commands/secret-cli.js");
  const secretDevice = ["-D, --device <name>", "Only this member, besides the device that sets it, may read it"] as const;
  const secretArgument = ["<secret>", "NAME, or MESH:NAME to say which mesh"] as const;
  secret.command("set").usage("[options] [MESH:]NAME").argument(...secretArgument).argument("[name]")
    .description("Set or change a secret: the value comes from a hidden prompt, or from stdin")
    .option(...secretDevice)
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (first: string, second: string | undefined, options) => { await (await secretCommands()).setSecret(first, second, options); });
  secret.command("get").usage("[options] [MESH:]NAME").argument(...secretArgument).argument("[name]")
    .description("Print a secret's value: the one set for this device alone, else the mesh's")
    .option("-D, --device <name>", "The one set for this member alone")
    .action(async (first: string, second: string | undefined, options) => { await (await secretCommands()).getSecret(first, second, options); });
  const names = (value: string, earlier: string[] | undefined) => [...earlier ?? [], value];
  const secretRun = secret.command("run").usage("[options] -- <command...>").argument("[command...]")
    .description("Run a command on this device with the secrets it reads as environment variables")
    .option("-o, --only <names>", "Set only these: NAME or MESH:NAME, separated by commas or given again", names)
    .option("-x, --exclude <names>", "Set every secret but these", names)
    .addHelpText("after", [
      "",
      "Each secret this device reads becomes a variable of its own name, for this command only: the one",
      "set for this device alone before the mesh's. Without --only or --exclude, all of them. A name that",
      "two meshes hold stops the command until --only MESH:NAME picks one or --exclude MESH:NAME leaves",
      "one out. Everything after -- is the command, in this device's shell syntax, with the rules of",
      "cns run: Bash (PowerShell on Windows) runs it, several words are joined with spaces, and one",
      "quoted string reaches the shell unchanged, so quote $NAME to have it read there and not here.",
      "As the words are joined, the shell also reads a word that holds spaces or shell characters, such as",
      "a file name from a script: quote it for the shell, as over ssh.",
      "The command gets this terminal or these pipes, and cns exits with its status.",
      "Every member of a mesh can set a secret of any name. Without --only, a variable that tells programs",
      "what to run or where to connect, such as PATH, BASH_ENV, NODE_OPTIONS or HTTPS_PROXY, stops the",
      "command when another device set it: name it with --only, or leave it out with --exclude. cns cannot",
      "know every program's variables, so use --only when a mesh has members you would not let run commands",
      "here.",
      "Examples: cns secret run -- ./deploy.sh    cns secret run --only NPM_TOKEN -- npm publish",
      "          cns secret run --exclude work:API_KEY -- 'terraform plan | tee plan.txt'",
    ].join("\n"));
  secretRun.action(async (words: string[], options: { only?: string[]; exclude?: string[] }) => {
    // As with cns run: the delimiter stays in the parent's arguments, and the command follows it.
    if (!program.args.includes("--") || !words.length) throw new Error("secret run requires -- before its command: cns secret run -- command.");
    const command = words.join(" ");
    if (!command.trim() || command.length > 8192) throw new Error("Command must contain 1-8192 characters.");
    process.exitCode = await (await secretCommands()).runWithSecrets(command, options);
  });
  secret.command("list [mesh]").description("List the secrets this device can read, by name; never their values")
    .option("-j, --json", "Print a JSON array: { mesh, name, for, setBy, version, setAt } per secret; for is null for the whole mesh")
    .action(async (mesh: string | undefined, options) => { await (await secretCommands()).listSecrets(mesh, options); });
  secret.command("rm").usage("[options] [MESH:]NAME").argument(...secretArgument).argument("[name]")
    .description("Remove a secret this device set, from every member")
    .option("-D, --device <name>", "The one set for this member alone")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (first: string, second: string | undefined, options) => { await (await secretCommands()).removeSecret(first, second, options); });
  const gateway = program.command("gateway").description("Administer the gateway that lets Claude's connectors reach devices paired with it")
    .addHelpText("after", "\nThe gateway is a Cloudflare Worker you deploy (gateway/README.md). Commands are signed with this\ndevice's identity, which the gateway accepts when its public key is in the gateway's OWNER_KEYS.\nThe gateway's address is CNS_GATEWAY, or --url, or https://gateway.cns.nothuman.work.");
  const gatewayCommand = (name: string, description: string) => gateway.command(name).description(description)
    .option("-u, --url <url>", "The gateway's address (default: CNS_GATEWAY, else https://gateway.cns.nothuman.work)")
    .option("-j, --json", "Print the answer as JSON");
  const gatewayCommands = () => import("./commands/gateway.js");
  gatewayCommand("status", "Show the gateway's fingerprint, devices, approved connectors and approvals waiting")
    .action(async (options) => { await (await gatewayCommands()).status(options); });
  gatewayCommand("pair <code...>", "Pair the gateway with the device showing this code, or that printed this cns1: invite (cns pair there)")
    .option("-n, --name <name>", "The gateway's name for the device (default: the name it suggests)")
    .option("-r, --request <grants>", "What the gateway asks to use there (default: shell,files,sessions:create)")
    .addHelpText("after", "\nOn the device: cns pair; it shows a code and asks before saving, showing the gateway's\nfingerprint and what it requests. Compare the fingerprint with cns gateway status. The\ndevice grants at most what was requested; cns pair --grant files there grants less.")
    .action(async (code: string[], options) => { await (await gatewayCommands()).pair(code, options); });
  gatewayCommand("remove", "Forget a device: no connector reaches it from now on").usage("[options] <name>").argument("[name]", "The device's name at the gateway, or --device")
    .addOption(deviceOption("The device, in place of the NAME argument"))
    .action(async (name: string | undefined, given: { device?: string }) => {
      const { device, after, options } = paired("gateway remove", "NAME", [name], given);
      once("gateway remove", "NAME", after);
      await (await gatewayCommands()).remove(device, options);
    });
  gatewayCommand("approve <code>", "Approve a connector that is waiting with this code on its sign-in page")
    .option("-d, --devices <names>", "The devices it may reach, comma-separated, or all (default: all paired now)")
    .option("-t, --tools <tools>", "The tools it may use, comma-separated, read (look only) or all (default: all)")
    .option("-y, --yes", "Approve without asking, after checking the details it prints")
    .action(async (code: string, options) => { await (await gatewayCommands()).approve(code, options); });
  gatewayCommand("deny <code>", "Decline a connector that is waiting with this code")
    .action(async (code: string, options) => { await (await gatewayCommands()).deny(code, options); });
  gatewayCommand("grants", "List approved connectors")
    .action(async (options) => { await (await gatewayCommands()).grants(options); });
  gatewayCommand("revoke <id>", "Revoke an approved connector at once, by the ID cns gateway grants shows")
    .action(async (id: string, options) => { await (await gatewayCommands()).revoke(id, options); });
  gatewayCommand("log", "Show the newest tool calls connectors made: when, which device, which tool, the command or path")
    .option("-l, --limit <n>", "How many entries (default: 50, at most 1000)")
    .action(async (options) => { await (await gatewayCommands()).log(options); });
  program.command("up")
    .description("Run this device as a paired peer: start its daemon, or report the running one")
    .option(...tokenFileOption)
    .option("-b, --bind <address>", "Interface to listen on (default: every interface; CNS_BIND)")
    .option("-p, --port <port>", "TCP port (default: 47381; CNS_PORT)")
    .option("-S, --state <path>", "Local daemon state file")
    .option("-i, --install", "Run the daemon as a service that starts at login and restarts if it fails: a launchd agent on macOS, a systemd user service on Linux")
    .option("-u, --uninstall", "Stop the service's daemon and remove the service")
    .addHelpText("after", "\nOnly paired devices can connect, after authenticating; each gets what cns pair granted it.\nThe daemon also registers at the relay built into cns, so paired devices on other networks reach it\nwith nothing to set up. Links are encrypted end to end, directly or through the relay. Pair with cns pair.\n--install keeps the running daemon's --bind and --port unless given; run it again to change them.")
    .action(async (options) => { const { up } = await import("./commands/pairing-cli.js"); await up(options); });
  program.command("pair")
    .description("Pair this device with another: show a pairing code, or type the code the other device shows")
    .argument("[code...]", "The code the other device shows, such as 42-orbit-canyon-velvet, or a cns1:... invite")
    .option("-n, --name <name>", "Save the other device under this name")
    .option("-r, --request <grants>", "With an invite: what to ask for on the other device: shell, files, sessions, all, or permissions (default: all)")
    .option("-g, --grant <grants>", "What the other device may do here: none, shell, files, sessions, all, or permissions. Without --grant either side asks, and --yes alone grants nothing; the inviting device grants at most what was requested")
    .option("-e, --expires <minutes>", "How long a code or invite stays valid (default: 5)")
    .option("-l, --long", "Print a cns1: invite to paste instead of a code, for pairing without the relay or from scripts")
    .option("-y, --yes", "Pair without asking; for scripts, after comparing fingerprints yourself")
    .option("-S, --state <path>", "Local daemon state file")
    .addHelpText("after", "\nOn the device you want to reach:  cns pair                        (shows a code and waits)\nOn the other device:              cns pair 42-orbit-canyon-velvet\nThe code works once, through the relay built into cns; the first four letters of each word are\nenough. Three wrong tries end it. Without the relay, cns pair --long prints an invite to paste\nwith cns pair 'cns1:...'. Both sides show the other's fingerprint and ask before saving anything.")
    .action(async (code: string[], options) => { const { pair } = await import("./commands/pairing-cli.js"); await pair(code.length ? code : undefined, options); });
  program.command("peers")
    .description("List paired devices with their status")
    .option("-j, --json", "Print the list as JSON")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (options) => { const { peers } = await import("./commands/pairing-cli.js"); await peers(options); });
  program.command("status")
    .description("Show this device's identity, its daemon and its links")
    .option("-j, --json", "Print the status as JSON")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (options) => { const { status } = await import("./commands/pairing-cli.js"); await status(options); });
  program.command("doctor")
    .description("Check this device (identity, daemon, relay, addresses), or how it reaches a paired device: each saved address, authentication and grants")
    .argument("[name]", "A paired device's name; without one, check this device")
    .addOption(deviceOption("The paired device to check, in place of the NAME argument"))
    .option("-j, --json", "Print the report as JSON")
    .option("-S, --state <path>", "Local daemon state file")
    .addHelpText("after", "\nWith NAME: exit 0 when an address answered as the paired device, 3 when it answered as another device or refused the pairing, 5 when none answered or none is saved.\nWithout: exit 0 when paired devices can reach this device (warnings, such as only private addresses, do not change it), 3 when the daemon runs as another identity, 5 when there is no identity, no paired daemon or no address.")
    .action(async (name: string | undefined, { device, ...options }) => { const { doctor } = await import("./commands/pairing-cli.js"); await doctor(oneDevice("doctor", name, device), options); });
  program.command("identity")
    .description("Show this device's identity for pairing, creating it on first use")
    .option("-j, --json", "Print { publicKey, fingerprint, createdAt, path } as JSON")
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
  program.command("ui")
    .description("Move between named sessions on every paired device, one at a time or side by side in panes")
    .argument("[target]", "DEVICE to open the switcher on, or DEVICE/SESSION to open that session at once")
    .addOption(deviceOption("The device to open the switcher on, in place of the TARGET argument"))
    .option("-s, --session <name>", "With a device, the session to open at once, in place of DEVICE/SESSION")
    .option("-k, --key <key>", "The key that opens the switcher, such as C-b (default: CNS_KEY, else C-])")
    .addHelpText("after", [
      "",
      "A session fills the terminal. Ctrl-] opens the switcher: every paired device and its sessions,",
      "with the selected session's screen beside them. In the switcher:",
      "  Enter   open the selected session         1-9   open that numbered session",
      "  Tab     the session before the last one   Esc   back to the session you came from",
      "  n       start the next shell-N on the selected device",
      "  +       add the selected session in a pane, up to four side by side",
      "  -       close the current session's pane; the session keeps running",
      "  x       kill the selected session (asks first)",
      "  d, q    detach: leave cns ui",
      "Detaching, or closing the terminal, leaves every session running; cns ui returns to them.",
      "A device removes a session an hour after its program ends. Each device's grants apply as",
      "with cns sessions, cns shell --attach and cns kill.",
      "Examples: cns ui    cns ui studio    cns ui studio/build    cns ui -D studio -s build    cns ui --key C-b",
    ].join("\n"))
    .action(async (argument: string | undefined, options: { device?: string; session?: string; key?: string }) => {
      const { ui } = await import("./commands/ui.js");
      process.exitCode = await ui({ target: uiTarget(argument, options), key: options.key });
    });
  program.command("attach")
    .description("Attach an interactive console to a local daemon")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (options: { state?: string }) => {
      const { attachDaemon } = await import("./commands/daemon.js");
      await attachDaemon(options.state);
    });
  program.command("stop")
    .description("Stop a local daemon and its peer connections")
    .option("-S, --state <path>", "Local daemon state file")
    .action(async (options: { state?: string }) => {
      const { stopDaemon } = await import("./commands/daemon.js");
      await stopDaemon(options.state);
      console.log("Daemon stopped.");
    });
  return program;
}

/** What cns ui opens: TARGET, or --device with or without --session, as DEVICE or DEVICE/SESSION. */
export function uiTarget(argument: string | undefined, { device, session }: { device?: string; session?: string }): string | undefined {
  if (argument !== undefined && device !== undefined) throw new Error("Name the device once: cns ui DEVICE, or cns ui --device DEVICE.");
  if (session === undefined) return argument ?? device;
  const base = argument ?? device;
  if (base === undefined) throw new Error("--session needs its device: cns ui --device DEVICE --session NAME, or cns ui DEVICE/NAME.");
  if (base.includes("/")) throw new Error("Name the session once: cns ui DEVICE/NAME, or cns ui DEVICE --session NAME.");
  return `${base}/${session}`;
}
