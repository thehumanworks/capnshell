import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCli } from "./cli-program.js";
import { complete, completeCommand, localLookups, LOOKUP_MS, MAX_CANDIDATES, quote, SHELLS, unquote, type Borrowed, type Lookups } from "./completion.js";
import { makePrivateDirectory } from "./config.js";
import type { FileKind } from "./files.js";
import { fingerprint, generateIdentity } from "./identity.js";
import { PERMISSIONS, revokeDevice, savePairedPeer, type Permission } from "./peers.js";

/** A device as completion sees it through the local daemon's link: its files by absolute directory, and its sessions. */
interface FakeDevice {
  outgoing?: readonly Permission[];
  platform?: string;
  cwd?: string;
  directories?: Record<string, Array<{ name: string; kind: FileKind }>>;
  /** What each link points to, by its absolute path. */
  links?: Record<string, FileKind>;
  sessions?: string[];
  /** No daemon link to it: borrow finds none. */
  unlinked?: boolean;
  /** The call that never answers. */
  hangs?: "borrow" | "readdir" | "sessions";
}

function lookups(devices: Record<string, FakeDevice>) {
  const borrowed: string[] = [];
  const closed: string[] = [];
  const never = new Promise<never>(() => {});
  const fake: Lookups = {
    devices: () => Object.entries(devices).map(([name, device]) => ({ name, outgoing: device.outgoing ?? PERMISSIONS })),
    async borrow(name) {
      borrowed.push(name);
      const device = devices[name];
      if (!device || device.unlinked) return undefined;
      if (device.hangs === "borrow") return never;
      const remote: Borrowed = {
        info: async () => ({ platform: (device.platform ?? "linux") as NodeJS.Platform, cwd: device.cwd ?? "/home/me" }),
        readdir: async (directory) => {
          if (device.hangs === "readdir") return never;
          // As a file system does, with or without a trailing separator.
          const entries = device.directories?.[directory] ?? device.directories?.[directory.replace(/[\\/]+$/, "")];
          if (!entries) throw new Error(`ENOENT: no such file or directory, scandir '${directory}'`);
          return entries;
        },
        stat: async (target) => ({ kind: device.links?.[target] ?? "file" }),
        sessions: async () => device.hangs === "sessions" ? never : (device.sessions ?? []).map((session) => ({ name: session })),
        close: () => { closed.push(name); },
      };
      return remote;
    },
  };
  return { fake, borrowed, closed };
}

const program = createCli();
const studio: FakeDevice = {
  cwd: "/home/me",
  sessions: ["build", "work"],
  directories: {
    "/home/me": [{ name: "notes.txt", kind: "file" }, { name: "My Docs", kind: "directory" }, { name: ".config", kind: "directory" }, { name: "src", kind: "symlink" }, { name: "gone", kind: "symlink" }],
    "/home/me/My Docs": [{ name: "report.txt", kind: "file" }],
    "/srv": [{ name: "app", kind: "directory" }, { name: "apt.log", kind: "file" }],
  },
  links: { "/home/me/src": "directory", "/home/me/gone": "symlink" },
};
const at = (words: string[], devices: Record<string, FakeDevice> = { studio, stash: { outgoing: ["shell"] }, nas: {} }) => {
  const { fake } = lookups(devices);
  return complete(program, words, fake);
};

test("commands and options come from the program, without hidden ones", async () => {
  const top = await at([""]);
  for (const name of ["run", "shell", "cp", "sessions", "peer", "completion", "help"]) assert.ok(top.includes(name), name);
  assert.ok(!top.includes("__complete"));
  assert.deepEqual(await at(["s"]), ["screen", "secret", "sessions", "shell", "skills", "status", "stop"]);
  assert.deepEqual(await at(["peer", "re"]), ["remove", "revoke"]);
  assert.deepEqual(await at(["cp", "-"]), ["--help", "--recursive"]);
  assert.deepEqual(await at(["-"]), ["--help", "--token-file", "--version"]);
  // The daemon's own options are hidden.
  assert.deepEqual(await at(["daemon", "--"]), ["--help"]);
  assert.deepEqual(await at(["completion", ""]), [...SHELLS].sort());
});

