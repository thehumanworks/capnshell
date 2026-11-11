import { openDeviceLink, type DeviceLink } from "../device-link.js";
import { errorMessage, printable } from "../errors.js";
import { listEverywhere, LIST_TIMEOUT_MS, type FleetDevice } from "../fleet-sessions.js";
import { ensureIdentity, type Identity } from "../identity.js";
import { explainDenial, listPeers, resolvePeer, type Permission } from "../peers.js";
import { secureReady } from "../secure.js";
import { describeExit } from "../session-text.js";
import { sessionNameSchema, type PtySessionInfo } from "../shell.js";
import {
  draw, entered, initialState, listed, parseKeys, parseSwitchKey, press, refKey, rows,
  type Effect, type SessionRef, type SwitcherState,
} from "../switcher.js";
import { attachTerminal, ConnectionLost, plain, type RemoteNamedPty } from "../terminal.js";
import { classify, sessionReplaced } from "../tty-recovery.js";
import { startTerminal } from "./paired-tty.js";
import { showPanes } from "./ui-panes.js";

/** How often the switcher asks every device for its sessions while it is open. */
const REFRESH_MS = 3000;
/** How long the selection rests before its screen is fetched for the preview. */
const PREVIEW_MS = 120;
// What a session may have left set, reset before the switcher draws.
const RESET_MODES = "\x1b[0m\x1b[?25h\x1b[?1l\x1b>\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

interface UiDevice extends FleetDevice { publicKey: string; addresses: string[]; outgoing: Permission[] }

export interface UiOptions {
  /** DEVICE to open the switcher on, or DEVICE/NAME to open that session at once. */
  target?: string;
  /** The key that opens the switcher, such as C-]; CNS_KEY, else Ctrl-]. */
  key?: string;
}

/** The parts of a target: a device, and maybe a session on it. */
export function parseTarget(target: string): { device: string; name?: string } {
  const [device, name, ...rest] = target.split("/");
  if (!device || rest.length || name === "") throw new Error(`cns ui takes DEVICE or DEVICE/SESSION, not ${JSON.stringify(target)}.`);
  if (name !== undefined) sessionNameSchema.parse(name);
  return { device, name };
}

