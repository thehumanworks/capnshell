import { printable } from "./errors.js";
import type { DeviceSessions } from "./fleet-sessions.js";
import { describeExit } from "./session-text.js";
import type { PtySessionInfo } from "./shell.js";

/**
 * The `cns ui` switcher as pure functions: what each key does to its state, and how the state
 * draws on a terminal of a given size. src/commands/ui.ts does the connecting, the reading of
 * keys and the attaching; switcher.test.ts checks the keys as a table and the drawing as text.
 *
 *   session ──switch key──▶ switcher ──Enter, 1-9, Tab, Esc──▶ session (or panes)
 *                              │ n starts a session, x kills one (after y)
 *                              │ + adds the selected session as a pane, - removes the current one
 *                              └ d, q, Ctrl-C ──▶ detached: every session keeps running
 */

/** The most panes cns ui shows at once. */
export const MAX_PANES = 4;

/** A session on a device, as the switcher remembers it. pid and startedAt tell a session from a later one with its name. */
export interface SessionRef { device: string; name: string; pid?: number; startedAt?: string }
export const refKey = (ref: Pick<SessionRef, "device" | "name">) => `${ref.device}/${ref.name}`;

/** A device as the switcher lists it: asked and answered, or not yet. */
export type DeviceListing = DeviceSessions | { device: string; state: "loading" };

export interface SwitcherState {
  devices: DeviceListing[];
  /** The selected row, by its key: a device's name, or device/session. */
  selected: string | null;
  /** A session x asked to kill, waiting for y. */
  confirmKill: SessionRef | null;
  message: string | null;
  /** The session the switcher was opened from; Esc returns to it. */
  current: SessionRef | null;
  /** The session before that one; Tab goes to it. */
  previous: SessionRef | null;
  /** The selected session's screen as text, once it has been fetched. */
  preview: { key: string; text: string } | null;
  /** The sessions on screen, by key: one, or several in panes. */
  panes: string[];
}

export function initialState(devices: readonly string[]): SwitcherState {
  return {
    devices: devices.map((device) => ({ device, state: "loading" })), selected: devices[0] ?? null,
    confirmKill: null, message: null, current: null, previous: null, preview: null, panes: [],
  };
}

export type Row =
  | { kind: "device"; key: string; device: string; listing: DeviceListing }
  | { kind: "session"; key: string; device: string; session: PtySessionInfo; number: number | null };

/** The rows the switcher shows, in order. The first nine sessions are numbered for 1-9. */
export function rows(state: Pick<SwitcherState, "devices">): Row[] {
  const result: Row[] = [];
  let number = 0;
  for (const listing of state.devices) {
    result.push({ kind: "device", key: listing.device, device: listing.device, listing });
    for (const session of listing.state === "listed" ? listing.sessions : []) {
      number++;
      result.push({ kind: "session", key: refKey({ device: listing.device, name: session.name }), device: listing.device, session, number: number <= 9 ? number : null });
    }
  }
  return result;
}

const refOf = (row: Extract<Row, { kind: "session" }>): SessionRef => ({ device: row.device, name: row.session.name, pid: row.session.pid, startedAt: row.session.startedAt });

/** What the switcher asks src/commands/ui.ts to do after a key. */
export type Effect =
  | { kind: "none" }
  /** Show a session: the pane it is in, or in place of the current one. */
  | { kind: "attach"; ref: SessionRef }
  /** Start the next free tty-N on `device` and show it, in a pane of its own with `pane`. */
  | { kind: "new"; device: string; pane?: true }
  | { kind: "add-pane"; ref: SessionRef }
  /** Close the current session's pane; the session keeps running. */
  | { kind: "remove-pane" }
  | { kind: "kill"; ref: SessionRef }
  /** Leave cns ui; every session keeps running. */
  | { kind: "detach" };

export type Key =
  | { name: "up" | "down" | "enter" | "tab" | "escape" | "switch" | "interrupt" }
  | { name: "char"; char: string };

const NONE: Effect = { kind: "none" };