test("paired devices complete wherever a command names one", async () => {
  for (const words of [["run", ""], ["shell", ""], ["sessions", ""], ["screen", ""], ["kill", ""], ["doctor", ""], ["upgrade", ""], ["wake", ""], ["mcp", ""], ["ui", ""], ["peer", "remove", ""], ["peer", "grant", ""], ["run", "--device", ""], ["wake", "studio", "--via", ""], ["audit", "--peer", ""], ["mesh", "add", "home", "nas", ""]]) {
    assert.deepEqual(await at(words), ["nas", "stash", "studio"], words.join(" "));
  }
  assert.deepEqual(await at(["run", "st"]), ["stash", "studio"]);
  assert.deepEqual(await at(["run", "-D", "st"]), ["stash", "studio"]);
  // Only the first operand is a device; after --, the command is the remote shell's.
  assert.deepEqual(await at(["run", "studio", ""]), []);
  assert.deepEqual(await at(["run", "studio", "--", ""]), []);
  assert.deepEqual(await at(["mesh", "add", ""]), []);
  assert.deepEqual(await at(["pair", ""]), []);
});

test("a device's named sessions complete through its link, when it lets this device list them", async () => {
  assert.deepEqual(await at(["screen", "studio", ""]), ["build", "work"]);
  assert.deepEqual(await at(["keys", "studio", "w"]), ["work"]);
  assert.deepEqual(await at(["keys", "-D", "studio", ""]), ["build", "work"]);
  assert.deepEqual(await at(["kill", "--device", "studio", "--session", ""]), ["build", "work"]);
  assert.deepEqual(await at(["shell", "studio", "--attach", "b"]), ["build"]);
  assert.deepEqual(await at(["ui", "studio/"]), ["studio/build", "studio/work"]);
  assert.deepEqual(await at(["ui", "-D", "studio", "-s", ""]), ["build", "work"]);
  // The keys after the session are not looked up.
  assert.deepEqual(await at(["keys", "studio", "build", ""]), []);
  // stash grants no sessions:list, so it is not asked; an unknown device neither.
  const { fake, borrowed } = lookups({ studio, stash: { outgoing: ["shell"], sessions: ["secret"] } });
  assert.deepEqual(await complete(program, ["screen", "stash", ""], fake), []);
  assert.deepEqual(await complete(program, ["screen", "laptop", ""], fake), []);
  assert.deepEqual(borrowed, []);
  // Names cns would refuse are dropped, whatever the device sends.
  assert.deepEqual(await at(["screen", "studio", ""], { studio: { sessions: ["ok", "$(reboot)", "a b", "-x", "x".repeat(65)] } }), ["ok"]);
});

test("cns cp completes DEVICE: and then the device's paths, one directory at a time", async () => {
  assert.deepEqual(await at(["cp", ""]), ["nas:", "stash:", "studio:"]);
  assert.deepEqual(await at(["cp", "./build.tar.gz", "stu"]), ["studio:"]);
  assert.deepEqual(await at(["cp", "-r", "st"]), ["stash:", "studio:"]);
  // A local path is left to the shell.
  assert.deepEqual(await at(["cp", "./st"]), []);
  assert.deepEqual(await at(["cp", "/tmp/x"]), []);
  // The home, with hidden entries once a dot is typed; a link to a directory is one.
  assert.deepEqual(await at(["cp", "studio:"]), ["studio:My Docs/", "studio:gone", "studio:notes.txt", "studio:src/"]);
  assert.deepEqual(await at(["cp", "studio:."]), ["studio:.config/"]);
  assert.deepEqual(await at(["cp", "studio:~/"]), ["studio:~/My Docs/", "studio:~/gone", "studio:~/notes.txt", "studio:~/src/"]);
  assert.deepEqual(await at(["cp", "studio:~"]), ["studio:~/"]);
  assert.deepEqual(await at(["cp", "studio:~/My"]), ["studio:~/My Docs/"]);
  assert.deepEqual(await at(["cp", "studio:My Docs/"]), ["studio:My Docs/report.txt"]);
  assert.deepEqual(await at(["cp", "notes.txt", "studio:/srv/ap"]), ["studio:/srv/app/", "studio:/srv/apt.log"]);
  assert.deepEqual(await at(["cp", "studio:/nowhere/"]), []);
});

