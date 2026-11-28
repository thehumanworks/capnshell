import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { auditLog, readAuditLog, type AuditEntry } from "./audit.js";
import { audit, formatAudit, sinceTime } from "./commands/audit-cli.js";

const posix = process.platform !== "win32";

function directory(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cns-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (fields: Partial<AuditEntry> = {}): AuditEntry => ({
  start: "2026-11-28T10:00:00.000Z", peer: "laptop", fingerprint: "k7qm-3h2x-aaaa-bbbb-cccc-dddd", action: "run", target: "make test", ...fields,
});

test("the audit log appends one JSON line per entry to a file only its owner can read", (t) => {
  const file = path.join(directory(t), "audit.log");
  const reports: string[] = [];
  const write = auditLog({ file, report: (message) => reports.push(message) });
  write(entry({ end: "2026-11-28T10:00:02.000Z", exitCode: 0 }));
  write(entry({ action: "file.read", target: "/etc/hosts" }));
  const lines = readFileSync(file, "utf8").split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "");
  assert.deepEqual(JSON.parse(lines[1]!), entry({ action: "file.read", target: "/etc/hosts" }));
  assert.deepEqual(readAuditLog(file).map((logged) => logged.action), ["run", "file.read"]);
  if (posix) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(reports, []);
  // A line cut short, as by a crash while it was written, is skipped, and the next entry starts a line of its own.
  writeFileSync(file, '{"start":"2026', { flag: "a" });
  write(entry({ target: "after" }));
  assert.deepEqual(readAuditLog(file).map((logged) => logged.target), ["make test", "/etc/hosts", "after"]);
});

test("the audit log moves to audit.log.1 at its size cap, so the two never grow past twice it", (t) => {
  const file = path.join(directory(t), "audit.log");
  const maxBytes = 1000;
  const write = auditLog({ file, maxBytes, report: (message) => assert.fail(message) });
  for (let index = 0; index < 40; index++) write(entry({ target: `command ${index}` }));
  assert.ok(existsSync(`${file}.1`));
  for (const name of [file, `${file}.1`]) {
    assert.ok(statSync(name).size <= maxBytes, `${name} is ${statSync(name).size} bytes`);
    if (posix) assert.equal(statSync(name).mode & 0o777, 0o600);
  }
  // The newest entries are kept, in order; the oldest went with the earlier rotations.
  const kept = readAuditLog(file).map((logged) => Number(logged.target.split(" ")[1]));
  assert.ok(kept.length > 4 && kept.length < 40);
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, index) => 40 - kept.length + index));
});

test("a log that cannot be written is reported once and never fails the caller", (t) => {
  const dir = directory(t);
  const reports: string[] = [];
  const missing = auditLog({ file: path.join(dir, "gone", "audit.log"), report: (message) => reports.push(message) });
  for (let index = 0; index < 3; index++) missing(entry());
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /^Cannot write the audit log, so what paired devices do here goes unrecorded until it can be written \(reported once\): /);
  if (!posix) return;
  // Not to a file others can read, and not through a link.
  const shared = path.join(dir, "shared.log");
  writeFileSync(shared, "");
  chmodSync(shared, 0o644);
  const refused: string[] = [];
  auditLog({ file: shared, report: (message) => refused.push(message) })(entry());
  assert.equal(readFileSync(shared, "utf8"), "");
  assert.match(refused[0]!, new RegExp(`must be a private file owned by your user: ${shared}\\. To make it one, run: chmod 600 ${shared}$`));
  assert.throws(() => readAuditLog(shared), /To make it one, run: chmod 600/);
  const link = path.join(dir, "link.log");
  symlinkSync(shared, link);
  const linked: string[] = [];
  auditLog({ file: link, report: (message) => linked.push(message) })(entry());
  assert.equal(linked.length, 1);
  assert.equal(readFileSync(shared, "utf8"), "");
});

