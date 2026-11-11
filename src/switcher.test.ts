import assert from "node:assert/strict";
import test from "node:test";
import type { PtySessionInfo } from "./shell.js";
import {
  draw, entered, fit, initialState, listed, parseKeys, parseSwitchKey, press, rows,
  type DeviceListing, type Effect, type Key, type SessionRef, type SwitcherState,
} from "./switcher.js";

const session = (name: string, more: Partial<PtySessionInfo> = {}): PtySessionInfo => ({
  name, command: null, cwd: "/home/tomas", pid: 100 + name.length, cols: 120, rows: 40, title: "", startedAt: "2026-11-11T10:00:00.000Z",
  running: true, exit: null, viewers: 0, outputBytes: 500, owner: null, ...more,
});
const ended = { exitCode: 0, signal: null, signalNumber: null, timedOut: false, elapsedMs: 10, error: null };
const fleet: DeviceListing[] = [
  { device: "lf", state: "listed", via: "direct", sessions: [session("tty-1", { title: "bun test" }), session("tty-2", { command: "vim src/pty.ts" })] },
  { device: "beelink", state: "not-granted", reason: "beelink does not let this device list its sessions (sessions:list)" },
  { device: "thestudio", state: "listed", via: "relay", sessions: [session("build", { command: "nix build", running: false, exit: ended }), session("agent", { title: "Claude Code", owner: "ccg5" })] },
];
const ref = (device: string, name: string): SessionRef => {
  const listing = fleet.find((entry) => entry.device === device);
  const found = listing?.state === "listed" ? listing.sessions.find((one) => one.name === name) : undefined;
  return { device, name, ...found ? { pid: found.pid, startedAt: found.startedAt } : {} };
};
const state = (more: Partial<SwitcherState> = {}): SwitcherState => ({ ...initialState(["lf", "beelink", "thestudio"]), devices: fleet, selected: "lf/tty-1", ...more });
const key = (name: Exclude<Key["name"], "char">): Key => ({ name });
const char = (value: string): Key => ({ name: "char", char: value });
/** Press keys one after another, returning the final state and every effect along the way. */
const keys = (start: SwitcherState, ...pressed: Key[]) => {
  let current = start;
  const effects: Effect[] = [];
  for (const one of pressed) {
    const result = press(current, one);
    current = result.state;
    if (result.effect.kind !== "none") effects.push(result.effect);
  }
  return { state: current, effects };
};

test("rows list each device, its note-worthy state and its sessions, numbering the first nine", () => {
  assert.deepEqual(rows(state()).map((row) => row.kind === "session" ? `${row.number} ${row.key}` : row.key),
    ["lf", "1 lf/tty-1", "2 lf/tty-2", "beelink", "thestudio", "3 thestudio/build", "4 thestudio/agent"]);
  const many: DeviceListing[] = [{ device: "lf", state: "listed", via: "direct", sessions: Array.from({ length: 11 }, (_, index) => session(`s${index + 1}`)) }];
  assert.deepEqual(rows({ devices: many }).flatMap((row) => row.kind === "session" ? [row.number] : []), [1, 2, 3, 4, 5, 6, 7, 8, 9, null, null]);
});