test("paths on a Windows device keep the separator typed, and its drive letters", async () => {
  const windows: FakeDevice = {
    platform: "win32", cwd: "C:\\Users\\me",
    directories: { "C:\\Users\\me": [{ name: "Documents", kind: "directory" }], "C:\\": [{ name: "Users", kind: "directory" }, { name: "Windows", kind: "directory" }], "C:/": [{ name: "Users", kind: "directory" }] },
  };
  assert.deepEqual(await at(["cp", "pc:"], { pc: windows }), ["pc:Documents/"]);
  assert.deepEqual(await at(["cp", "pc:C:\\U"], { pc: windows }), ["pc:C:\\Users\\"]);
  assert.deepEqual(await at(["cp", "pc:C:/U"], { pc: windows }), ["pc:C:/Users/"]);
  assert.deepEqual(await at(["cp", "pc:~\\"], { pc: windows }), ["pc:~\\Documents\\"]);
});

test("a device without the files grant gets no path completion, and is not asked", async () => {
  const { fake, borrowed } = lookups({ stash: { outgoing: ["shell", "sessions:list"], directories: { "/home/me": [{ name: "x", kind: "file" }] } } });
  assert.deepEqual(await complete(program, ["cp", "stash:"], fake), []);
  assert.deepEqual(borrowed, []);
});

test("without a daemon link, a lookup offers nothing; one that does not answer is given up within the deadline", async () => {
  assert.deepEqual(await at(["screen", "studio", ""], { studio: { ...studio, unlinked: true } }), []);
  for (const hangs of ["borrow", "readdir", "sessions"] as const) {
    const { fake, closed } = lookups({ studio: { ...studio, hangs } });
    const started = performance.now();
    assert.deepEqual(await complete(program, hangs === "sessions" ? ["kill", "studio", ""] : ["cp", "studio:"], fake), [], hangs);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= LOOKUP_MS - 20 && elapsed < LOOKUP_MS + 250, `${hangs}: gave up after ${Math.round(elapsed)} ms`);
    // A link it got is closed, which ends the call still waiting on it.
    assert.deepEqual(closed, hangs === "borrow" ? [] : ["studio"], hangs);
  }
  const failing: Lookups = { devices: () => [{ name: "studio", outgoing: PERMISSIONS }], borrow: async () => { throw new Error("Permission denied: files not granted to laptop."); } };
  assert.deepEqual(await complete(program, ["cp", "studio:"], failing), []);
});

test("names from another device that a shell or terminal would misread are dropped, and the rest capped", async () => {
  const many = Array.from({ length: MAX_CANDIDATES + 50 }, (_, index) => ({ name: `f${String(index).padStart(4, "0")}`, kind: "file" as const }));
  const devices = {
    studio: { directories: { "/home/me": [...["ok", "tab\there", "new\nline", "bell\x07", "rtl\u202eevil", "zero\u200bwidth", "esc\x1b[31m"].map((name) => ({ name, kind: "file" as const })), ...many] } },
  };
  const { fake } = lookups(devices);
  const lines = await printed(["bash", "cp", "studio:"], fake);
  assert.equal(lines.length, MAX_CANDIDATES);
  assert.deepEqual(lines.filter((line) => !/^studio:(ok|f\d{4})$/.test(line)), []);
});

/** What cns __complete prints, line by line, and that it prints nothing on stderr. */
async function printed(args: string[], fake: Lookups): Promise<string[]> {
  const out: string[] = [];
  const write = process.stdout.write;
  const error = process.stderr.write;
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => { throw new Error("completion wrote to stderr"); }) as typeof process.stderr.write;
  try { assert.equal(await completeCommand(program, args, fake), 0); }
  finally { process.stdout.write = write; process.stderr.write = error; }
  return out.join("").split("\n").filter(Boolean);
}