test("cns audit prints the newest entries first, filtered by peer and time, as a table or JSON", (t) => {
  const dir = directory(t);
  const saved = process.env.CNS_CONFIG_DIR;
  process.env.CNS_CONFIG_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = saved; });
  const printed: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, "log", (text: string) => printed.push(text));
  t.mock.method(console, "error", (text: string) => errors.push(text));
  const run = (options: Parameters<typeof audit>[0]) => { printed.length = 0; errors.length = 0; audit(options); return printed.join("\n"); };

  assert.equal(run({}), "");
  assert.match(errors[0]!, /^Nothing recorded yet in .*audit\.log: the daemon records there what paired devices do on this device\.$/);
  const hour = 3_600_000;
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const write = auditLog({ file: path.join(dir, "audit.log") });
  const made = { start: at(3 * hour), cwd: "/srv/app", secrets: ["home:NPM_TOKEN"] };
  write(entry({ ...made, phase: "start" }));
  write(entry({ ...made, end: at(3 * hour - 2000), exitCode: 0 }));
  write(entry({ start: at(2 * hour), peer: "studio", fingerprint: "zzzz", action: "session.start", target: "build", command: "npm run dev" }));
  write(entry({ start: at(hour), action: "file.read", target: "/etc/shadow", error: "Permission denied: files not granted to laptop." }));
  // Still running, or its daemon stopped before it ended: only its start is there.
  write(entry({ start: at(hour / 2), target: "sleep 9999", phase: "start" }));
  write(entry({ start: at(1000), end: at(0), action: "terminal", target: "(login shell)\u001b]0;pwned\u0007", exitCode: null, signal: "SIGHUP" }));

  const table = run({}).split("\n");
  assert.match(table[0]!, /^STARTED \(UTC\) +PEER +ACTION +RESULT +TARGET$/);
  assert.match(table[1]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d +laptop +terminal +killed by SIGHUP after 1s +\(login shell\)\?\]0;pwned\?$/);
  assert.match(table[2]!, /laptop +run +no end recorded +sleep 9999$/);
  assert.match(table[3]!, /laptop +file\.read +failed +\/etc\/shadow: Permission denied: files not granted to laptop\.$/);
  assert.match(table[4]!, /studio +session\.start +ok +build: npm run dev$/);
  assert.match(table[5]!, /laptop +run +exited 0 after 2s +make test \(in \/srv\/app\) with secrets home:NPM_TOKEN$/);
  assert.equal(table.length, 6, "a command that ended is shown once");

  assert.deepEqual(JSON.parse(run({ json: true, peer: "studio" })).map((logged: AuditEntry) => logged.target), ["build"]);
  assert.deepEqual(JSON.parse(run({ json: true, peer: "zzzz" })).map((logged: AuditEntry) => logged.peer), ["studio"]);
  assert.deepEqual(JSON.parse(run({ json: true })).filter((logged: AuditEntry) => logged.action === "run").map((logged: AuditEntry) => [logged.target, logged.phase]),
    [["sleep 9999", "start"], ["make test", undefined]]);
  assert.equal(JSON.parse(run({ json: true, since: "90m" })).length, 3);
  assert.equal(JSON.parse(run({ json: true, limit: "1" }))[0].action, "terminal");
  assert.deepEqual(JSON.parse(run({ json: true, peer: "nobody" })), []);
  assert.equal(run({ peer: "nobody" }), "");
  assert.match(errors[0]!, /No entries match\. Run cns audit without --peer and --since/);
  assert.throws(() => audit({ limit: "0" }), /--limit takes a number of entries, such as 100\./);
  assert.throws(() => audit({ since: "yesterday" }), /--since takes a time ago, such as 30m, 2h or 7d/);
});

test("--since takes a time ago or a date", () => {
  const now = Date.parse("2026-11-28T12:00:00Z");
  assert.equal(sinceTime("30m", now), now - 30 * 60_000);
  assert.equal(sinceTime("2d", now), now - 2 * 86_400_000);
  assert.equal(sinceTime("45s", now), now - 45_000);
  assert.equal(sinceTime("2026-11-28T09:00Z", now), Date.parse("2026-11-28T09:00Z"));
  assert.throws(() => sinceTime("1w", now), /--since takes/);
  assert.equal(formatAudit([]).split("\n").length, 1);
});