/** Move the selection to the session `ref` is in, after attaching to it: it becomes current and the one before it previous. */
export function entered(state: SwitcherState, ref: SessionRef): SwitcherState {
  const same = state.current && refKey(state.current) === refKey(ref);
  return { ...state, current: ref, previous: same ? state.previous : state.current ?? state.previous, selected: refKey(ref), confirmKill: null };
}

/** Apply new listings, keeping the selection on the same row when it is still there. */
export function listed(state: SwitcherState, listing: DeviceListing): SwitcherState {
  const devices = state.devices.some((entry) => entry.device === listing.device)
    ? state.devices.map((entry) => entry.device === listing.device ? listing : entry)
    : [...state.devices, listing];
  const next = { ...state, devices };
  const visible = rows(next);
  if (!visible.some((row) => row.key === state.selected)) {
    // A session that went away leaves the selection on its device.
    const device = state.selected?.split("/")[0];
    next.selected = visible.find((row) => row.key === device)?.key ?? visible[0]?.key ?? null;
  }
  return next;
}

/** What a key does in the switcher. */
export function press(state: SwitcherState, key: Key): { state: SwitcherState; effect: Effect } {
  const visible = rows(state);
  const index = Math.max(0, visible.findIndex((row) => row.key === state.selected));
  const row = visible[index];
  const done = (next: Partial<SwitcherState>, effect: Effect = NONE) => ({ state: { ...state, message: null, ...next }, effect });
  const move = (to: number) => done({ selected: visible[Math.min(Math.max(to, 0), visible.length - 1)]?.key ?? null });

  if (key.name === "interrupt") return done({}, { kind: "detach" });
  if (state.confirmKill) {
    const ref = state.confirmKill;
    if (key.name === "char" && key.char.toLowerCase() === "y") return done({ confirmKill: null }, { kind: "kill", ref });
    return done({ confirmKill: null, message: `Kept ${refKey(ref)}.` });
  }

  switch (key.name) {
    case "up": return move(index - 1);
    case "down": return move(index + 1);
    case "enter":
      if (row?.kind === "session") return done({}, { kind: "attach", ref: refOf(row) });
      if (row?.kind === "device") return done({}, { kind: "new", device: row.device });
      return done({});
    case "tab":
      if (state.previous) return done({}, { kind: "attach", ref: state.previous });
      return done({ message: "No previous session yet." });
    case "escape":
    case "switch":
      if (state.current) return done({}, { kind: "attach", ref: state.current });
      return done({ message: "Pick a session, or press d to leave." });
    case "char": break;
  }
  const char = key.char;
  if (/^[1-9]$/.test(char)) {
    const numbered = visible.find((candidate) => candidate.kind === "session" && candidate.number === Number(char));
    if (numbered?.kind === "session") return done({ selected: numbered.key }, { kind: "attach", ref: refOf(numbered) });
    return done({ message: `No session ${char}.` });
  }
  switch (char) {
    case "k": return move(index - 1);
    case "j": return move(index + 1);
    case "n":
      if (row) return done({}, { kind: "new", device: row.device });
      return done({ message: "No device to start a session on." });
    case "x":
      if (row?.kind === "session") return done({ confirmKill: refOf(row) });
      return done({ message: "Select a session to kill." });
    case "+":
      if (state.panes.length >= MAX_PANES) return done({ message: `cns ui shows up to ${MAX_PANES} panes; - removes the one you came from.` });
      if (row?.kind === "device") return done({}, { kind: "new", device: row.device, pane: true });
      if (row?.kind !== "session") return done({});
      if (state.panes.includes(row.key)) return done({ message: `${row.key} is already in a pane.` });
      return done({}, { kind: "add-pane", ref: refOf(row) });
    case "-":
      if (state.panes.length > 1) return done({}, { kind: "remove-pane" });
      return done({ message: "Only one session is on screen; d detaches." });
    case "d": case "q": return done({}, { kind: "detach" });
    default: return done({});
  }
}