test("cns __complete quotes for the shell, takes the words as the shell gives them, and fails quietly", async () => {
  const devices = { studio: { directories: { "/home/me": [{ name: "My Docs", kind: "directory" as const }, { name: "it's $(id).txt", kind: "file" as const }] } } };
  const { fake } = lookups(devices);
  assert.deepEqual(await printed(["bash", "cp", "studio:"], fake), ["studio:My\\ Docs/", "studio:it\\'s\\ \\$\\(id\\).txt"]);
  assert.deepEqual(await printed(["bash", "cp", "studio:My\\ D"], fake), ["studio:My\\ Docs/"]);
  assert.deepEqual(await printed(["bash", "cp", "'studio:My D"], fake), ["studio:My\\ Docs/"]);
  assert.deepEqual(await printed(["pwsh", "cp", "studio:"], fake), ["'studio:My Docs/'", "'studio:it''s $(id).txt'"]);
  assert.deepEqual(await printed(["pwsh", "cp", "'studio:My D'"], fake), ["'studio:My Docs/'"]);
  assert.deepEqual(await printed(["zsh", "cp", "studio:"], fake), ["studio:My Docs/", "studio:it's $(id).txt"]);
  assert.deepEqual(await printed(["fish", "cp", "studio:it"], fake), ["studio:it's $(id).txt"]);
  assert.deepEqual(await printed(["bash"], fake), (await complete(program, [""], fake)));
  for (const args of [[], ["tcsh", ""], ["bash", "cp", ":x"], ["bash", "--", "-V"], ["bash", "ui", "/"]]) assert.deepEqual(await printed(args, fake), [], args.join(" "));
});

test("device names are the records here, without removed devices, and a bad record is skipped quietly", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cns-complete-peers-")));
  makePrivateDirectory(dir);
  const saved = process.env.CNS_CONFIG_DIR;
  process.env.CNS_CONFIG_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = saved; rmSync(dir, { recursive: true, force: true }); });
  const add = (name: string) => {
    const { publicKey } = generateIdentity();
    savePairedPeer(name, { publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: ["files"] } });
    return publicKey;
  };
  add("studio");
  // A record left behind after cns peer remove, as from a backup.
  revokeDevice(fingerprint(add("lost")));
  writeFileSync(path.join(dir, "peers", "junk"), "not a record", { mode: 0o600 });
  const error = process.stderr.write;
  process.stderr.write = (() => { throw new Error("completion wrote to stderr"); }) as typeof process.stderr.write;
  try { assert.deepEqual(localLookups().devices(), [{ name: "studio", outgoing: ["files"] }]); }
  finally { process.stderr.write = error; }
});

test("quoting for bash and PowerShell reads back as the name it quotes", () => {
  const names = ["plain", "My Docs", "it's", "a\"b", "$HOME", "`id`", "$(id)", "a*b?[c]", "x;y&z|w", "<in>", "!bang", "{a,b}", "back\\slash", "C:\\Users\\", "日本語", "‘smart’", "#hash", "@at", "a,b", "x~y", "50%"];
  for (const name of names) {
    assert.equal(unquote("bash", quote("bash", name)), name, `bash ${name}`);
    assert.equal(unquote("pwsh", quote("pwsh", name)), name, `pwsh ${name}`);
  }
  const bash = spawnSync("bash", ["-c", `printf '%s\\n' ${names.map((name) => quote("bash", name)).join(" ")}`], { encoding: "utf8" });
  if (!bash.error) assert.deepEqual(bash.stdout.split("\n").slice(0, -1), names);
  assert.equal(quote("bash", "studio:~/notes.txt"), "studio:~/notes.txt");
  assert.equal(quote("pwsh", "studio:~/notes.txt"), "studio:~/notes.txt");
  assert.equal(quote("pwsh", "--json"), "--json");
  assert.equal(unquote("bash", "\"a\\ b\\$c\""), "a\\ b$c");
  assert.equal(unquote("bash", "a\\"), "a\\");
  assert.equal(unquote("pwsh", "\"a`\"b\""), "a\"b");
  assert.equal(unquote("pwsh", "'it''s'"), "it's");
  assert.equal(unquote("zsh", "a\\ b"), "a\\ b");
});