/** What each key does, from a state, as [keys, effects, a check on the state after]. */
const cases: Record<string, { from?: Partial<SwitcherState>; press: Key[]; effects: Effect[]; then?: (after: SwitcherState) => void }> = {
  "down, j, up and k move the selection one row at a time": {
    press: [key("down"), char("j"), key("up")], effects: [],
    then: (after) => assert.equal(after.selected, "lf/tty-2"),
  },
  "down at the bottom stays at the bottom": { from: { selected: "thestudio/agent" }, press: [key("down"), char("j")], effects: [], then: (after) => assert.equal(after.selected, "thestudio/agent") },
  "up at the top stays at the top": { from: { selected: "lf" }, press: [key("up"), char("k")], effects: [], then: (after) => assert.equal(after.selected, "lf") },
  "Enter on a session opens it": { from: { selected: "thestudio/agent" }, press: [key("enter")], effects: [{ kind: "attach", ref: ref("thestudio", "agent") }] },
  "Enter on a device starts the next tty-N there": { from: { selected: "beelink" }, press: [key("enter")], effects: [{ kind: "new", device: "beelink" }] },
  "a digit opens that numbered session": { press: [char("3")], effects: [{ kind: "attach", ref: ref("thestudio", "build") }], then: (after) => assert.equal(after.selected, "thestudio/build") },
  "a digit with no session says so": { press: [char("9")], effects: [], then: (after) => assert.equal(after.message, "No session 9.") },
  "Tab opens the session before the last one": { from: { previous: ref("lf", "tty-2"), current: ref("lf", "tty-1") }, press: [key("tab")], effects: [{ kind: "attach", ref: ref("lf", "tty-2") }] },
  "Tab with no earlier session says so": { press: [key("tab")], effects: [], then: (after) => assert.equal(after.message, "No previous session yet.") },
  "Esc returns to the session the switcher was opened from": { from: { current: ref("lf", "tty-2") }, press: [key("escape")], effects: [{ kind: "attach", ref: ref("lf", "tty-2") }] },
  "the switch key also returns, so pressing it twice is a no-op": { from: { current: ref("lf", "tty-2") }, press: [key("switch")], effects: [{ kind: "attach", ref: ref("lf", "tty-2") }] },
  "Esc with nowhere to return stays and says what to do": { press: [key("escape")], effects: [], then: (after) => assert.match(after.message!, /press d to leave/) },
  "n starts the next tty-N on the selected session's device": { from: { selected: "thestudio/agent" }, press: [char("n")], effects: [{ kind: "new", device: "thestudio" }] },
  "x asks before killing, and y kills": { from: { selected: "thestudio/build" }, press: [char("x"), char("y")], effects: [{ kind: "kill", ref: ref("thestudio", "build") }] },
  "any other answer keeps the session": {
    from: { selected: "thestudio/build" }, press: [char("x"), char("n")], effects: [],
    then: (after) => assert.deepEqual([after.confirmKill, after.message], [null, "Kept thestudio/build."]),
  },
  "x on a device kills nothing": { from: { selected: "lf" }, press: [char("x"), char("y")], effects: [], then: (after) => assert.equal(after.confirmKill, null) },
  "+ adds the selected session as a pane": { from: { selected: "thestudio/agent", panes: ["lf/tty-1"] }, press: [char("+")], effects: [{ kind: "add-pane", ref: ref("thestudio", "agent") }] },
  "+ on a device starts a session there in a pane of its own": { from: { selected: "beelink", panes: ["lf/tty-1"] }, press: [char("+")], effects: [{ kind: "new", device: "beelink", pane: true }] },
  "+ on a session already in a pane says so": {
    from: { selected: "lf/tty-2", panes: ["lf/tty-1", "lf/tty-2"] }, press: [char("+")], effects: [],
    then: (after) => assert.equal(after.message, "lf/tty-2 is already in a pane."),
  },
  "+ with every pane taken says how to free one": {
    from: { selected: "thestudio/agent", panes: ["a/1", "a/2", "a/3", "a/4"] }, press: [char("+")], effects: [],
    then: (after) => assert.match(after.message!, /up to 4 panes; - removes/),
  },
  "- closes the current session's pane when there are several": { from: { panes: ["lf/tty-1", "lf/tty-2"] }, press: [char("-")], effects: [{ kind: "remove-pane" }] },
  "- with one session on screen says how to leave": { from: { panes: ["lf/tty-1"] }, press: [char("-")], effects: [], then: (after) => assert.match(after.message!, /Only one session is on screen/) },
  "d detaches": { press: [char("d")], effects: [{ kind: "detach" }] },
  "q detaches": { press: [char("q")], effects: [{ kind: "detach" }] },
  "Ctrl-C detaches, even while asking to kill": { from: { selected: "lf/tty-1" }, press: [char("x"), key("interrupt")], effects: [{ kind: "detach" }] },
  "a key clears the last message": { from: { message: "Killed lf/tty-9." }, press: [key("down")], effects: [], then: (after) => assert.equal(after.message, null) },
};
for (const [name, { from, press: pressed, effects, then }] of Object.entries(cases)) {
  test(`switcher: ${name}`, () => {
    const result = keys(state(from), ...pressed);
    assert.deepEqual(result.effects, effects);
    then?.(result.state);
  });
}

test("entering a session makes it current and the one before it previous, unless it is the same", () => {
  let current = entered(state(), ref("lf", "tty-1"));
  assert.deepEqual([current.current?.name, current.previous], ["tty-1", null]);
  current = entered(current, ref("thestudio", "agent"));
  assert.deepEqual([current.current?.name, current.previous?.name, current.selected], ["agent", "tty-1", "thestudio/agent"]);
  current = entered(current, ref("thestudio", "agent"));
  assert.equal(current.previous?.name, "tty-1", "returning to the same session keeps the one before it");
  current = entered(current, ref("lf", "tty-1"));
  assert.equal(current.previous?.name, "agent", "so Tab toggles between the two latest");
});

test("new listings keep the selection, or move it to its device when its session went away", () => {
  const before = state({ selected: "thestudio/build" });
  const kept = listed(before, { device: "lf", state: "listed", via: "direct", sessions: [] });
  assert.equal(kept.selected, "thestudio/build");
  const gone = listed(before, { device: "thestudio", state: "listed", via: "relay", sessions: [session("agent")] });
  assert.equal(gone.selected, "thestudio");
  const unreachable = listed(before, { device: "thestudio", state: "unreachable", reason: "no answer within 10 seconds" });
  assert.equal(unreachable.selected, "thestudio");
});