/** One standing connection per device for as long as cns ui runs, reopened when it drops. */
class Links {
  #links = new Map<string, Promise<DeviceLink>>();
  #identity: Identity;
  #signal: AbortSignal;
  constructor(identity: Identity, signal: AbortSignal) { this.#identity = identity; this.#signal = signal; }
  get(device: UiDevice): Promise<DeviceLink> {
    const existing = this.#links.get(device.name);
    if (!existing) return this.#dial(device);
    return existing.then((link) => link.open ? link : this.#dial(device), () => this.#dial(device));
  }
  #dial(device: UiDevice): Promise<DeviceLink> {
    const dialing = openDeviceLink(device, this.#identity, AbortSignal.any([this.#signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]));
    this.#links.set(device.name, dialing);
    dialing.catch(() => { if (this.#links.get(device.name) === dialing) this.#links.delete(device.name); });
    return dialing;
  }
  drop(name: string) {
    const link = this.#links.get(name);
    this.#links.delete(name);
    void link?.then((open) => { open.remote[Symbol.dispose](); open.close("cns ui ended"); }, () => {});
  }
  closeAll() { for (const name of [...this.#links.keys()]) this.drop(name); }
}

/**
 * `cns ui`: one session on screen at a time, any session on any paired device, and a switcher
 * between them. The switch key (Ctrl-] unless --key or CNS_KEY says otherwise) opens the
 * switcher; picking a session detaches from the one on screen, which keeps running, and
 * attaches to the next. Detaching from cns ui, or closing its terminal, leaves every session
 * running, as tmux does; `cns tty DEVICE` keeps its own rule and ends its session with its window.
 */
export async function ui(options: UiOptions = {}): Promise<number> {
  const input = process.stdin;
  const { byte: switchKey, label: switchLabel } = parseSwitchKey(options.key ?? process.env.CNS_KEY ?? "C-]");
  const target = options.target === undefined ? undefined : parseTarget(options.target);
  if (target) resolvePeer(target.device);
  if (!input.isTTY || !process.stdout.isTTY) {
    throw new Error("cns ui needs a terminal. Without one, cns sessions lists sessions, and cns screen, cns keys and cns tty --attach use them.");
  }
  const { identity } = ensureIdentity();
  await secureReady();
  const devices: UiDevice[] = listPeers().map((peer) => ({ name: peer.name, publicKey: peer.publicKey, addresses: peer.addresses, outgoing: peer.grants.outgoing }));
  if (!devices.length) throw new Error("No paired devices. Run cns pair to pair with another device.");
  const byName = (name: string) => devices.find((device) => device.name === name);

  const stop = new AbortController();
  let exitCode = 0;
  const signals = { SIGTERM: 143, SIGHUP: 129 } as const;
  const handlers = Object.entries(signals).map(([signal, code]) => {
    const handler = () => { exitCode = code; stop.abort(new Error("cns ui was stopped.")); };
    try { process.once(signal, handler); } catch { /* A platform without this signal never sends it. */ }
    return [signal, handler] as const;
  });
  const ignore = () => {};
  process.stdout.on("error", ignore);
  const links = new Links(identity, stop.signal);
  const originalRaw = input.isRaw;
  const write = (text: string) => new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));

  let state: SwitcherState = initialState(devices.map((device) => device.name));
  if (target) state = { ...state, selected: target.name ? refKey({ device: target.device, name: target.name }) : target.device };
  let showing = false;
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const render = () => { if (showing && !stop.signal.aborted) process.stdout.write(draw(state, { ...size(), switchLabel })); };

  // Listing: each device answers on its own, and the switcher redraws as each does.
  const asking = new Set<string>();
  const refreshDevice = async (device: UiDevice) => {
    if (asking.has(device.name)) return;
    asking.add(device.name);
    try {
      const [result] = await listEverywhere([device], async (one) => {
        const link = await links.get(one);
        try { return { sessions: await plain(link.remote.ptySessions() as unknown as Promise<PtySessionInfo[]>), via: link.via }; }
        catch (error) { if (!link.open) links.drop(one.name); throw error; }
      }, { signal: stop.signal });
      state = listed(state, result!);
      render();
      schedulePreview();
    } catch { /* cns ui is stopping. */ }
    finally { asking.delete(device.name); }
  };
  const refresh = () => { for (const device of devices) void refreshDevice(device); };

  // The preview: the selected session's screen, fetched once the selection rests.
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    const row = rows(state).find((candidate) => candidate.key === state.selected);
    if (!showing || row?.kind !== "session") return;
    previewTimer = setTimeout(async () => {
      const key = row.key;
      let text: string;
      try {
        const link = await links.get(byName(row.device)!);
        const handle = await link.remote.ptySession(row.session.name) as unknown as RemoteNamedPty;
        try { text = (await plain(handle.capture())).text; }
        finally { handle[Symbol.dispose](); }
      } catch (error) {
        text = explainDenial(printable(errorMessage(error)), row.device);
      }
      if (state.selected !== key) return;
      state = { ...state, preview: { key, text } };
      render();
    }, PREVIEW_MS);
  };

  /** Open a handle on a session and check it is the one the switcher means. */
  const open = async (ref: SessionRef) => {
    const device = byName(ref.device);
    if (!device) throw new Error(`No paired device is saved as ${ref.device}.`);
    const link = await links.get(device);
    const handle = await link.remote.ptySession(ref.name) as unknown as RemoteNamedPty;
    try {
      const info = await plain(handle.info());
      if (ref.pid !== undefined && ref.startedAt !== undefined) {
        const replaced = sessionReplaced({ pid: ref.pid, startedAt: ref.startedAt }, info, ref.device, ref.name, false);
        if (replaced) throw replaced;
      }
      return { link, handle, info };
    } catch (error) {
      handle[Symbol.dispose]();
      throw error;
    }
  };
  const explain = (error: unknown, ref: { device: string; name?: string }) => {
    if (stop.signal.aborted) return "";
    const final = classify(error, ref.device, ref.name ?? "a new session", false);
    return final?.message ?? `${ref.device}: ${explainDenial(printable(errorMessage(error)), ref.device)}`;
  };

  /** Show a session until the switch key, its end, or a lost connection; the message to show afterwards. */
  const visit = async (ref: SessionRef): Promise<string | null> => {
    let opened: Awaited<ReturnType<typeof open>>;
    try { opened = await open(ref); }
    catch (error) {
      if (state.current && refKey(state.current) === refKey(ref)) state = { ...state, current: null };
      return explain(error, ref);
    }
    const { link, handle, info } = opened;
    const key = refKey(ref);
    state = entered(state, { device: ref.device, name: ref.name, pid: info.pid, startedAt: info.startedAt });
    let refused: string | undefined;
    await write("\x1b[?25h");
    try {
      const result = await attachTerminal((sink, sized) => handle.attach(sink, { cols: sized.cols, rows: sized.rows, answers: !sized.respond }), {}, {
        signal: stop.signal, detachKey: switchKey, alternateScreen: true, keepAlternateScreen: true,
        onInputRefused: (reason) => { refused = explainDenial(printable(reason), ref.device); },
      });
      if (result.exit) return `${key} ${describeExit(result.exit)}. x removes it now; ${ref.device} removes it an hour after it ended.`;
      if (result.detached) return `${key}: ${printable(result.detached)}`;
      return refused ? `${key} may only be watched from here: ${refused}` : null;
    } catch (error) {
      if (stop.signal.aborted) return null;
      if (error instanceof ConnectionLost || !link.open) {
        links.drop(ref.device);
        const inFlight = error instanceof ConnectionLost && error.inFlight ? `; ${error.inFlight} bytes of input may not have arrived` : "";
        return `Lost the connection to ${ref.device}${inFlight}. ${key} keeps running there; Esc tries again.`;
      }
      return explain(error, ref);
    } finally {
      handle[Symbol.dispose]();
    }
  };

  // What is on screen: one session, or several in panes, with the keys going to panes[focus].
  let panes: SessionRef[] = [];
  let focus = 0;
  /** Put a session on screen: focus its pane if it has one, else add a pane or take the current one's place. */
  const place = (ref: SessionRef, add: boolean) => {
    const index = panes.findIndex((pane) => refKey(pane) === refKey(ref));
    if (index >= 0) focus = index;
    else if (add || !panes.length) focus = panes.push(ref) - 1;
    else panes[focus] = ref;
  };
  /** Show what is on screen until the switch key; the message for the switcher afterwards. */
  const show = async (): Promise<string | null> => {
    if (panes.length === 1) return await visit(panes[0]!);
    state = entered(state, panes[focus]!);
    const result = await showPanes(panes, focus, { open, switchKey, signal: stop.signal });
    if (result.kind !== "failed" || stop.signal.aborted) return null;
    const ref = panes[result.index]!;
    focus = result.index;
    state = entered(state, ref);
    if (!(result.error instanceof ConnectionLost)) return `${explain(result.error, ref)} - removes its pane.`;
    links.drop(ref.device);
    return `Lost the connection to ${ref.device}. ${refKey(ref)} keeps running there; Esc tries again, - removes its pane.`;
  };

  /** Start the next free tty-N, at this terminal's size. */
  const create = async (deviceName: string): Promise<SessionRef | string> => {
    try {
      const link = await links.get(byName(deviceName)!);
      return { device: deviceName, name: await startTerminal(link.remote, size()) };
    } catch (error) {
      return classify(error, deviceName, "a new session", true)?.message ?? explain(error, { device: deviceName });
    }
  };

  const kill = async (ref: SessionRef) => {
    try {
      const { handle } = await open(ref);
      try { await plain(handle.kill()); }
      finally { handle[Symbol.dispose](); }
      const gone = (other: SessionRef | null) => other && refKey(other) === refKey(ref) ? null : other;
      const index = panes.findIndex((pane) => refKey(pane) === refKey(ref));
      if (index >= 0) {
        panes.splice(index, 1);
        focus = Math.max(0, focus > index ? focus - 1 : Math.min(focus, panes.length - 1));
      }
      state = { ...state, message: `Killed ${refKey(ref)}.`, current: gone(state.current), previous: gone(state.previous), panes: panes.map(refKey) };
    } catch (error) {
      state = { ...state, message: explain(error, ref) };
    }
    render();
    void refreshDevice(byName(ref.device)!);
  };

  /** Show the switcher until a key asks for something it cannot do itself. */
  const pick = () => new Promise<Effect>((resolve) => {
    showing = true;
    const finish = (effect: Effect) => {
      showing = false;
      clearTimeout(previewTimer);
      clearInterval(timer);
      input.off("data", onData);
      process.stdout.off("resize", render);
      stop.signal.removeEventListener("abort", onStop);
      input.pause();
      resolve(effect);
    };
    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(typeof chunk === "string" ? Buffer.from(chunk) : chunk, switchKey)) {
        const pressed = press(state, key);
        state = pressed.state;
        const effect = pressed.effect;
        if (effect.kind === "kill") void kill(effect.ref);
        else if (effect.kind !== "none") return finish(effect);
      }
      render();
      schedulePreview();
    };
    const onStop = () => finish({ kind: "detach" });
    const timer = setInterval(refresh, REFRESH_MS);
    input.on("data", onData);
    process.stdout.on("resize", render);
    stop.signal.addEventListener("abort", onStop, { once: true });
    input.resume();
    void write(RESET_MODES + "\x1b[2J").then(() => { render(); refresh(); schedulePreview(); });
  });

  input.setRawMode(true);
  await write("\x1b[?1049h\x1b[2J");
  try {
    let effect: Effect = target?.name ? { kind: "attach", ref: { device: target.device, name: target.name } } : { kind: "none" };
    while (!stop.signal.aborted) {
      let message: string | null = null;
      if (effect.kind === "attach" || effect.kind === "add-pane") {
        place(effect.ref, effect.kind === "add-pane");
        message = await show();
      } else if (effect.kind === "new") {
        const made = await create(effect.device);
        if (typeof made === "string") message = made;
        else {
          place(made, !!effect.pane);
          message = await show();
        }
      } else if (effect.kind === "remove-pane") {
        panes.splice(focus, 1);
        focus = Math.min(focus, panes.length - 1);
        message = await show();
      } else if (effect.kind === "detach") break;
      state = { ...state, message, panes: panes.map(refKey) };
      effect = await pick();
    }
  } finally {
    stop.abort();
    clearTimeout(previewTimer);
    links.closeAll();
    await write(RESET_MODES + "\x1b[?1049l");
    try { input.setRawMode(originalRaw); } catch { /* The terminal has closed. */ }
    input.pause();
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.stdout.off("error", ignore);
  }
  if (exitCode === 0) process.stderr.write("[cns: left cns ui; every session keeps running. cns ui returns to them.]\n");
  return exitCode;
}
