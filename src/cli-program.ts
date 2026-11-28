import { Command, Option } from "commander";
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
  const daemon = addDaemonCommand(program, async (config) => {
    if (config.supervise) {
      // The Windows scheduled task's command: Task Scheduler restarts only a task it cannot start.
      const { superviseDaemon } = await import("./service.js");
      await superviseDaemon(config);
      return;
    }
    const { startPeer } = await import("./commands/peer.js");
    await startPeer(config);
  });
  addMcpCommand(program, async (config) => {
    const { startMcp } = await import("./commands/mcp.js");
    await startMcp(config);
  });
  const alias = program.command("peer").description("Manage paired devices: their names, grants and addresses");
  const pairedDevice = "A paired device's name, or --device";
  alias.command("remove").usage("[options] <name>").argument("[name]", pairedDevice).description("Unpair a device: forget it here, and end its links at once; with --everywhere, a lost one everywhere")
    .addOption(deviceOption("The paired device, in place of the NAME argument"))
    .option("-F, --fingerprint <fingerprint>", "The device with this fingerprint, in place of its name: one another device names otherwise, or one removed here already")
    .option("-E, --everywhere", "For a lost or stolen device: also take it out of the meshes this device runs, the gateway CNS_GATEWAY names if this device is an owner, and every paired device that lets this one run commands")
    // What --everywhere runs on each device: also the meshes this device runs, and those the device runs.
    .addOption(new Option("--meshes").hideHelp())
    .option("-n, --dry-run", "Show what would change in each place, and change nothing")
    .option("-j, --json", "Print each place as JSON: [{ device, place, outcome, detail, next }], device null for this device and the gateway")
    .option("-S, --state <path>", "Local daemon state file")
    .addHelpText("after", [
      "",
      "For a lost device, on one you trust:  cns peer remove phone --everywhere --dry-run",
      "                                      cns peer remove phone --everywhere",
      "That also takes it out of the meshes this device runs, the gateway CNS_GATEWAY names, and each",
      "paired device that lets this one run commands, by that device's own cns peer remove. Each place",
      "is reported with what to run there or later. Running it again is safe, but narrows again a mesh",
      "allowed again since; once the device is gone here, name it by its fingerprint.",
      "A removed device gets no record here from any mesh again, until you pair with it directly. A mesh",
      "it runs stays at its last list here, and its members may use nothing here; to end it here: cns",
      "mesh leave NAME. cns mesh allow undoes that, but only once cns mesh list NAME shows no device you",
      "do not know.",
      "Exit status with --everywhere, --fingerprint, --dry-run or --json: 0 when done, 4 when a place",
      "still needs something run there, 1 when a place was unreachable or failed.",
    ].join("\n"))
    .action(async (name: string | undefined, given: { device?: string; fingerprint?: string; everywhere?: boolean; meshes?: boolean; dryRun?: boolean; json?: boolean; state?: string }) => {
      const { device: _device, ...options } = given;
      // --fingerprint names the device in place of NAME or --device.
      if (options.fingerprint !== undefined && (name !== undefined || given.device !== undefined)) throw new Error("Name the device once: cns peer remove NAME, or cns peer remove --fingerprint FINGERPRINT.");
      const chosen = options.fingerprint === undefined ? paired("peer remove", "NAME", [name], given) : undefined;
      if (chosen) once("peer remove", "NAME", chosen.after);
      const { removeCommand, removePeer } = await import("./commands/remove-everywhere.js");
      process.exitCode = chosen && !options.everywhere && !options.meshes && !options.dryRun && !options.json
        ? await removePeer(chosen.device, options) : await removeCommand(chosen?.device, options);
    });
  alias.command("grant").usage("[options] <name> <grants...>").argument("[name]", pairedDevice).argument("[grants...]").description("Let a paired device use more of this device: shell, files, skills, sessions, all or permissions")
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
    .option("-j, --json", "Print a JSON array sorted by name, [] when there are none: { name, fingerprint, publicKey, addresses, grants, mesh?, revoked } per device")
    .action(async (options: { json?: boolean }) => {
      const { listPeers, revokedDevices } = await import("./peers.js");
      const removed = revokedDevices();
      const peers = listPeers().map((peer) => ({ name: peer.name, fingerprint: peer.fingerprint, publicKey: peer.publicKey, addresses: peer.addresses, grants: peer.grants, ...peer.mesh === undefined ? {} : { mesh: peer.mesh }, revoked: removed.has(peer.fingerprint) }));
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
    .option("-g, --gateway", "The device is the cns gateway: members let Claude's connectors in through it, never dial it or share secrets with it (default limit: what it may use here)")
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
  const skills = program.command("skills").description("Agent skills from ~/.agents/skills on this device and every paired device, as one set")
    .addHelpText("after", [
      "",
      "laptop $ cns skills list                          (every skill, the newest copy of each)",
      "laptop $ cns skills load pdf                      (prints the newest pdf skill's SKILL.md)",
      "laptop $ cns skills load studio:pdf               (studio's own copy)",
      "laptop $ cns skills ls pdf; cns skills cat pdf scripts/fill.py",
      "laptop $ cns skills rg -i 'invoice'",
      "laptop $ cns skills sync pdf                      (copies it into this device's ~/.agents/skills)",
      "laptop $ cns skills sync --to studio: pdf         (into studio's ~/.agents/skills)",
      "",
      "A skill is a directory in ~/.agents/skills that holds a SKILL.md; its name is the directory's.",
      "Each device keeps its own. Where several hold a skill of the same name, the one modified last",
      "wins: the copy whose newest file is newest, compared in UTC to the second, with this device first",
      "on a tie. NAME is that copy; DEVICE:NAME is the paired device's own. Hidden files, such as .git",
      "or .env, are not part of a skill, and a link is followed only to a file inside its skill.",
      "",
      "A paired device is read when it grants this one skills (read-only, its skills alone) or files:",
      "on it, run cns peer grant NAME skills. Devices that do not, or do not answer within 10 seconds,",
      "are named on stderr. sync keeps each file's modification time, so a copy ties with its source",
      "rather than looking newer, and needs the files grant on a paired device it copies to.",
    ].join("\n"));
  const skillCommands = () => import("./commands/skills-cli.js");
  const skillTarget = ["<skill>", "NAME, the newest copy, or DEVICE:NAME for that paired device's"] as const;
  skills.command("list").description("List every skill once, from the device with its newest copy")
    .option("-j, --json", "Print { skills: [{ name, device, modified, description, copies: [{ device, modified }] }], devices: [{ device, state, reason }] }; device is null for this device")
    .action(async (options) => { process.exitCode = await (await skillCommands()).listCommand(options); });
  skills.command("load").usage("[DEVICE:]NAME").argument(...skillTarget)
    .description("Print a skill's SKILL.md; stderr says where it came from and names its other files")
    .action(async (target: string) => { await (await skillCommands()).loadCommand(target); });
  skills.command("ls").usage("[DEVICE:]NAME").argument(...skillTarget)
    .description("List a skill's files, with their sizes and modification times")
    .action(async (target: string) => { await (await skillCommands()).lsCommand(target); });
  skills.command("cat").usage("[DEVICE:]NAME FILE...").argument(...skillTarget).argument("<files...>", "Paths inside the skill, such as references/api.md")
    .description("Print files of a skill")
    .action(async (target: string, files: string[]) => { await (await skillCommands()).catCommand(target, files); });
  skills.command("rg").usage("[options] PATTERN [[DEVICE:]NAME...]").argument("<pattern>", "A JavaScript regular expression").argument("[skills...]", "The skills to search; without any, the newest copy of every skill")
    .description("Print the lines of skills' files that match a pattern, as NAME/FILE:LINE:TEXT; exit 1 when none match")
    .option("-i, --ignore-case", "Match letters in either case")
    .action(async (pattern: string, targets: string[], options) => { process.exitCode = await (await skillCommands()).rgCommand(pattern, targets, options); });
  skills.command("sync").usage("[options] [DEVICE:]NAME...").argument("<skills...>", "NAME, the newest copy, or DEVICE:NAME for that paired device's")
    .description("Copy skills into this device's ~/.agents/skills, or to --to, keeping their files' times")
    .option("-t, --to <[device:]path>", "Copy into this directory instead: on a paired device as DEVICE:PATH, or DEVICE: for its ~/.agents/skills")
    .addHelpText("after", "\nEach skill goes to PATH/NAME. Its files replace files of the same name there, and other files\nthere are kept. A PATH/NAME that is not a skill (it has no SKILL.md) is never copied over.")
    .action(async (targets: string[], options) => { await (await skillCommands()).syncCommand(targets, options); });
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
    .option("-d, --devices <names>", "The devices it may reach, comma-separated, or all: every one paired with the gateway, now and later (default: all)")
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
  // cns up and cns stop are cns daemon start and cns daemon stop under their older, shorter names.
  const startCommand = (command: Command) => command
    .option(...tokenFileOption)
    .option("-b, --bind <address>", "Interface to listen on (default: every interface; CNS_BIND)")
    .option("-p, --port <port>", "TCP port (default: 47381; CNS_PORT)")
    .option("-S, --state <path>", "Local daemon state file")
    .option("-i, --install", "Run the daemon as a service that starts at login and restarts if it fails: a launchd agent on macOS, a systemd user service on Linux, a scheduled task on Windows")
    .option("-u, --uninstall", "Stop the service's daemon and remove the service")
    .addHelpText("after", "\nOnly paired devices can connect, after authenticating; each gets what cns pair granted it.\nThe daemon also registers at the relay built into cns, so paired devices on other networks reach it\nwith nothing to set up. Links are encrypted end to end, directly or through the relay. Pair with cns pair.\n--install keeps the running daemon's --bind and --port unless given; run it again to change them.")
    .action(async (options) => { const { up } = await import("./commands/pairing-cli.js"); await up(options); });
  // Named sessions run in processes of their own except on Windows, where they end with the daemon (held-sessions.ts).
  const keeps = process.platform === "win32" ? "" : "; named sessions keep running";
  const stopCommand = (command: Command) => command
    .option("-S, --state <path>", "Local daemon state file")
    .addOption(new Option("-E, --end-sessions", "End the named sessions too, also those an older cns left running out of its reach").hideHelp(process.platform === "win32"))
    .addHelpText("after", process.platform === "win32" ? "" : "\nNamed sessions keep running once the daemon stops, and the next daemon adopts them. cns stop names\neach with its holder's pid; --end-sessions ends them, also when no daemon runs, as after a crash.")
    .action(async (options: { state?: string; endSessions?: boolean }) => {
      const [{ daemonStatePath, keptSessions, removeStaleState, stopDaemon }, { sessionFacts }, { sessionsHint }, { sessionsLeft }] = await Promise.all([
        import("./commands/daemon.js"), import("./commands/pairing-cli.js"), import("./version.js"), import("./held-sessions.js"),
      ]);
      const state = daemonStatePath(options.state);
      let stopped: Awaited<ReturnType<typeof stopDaemon>> | undefined;
      try { stopped = await stopDaemon(options.state); }
      catch (error) {
        // With no daemon to stop, --end-sessions still ends the sessions one left running: also one
        // that crashed and left its state file, which goes once its daemon does not answer and its pid is gone.
        const none = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!options.endSessions || !(none || await removeStaleState(options.state))) throw error;
      }
      console.log(stopped ? "Daemon stopped." : "No daemon is running.");
      if (stopped?.ended.length) {
        const hint = sessionsHint(sessionFacts(stopped.status, state));
        console.log(`Named sessions ended with it: ${stopped.ended.join(", ")}.${hint ? ` ${hint}` : ""}`);
      }
      if (options.endSessions) {
        const { sessions, notes } = await sessionsLeft(state, true);
        if (sessions.length) console.log(`Named sessions ended: ${sessions.map(({ name, pid }) => `${name} (holder pid ${pid})`).join(", ")}.`);
        for (const note of notes) console.log(note);
      } else if (stopped?.kept.length) {
        const { sessions, notes } = await sessionsLeft(state, false);
        const pids = new Map(sessions.map(({ name, pid }) => [name, pid]));
        console.log(keptSessions(stopped.kept.map((name) => ({ name, pid: pids.get(name) }))));
        for (const note of notes) console.log(note);
      }
    });
  startCommand(daemon.command("start").description("Run this device as a paired peer: start its daemon, or report the running one (also cns up)"));
  stopCommand(daemon.command("stop").description(`Stop the daemon and its peer connections${keeps}; a service starts it again at the next login or cns daemon start (also cns stop)`));
  daemon.command("restart")
    .description("Stop the daemon and start it again as it runs now, also when a paired device runs this, which drops its link")
    .option("-S, --state <path>", "Local daemon state file")
    .addOption(new Option("--worker <ms>").hideHelp())
    // From cns up --install, which rewrote the service's file: launchd loads it again rather than start the copy it has.
    .addOption(new Option("--reload").hideHelp())
    .addHelpText("after", "\nThe daemon comes back through its service when one runs it (systemd restarts it, launchd or Task\nScheduler starts it again), else detached with the same --bind and --port, running this cns. A paired device can run it:\n  cns run studio -- cns daemon restart\nIt then returns at once, the daemon restarts a second later, and the link comes back within seconds.\nNamed sessions keep running across the restart, in processes of their own; a reboot ends them, and\nso does the restart on Windows, or under a systemd unit an older cns wrote until cns up --install\nwrites it again. A daemon that was not running is started.")
    .action(async (options: { state?: string; worker?: string; reload?: boolean }) => { const { restart } = await import("./commands/pairing-cli.js"); await restart(options); });
  startCommand(program.command("up").description("Run this device as a paired peer: start its daemon, or report the running one (also cns daemon start)"));
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
  program.command("audit")
    .description("Show what paired devices did on this device: the commands, terminals, sessions, files and skills they used")
    .option("-p, --peer <name>", "Only what this paired device did: its name here, or its fingerprint")
    .option("-t, --since <time>", "Only what happened since then: a time ago such as 30m, 2h or 7d, or a date such as 2026-11-28")
    .option("-l, --limit <n>", "How many entries, newest first (default: 50)")
    .option("-j, --json", "Print a JSON array, newest first: { start, end, phase, id, peer, fingerprint, action, target, cwd, command, secrets, variables, exitCode, signal, timedOut, error } per entry, each field only when it applies")
    .addHelpText("after", [
      "",
      "The daemon appends a line to audit.log in ~/.cns (or CNS_CONFIG_DIR) for each command and terminal a",
      "paired device runs here, each named session it starts, attaches to or kills and each one's end, each",
      "file it reads or writes, each skill file it reads, and refusals. A command or terminal gets a line as",
      "it starts and one as it ends, with its exit status; this shows them once, as \"no end recorded\" while",
      "it runs or when the daemon stopped before it ended. A program's line names the mesh secrets it got",
      "here (secrets) and the variables the device gave it (variables), such as a --secret from cns run;",
      "never their values. File contents and typed keys never appear either.",
      "Past 10 MB the log moves to audit.log.1, so the two hold at most 20 MB. Only your user can read them.",
      "Another device's log: cns run studio -- cns audit --since 1d",
    ].join("\n"))
    .action(async (options) => { const { audit } = await import("./commands/audit-cli.js"); audit(options); });
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
  program.command("upgrade")
    .description("Upgrade cns on a paired device, or on every one, to the latest release, and restart its daemon on it")
    .argument("[device]", "A paired device's name; without one, --all")
    .addOption(deviceOption("The paired device, in place of the DEVICE argument"))
    .option("-a, --all", "Every paired device")
    .option("-n, --dry-run", "Show what each device runs and what would run there, changing nothing")
    .option("-E, --end-sessions", "Upgrade a device even though restarting its daemon ends its named sessions")
    .addHelpText("after", [
      "",
      "Each device is upgraded through the shell grant it gives this one, with the commands cns run would",
      "run there. A cns that mise installed gets the release by its exact version (mise use -g",
      "github:thehumanworks/capnshell@VERSION, or the tool alias mise's config gives it there, which pins",
      "it in mise's global config); then the new cns restarts the daemon in a process of its own, as cns",
      "daemon restart does, or with cns up --install where a service still runs the old cns, so the device",
      "keeps a daemon. Its named sessions outlive the restart, except where the daemon runs them itself",
      "(Windows, an older cns, or a systemd unit without KillMode=process); such a device with any, or",
      "whose cns is too old to say, is left as it is unless --end-sessions. So is a device whose cns Nix",
      "manages, or that was installed another way; the report says what to run there.",
      "The report has one line per device: upgraded, already current, needs a manual step, or unreachable,",
      "with what to run later. Exit 1 when a device did not answer or a step failed there, else 4 when a",
      "device needs a manual step, else 0, also for a --dry-run whose plans would all go ahead.",
    ].join("\n"))
    .action(async (name: string | undefined, { device, ...options }: { device?: string; all?: boolean; dryRun?: boolean; endSessions?: boolean }) => {
      const { upgrade } = await import("./commands/upgrade.js");
      process.exitCode = await upgrade(oneDevice("upgrade", name, device), options);
    });
  program.command("wake")
    .description("Wake a sleeping paired device: this device, or a paired one on its network, sends it a Wake-on-LAN packet")
    .argument("[device]", "A paired device's name")
    .addOption(deviceOption("The paired device to wake, in place of the DEVICE argument"))
    .option("-v, --via <device>", "Only this paired device sends the packet, through the shell grant it gives this one (default: this device and each paired device known to be on DEVICE's network)")
    .option("-m, --mac <mac>", "Send the packet from this device for the network card with this MAC address, in place of DEVICE; each sender runs this")
    .option("-a, --address <ip>", "With --mac: the card's IPv4 address, so the packet goes to the network here that holds it")
    .addHelpText("after", [
      "",
      "Daemons tell paired devices their network cards over their links, and each device keeps the last",
      "it heard, so it knows them once a device sleeps. cns wake DEVICE sends the packet from this device",
      "when it is on one of DEVICE's networks, and asks each paired device that said it is on one to send",
      "it too, by running cns wake --mac there through the shell grant it gives this one, as cns run would.",
      "A packet goes to UDP port 9 at the network's broadcast address and at 255.255.255.255, so it does",
      "not cross a router. DEVICE must have Wake-on-LAN turned on, which most machines allow only on a",
      "wired card. Exit 0 when a packet went out, 4 when each sender refused this device, else 1.",
      "Examples: cns wake studio    cns wake studio --via nas    cns wake --mac 3c:22:fb:12:34:56",
    ].join("\n"))
    .action(async (name: string | undefined, { device, ...options }: { device?: string; via?: string; mac?: string; address?: string }) => {
      const { wake } = await import("./commands/wake.js");
      process.exitCode = await wake(oneDevice("wake", name, device), options);
    });
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
  stopCommand(program.command("stop").description(`Stop the local daemon and its peer connections${keeps} (also cns daemon stop)`));
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