test("terminal input becomes keys, and the switch key is its own", () => {
  const parse = (text: string) => parseKeys(Buffer.from(text, "utf8"), 0x1d).map((one) => one.name === "char" ? one.char : one.name);
  assert.deepEqual(parse("\x1b[A\x1b[B\x1bOA\x1bOB"), ["up", "down", "up", "down"]);
  assert.deepEqual(parse("\x1b"), ["escape"]);
  assert.deepEqual(parse("\r\n\t\x03\x1d"), ["enter", "enter", "tab", "interrupt", "switch"]);
  assert.deepEqual(parse("aé✳"), ["a", "é", "✳"]);
  assert.deepEqual(parse("\x1b[5~\x1b[H\x01\x7f"), [], "keys the switcher has no use for are dropped");
  assert.deepEqual(parseKeys(Buffer.from("\x02\x1d"), 0x02).map((one) => one.name), ["switch"], "with another switch key, Ctrl-] means nothing");
});

test("the switch key is a control key that leaves the session its essential keys", () => {
  assert.deepEqual(parseSwitchKey("C-]"), { byte: 0x1d, label: "Ctrl-]" });
  assert.deepEqual(parseSwitchKey("C-b"), { byte: 0x02, label: "Ctrl-B" });
  assert.deepEqual(parseSwitchKey("C-\\"), { byte: 0x1c, label: "Ctrl-\\" });
  for (const refused of ["C-c", "C-d", "C-m", "C-[", "C-i", "C-h", "C-j"]) assert.throws(() => parseSwitchKey(refused), /the session needs it/, refused);
  for (const bad of ["x", "C-1", "C-", "]", "M-x", "^a"]) assert.throws(() => parseSwitchKey(bad), /--key takes a control key/, bad);
});

const plain = (frame: string) => {
  const screen: string[] = [];
  for (const match of frame.matchAll(/\x1b\[(\d+);1H(.*?)\x1b\[K/g)) screen[Number(match[1]) - 1] = match[2]!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
  return screen;
};

test("the switcher draws devices, numbered sessions, the selected screen and the keys", () => {
  const frame = draw(
    { ...state({ selected: "thestudio/agent", current: ref("lf", "tty-2"), previous: ref("lf", "tty-1"), panes: ["lf/tty-2", "thestudio/build"] }), preview: { key: "thestudio/agent", text: "> fix the tests\n\n  Running bun test…\n" } },
    { cols: 120, rows: 14, switchLabel: "Ctrl-]" },
  );
  const screen = plain(frame);
  assert.equal(screen.length, 14);
  assert.match(screen[0]!, /^ cns ui · 3 devices · 4 sessions +Esc lf\/tty-2 · Tab lf\/tty-1$/);
  assert.match(screen[1]!, /^ lf +direct · 2 sessions +│thestudio\/agent · 120x40 · 0 attached · running$/);
  assert.match(screen[2]!, /^ 1 {2}tty-1 +bun test +running +│$/);
  assert.match(screen[3]!, /^ 2▪ tty-2 +vim src\/pty.ts +running +│> fix the tests$/, "a session on screen is marked");
  assert.match(screen[4]!, /^ beelink +may not list +│$/);
  assert.match(screen[5]!, /^ {3}beelink does not let this device list.*│  Running bun test…$/);
  assert.match(screen[7]!, /^ 3▪ build +nix build +exited 0 +│$/);
  assert.match(screen[8]!, /^ 4 {2}agent +Claude Code +running +│$/);
  assert.match(frame, /\x1b\[7m 4 {2}agent/, "the selected row is drawn in reverse");
  assert.equal(screen[13], " Enter open · 1-9 jump · Tab previous · Esc back · + pane · - unpane · n new · x kill · d detach · Ctrl-] returns here");
  assert.match(frame, /^\x1b\[\?25l/, "the cursor is hidden while the switcher shows");
});

test("a narrow switcher drops the preview, and the kill question takes the message line", () => {
  const screen = plain(draw(state({ confirmKill: ref("lf", "tty-1") }), { cols: 60, rows: 12, switchLabel: "Ctrl-B" }));
  assert.ok(screen.every((line) => !line.includes("│")));
  assert.match(screen[10]!, /^ Kill lf\/tty-1\? It ends the program\. y to kill/);
  assert.match(screen[11]!, /^ Enter open · 1-9 jump .*…$/, "keys that do not fit are cut");
});

test("text from a device is cut to its column, counting wide characters, with control codes made harmless", () => {
  assert.equal(fit("bun test", 10), "bun test  ");
  assert.equal(fit("a long title that does not fit", 10), "a long ti…");
  assert.equal(fit("日本語テキスト", 7), "日本語…");
  assert.equal(fit("✳ Claude", 8), "✳ Claude");
  assert.equal(fit("evil\x1b]0;title\x07", 16), "evil?]0;title?  ");
  assert.equal(fit("anything", 0), "");
});