/**
 * Split terminal input into keys. `switchKey` is the byte that opens the switcher. An escape
 * byte alone, as a key press sends it, is Escape; one that starts a sequence is that key.
 */
export function parseKeys(data: Uint8Array, switchKey: number): Key[] {
  const keys: Key[] = [];
  const text = Buffer.from(data).toString("utf8");
  for (let at = 0; at < text.length;) {
    const rest = text.slice(at);
    const sequence = /^\x1b(?:\[|O)[0-9;]*([A-Za-z~])/.exec(rest);
    if (sequence) {
      if (sequence[1] === "A") keys.push({ name: "up" });
      if (sequence[1] === "B") keys.push({ name: "down" });
      at += sequence[0].length;
      continue;
    }
    const char = String.fromCodePoint(rest.codePointAt(0)!);
    const code = char.codePointAt(0)!;
    at += char.length;
    if (code === switchKey) keys.push({ name: "switch" });
    else if (code === 0x1b) keys.push({ name: "escape" });
    else if (code === 0x0d || code === 0x0a) keys.push({ name: "enter" });
    else if (code === 0x09) keys.push({ name: "tab" });
    else if (code === 0x03) keys.push({ name: "interrupt" });
    else if (code >= 0x20 && code !== 0x7f) keys.push({ name: "char", char });
  }
  return keys;
}

/** How a switch key is named on the command line (C-], C-b, ...) and the byte it sends. */
export function parseSwitchKey(value: string): { byte: number; label: string } {
  const char = /^C-(.)$/i.exec(value.trim())?.[1];
  const code = char?.toUpperCase().charCodeAt(0);
  if (!char || code === undefined || code < 0x40 || code > 0x5f) throw new Error(`--key takes a control key such as C-] or C-b, not ${JSON.stringify(value)}.`);
  const byte = code & 0x1f;
  // These are what make a terminal usable: never take them away from the session.
  if ([0x03, 0x04, 0x08, 0x09, 0x0a, 0x0d, 0x1b].includes(byte)) throw new Error(`--key cannot be Ctrl-${char.toUpperCase()}: the session needs it.`);
  return { byte, label: `Ctrl-${char.toUpperCase()}` };
}

// Drawing.

const ESC = "\x1b[";
const style = { reset: `${ESC}0m`, dim: `${ESC}2m`, inverse: `${ESC}7m` };

/** Columns a character takes on a terminal: 2 for wide East Asian characters and emoji, 0 for combining marks. */
function cellWidth(char: string): number {
  if (/\p{Mn}|\p{Me}|‍|[︀-️]/u.test(char)) return 0;
  if (/\p{Extended_Pictographic}/u.test(char) && char.codePointAt(0)! >= 0x1f000) return 2;
  const code = char.codePointAt(0)!;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

/** `text` cut or padded to exactly `width` columns; cut text ends with an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...printable(text)];
  const total = chars.reduce((sum, char) => sum + cellWidth(char), 0);
  if (total <= width) return chars.join("") + " ".repeat(width - total);
  let used = 0;
  let out = "";
  for (const char of chars) {
    const cells = cellWidth(char);
    if (used + cells > width - 1) break;
    out += char;
    used += cells;
  }
  return out + "…" + " ".repeat(Math.max(0, width - used - 1));
}

const label = (session: PtySessionInfo) => session.title || session.command || "login shell";
const status = (session: PtySessionInfo) => session.exit ? describeExit(session.exit) : "running";

/** The whole switcher, as escape sequences that draw it over the current screen. */
export function draw(state: SwitcherState, { cols, rows: height, switchLabel }: { cols: number; rows: number; switchLabel: string }): string {
  const lines: string[] = [];
  const visible = rows(state);
  const sessions = state.devices.reduce((sum, listing) => sum + (listing.state === "listed" ? listing.sessions.length : 0), 0);
  const left = ` cns ui · ${state.devices.length} device${state.devices.length === 1 ? "" : "s"} · ${sessions} session${sessions === 1 ? "" : "s"}`;
  const right = [state.current && `Esc ${refKey(state.current)}`, state.previous && `Tab ${refKey(state.previous)}`].filter(Boolean).join(" · ") + " ";
  lines.push(style.inverse + fit(left, Math.max(0, cols - [...right].length)) + fit(right, Math.min(cols, [...right].length)) + style.reset);

  const bodyHeight = Math.max(1, height - 3);
  const showPreview = cols >= 90;
  const listWidth = showPreview ? Math.floor(cols * 0.5) : cols;
  const previewWidth = showPreview ? cols - listWidth - 1 : 0;

  // The list: a device line, a note under it when there is something to say, and its sessions.
  const nameWidth = Math.min(14, Math.max(6, ...visible.flatMap((row) => row.kind === "session" ? [[...row.session.name].length + 1] : [])));
  const listLines: { text: string; selected: boolean }[] = [];
  for (const row of visible) {
    const selected = row.key === state.selected;
    if (row.kind === "device") {
      const listing = row.listing;
      const detail = listing.state === "listed" ? `${listing.via} · ${listing.sessions.length} session${listing.sessions.length === 1 ? "" : "s"}`
        : listing.state === "loading" ? "asking…" : listing.state === "not-granted" ? "may not list" : listing.state;
      listLines.push({ text: fit(` ${row.device}`, Math.min(listWidth, 18)) + fit(detail, listWidth - Math.min(listWidth, 18)), selected });
      if (listing.state === "not-granted" || listing.state === "refused" || listing.state === "unreachable") {
        listLines.push({ text: fit(`   ${listing.reason}`, listWidth), selected: false });
      } else if (listing.state === "listed" && !listing.sessions.length) {
        listLines.push({ text: fit("   no sessions; Enter starts one", listWidth), selected: false });
      }
    } else {
      const session = row.session;
      const text = fit(` ${row.number ?? " "}${state.panes.includes(row.key) ? "▪" : " "} `, 4) + fit(session.name, nameWidth) + fit(label(session), Math.max(0, listWidth - 4 - nameWidth - 11)) + fit(status(session), 11);
      listLines.push({ text, selected });
    }
  }
  const selectedLine = listLines.findIndex((line) => line.selected);
  const offset = Math.max(0, Math.min(selectedLine - Math.floor(bodyHeight / 2), listLines.length - bodyHeight));

  // The preview: the selected session's details and screen.
  const previewLines: string[] = [];
  const row = visible.find((candidate) => candidate.key === state.selected);
  if (row?.kind === "session") {
    const session = row.session;
    previewLines.push(`${refKey({ device: row.device, name: session.name })} · ${session.cols}x${session.rows} · ${session.viewers} attached · ${status(session)}`, "");
    const preview = state.preview?.key === row.key ? state.preview.text : "…";
    previewLines.push(...preview.replace(/\n+$/, "").split("\n"));
  } else if (row?.kind === "device") {
    previewLines.push(row.device, "", "Enter or n starts a new session here.");
  }

  for (let line = 0; line < bodyHeight; line++) {
    const entry = listLines[offset + line];
    const listText = entry ? (entry.selected ? style.inverse + entry.text + style.reset : entry.text) : " ".repeat(listWidth);
    lines.push(showPreview ? listText + `${style.dim}│${style.reset}` + fit(previewLines[line] ?? "", previewWidth) : listText);
  }

  // The message line, then the keys.
  const message = state.confirmKill ? `Kill ${refKey(state.confirmKill)}? It ends the program. y to kill, any other key keeps it.` : state.message ?? "";
  lines.push(fit(` ${message}`, cols));
  lines.push(style.dim + fit(` Enter open · 1-9 jump · Tab previous · Esc back · + pane · - unpane · n new · x kill · d detach · ${switchLabel} returns here`, cols) + style.reset);

  return `${ESC}?25l` + lines.slice(0, height).map((text, index) => `${ESC}${index + 1};1H${text}${ESC}K`).join("") + style.reset;
}
