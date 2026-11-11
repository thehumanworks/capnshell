import { errorMessage } from "../errors.js";
import { compose, paint, PaneScreen, screenSize, tile } from "../panes.js";
import { describeExit } from "../session-text.js";
import { MAX_PTY_INPUT_BYTES, type PtyExit, type PtySessionInfo } from "../shell.js";
import { refKey, type SessionRef } from "../switcher.js";
import { ConnectionLost, OutputSink, type RemoteNamedPty, type RemotePty } from "../terminal.js";

export type PanesOutcome =
  /** The switch key was pressed. */
  | { kind: "switch" }
  | { kind: "stopped" }
  /** A pane's session could not be shown, or its connection was lost (a ConnectionLost error). */
  | { kind: "failed"; index: number; error: unknown };

interface Pane {
  ref: SessionRef;
  screen: PaneScreen;
  handle?: RemoteNamedPty;
  attachment?: RemotePty;
  /** Whether this device may type into and resize the session. */
  control: boolean;
  exit: PtyExit | null;
}

/**
 * Show several sessions at once, tiled, until the switch key. Keys go to the pane at `focus`.
 * Each session is attached at its pane's size, and its screen answers the program's terminal
 * queries, since this terminal never sees them. A pane whose program ends keeps its last screen.
 */
export async function showPanes(refs: readonly SessionRef[], focus: number, { open, switchKey, signal }: {
  open: (ref: SessionRef) => Promise<{ handle: RemoteNamedPty; info: PtySessionInfo }>;
  switchKey: number;
  signal: AbortSignal;
}): Promise<PanesOutcome> {
  const input = process.stdin;
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  let rects = tile(refs.length, size().cols, size().rows);
  const panes: Pane[] = refs.map((ref, index) => ({ ref, screen: new PaneScreen(screenSize(rects[index]!)), control: true, exit: null }));
  let settle!: (outcome: PanesOutcome) => void;
  const outcome = new Promise<PanesOutcome>((resolve) => { settle = resolve; });
  let closed = false;

  // Drawing: at most one frame every 16 ms, each writing only the rows that changed.
  let shown: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let painting = false;
  const schedule = () => { if (!closed) timer ??= setTimeout(() => void draw(), 16); };
  const title = (pane: Pane) => refKey(pane.ref) + (pane.exit ? ` · ${describeExit(pane.exit)}` : pane.screen.title ? ` · ${pane.screen.title}` : "")
    + (pane.control ? "" : " · view only");
  const draw = async () => {
    timer = undefined;
    if (closed) return;
    if (painting) return schedule();
    painting = true;
    const { cols, rows } = size();
    const next = compose(panes.map((pane, index) => ({ rect: rects[index]!, screen: pane.screen, title: title(pane), focused: index === focus })), cols, rows);
    const { cursor, modes } = panes[focus]!.screen.state;
    const rect = rects[focus]!;
    const inside = cursor.visible && cursor.x < rect.cols && cursor.y < rect.rows - 1;
    const output = "\x1b[?25l" + paint(next, shown) + modes + (inside ? `\x1b[${rect.y + 2 + cursor.y};${rect.x + 1 + cursor.x}H\x1b[?25h` : "");
    shown = next;
    await new Promise((resolve) => process.stdout.write(output, resolve));
    painting = false;
  };

  const attach = async (pane: Pane, index: number) => {
    const { handle, info } = await open(pane.ref);
    pane.handle = handle;
    const wanted = screenSize(rects[index]!);
    // A session this device may only watch keeps its own size; its pane shows as much as fits.
    pane.control = await Promise.resolve(handle.resize(wanted.cols, wanted.rows)).then(() => true, () => false);
    if (!pane.control) pane.screen.resize({ cols: Math.max(2, info.cols), rows: info.rows });
    const sink = new OutputSink(async (data) => { await pane.screen.write(data); schedule(); },
      (exit) => { pane.exit = exit; schedule(); },
      (reason) => settle({ kind: "failed", index, error: new Error(reason) }));
    pane.attachment = await handle.attach(sink, { answers: false });
    pane.attachment.onRpcBroken?.((error) => settle({ kind: "failed", index, error: new ConnectionLost(`Lost the connection: ${errorMessage(error)}`, 0) }));
  };

  // Keys go to the pane at `focus`, one write at a time; the switch key ends the view.
  const send = async (pane: Pane, data: Uint8Array) => {
    for (let offset = 0; offset < data.length && pane.attachment && !pane.exit; offset += MAX_PTY_INPUT_BYTES) {
      await Promise.resolve(pane.attachment.write(data.subarray(offset, offset + MAX_PTY_INPUT_BYTES)));
    }
  };
  const onData = (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const at = data.indexOf(switchKey);
    if (at >= 0) data = data.subarray(0, at);
    const pane = panes[focus]!;
    input.pause();
    void send(pane, data)
      .catch((error: unknown) => { if (/Permission denied/.test(errorMessage(error))) { pane.control = false; schedule(); } })
      .then(() => { if (at >= 0) settle({ kind: "switch" }); else if (!closed) input.resume(); });
  };
  const onResize = () => {
    rects = tile(panes.length, size().cols, size().rows);
    panes.forEach((pane, index) => {
      if (!pane.control) return;
      const wanted = screenSize(rects[index]!);
      pane.screen.resize(wanted);
      void Promise.resolve(pane.attachment?.resize(wanted.cols, wanted.rows)).catch(() => {});
    });
    shown = [];
    schedule();
  };
  const onAbort = () => settle({ kind: "stopped" });

  signal.addEventListener("abort", onAbort, { once: true });
  process.stdout.on("resize", onResize);
  try {
    await Promise.all(panes.map((pane, index) => attach(pane, index).catch((error: unknown) => settle({ kind: "failed", index, error }))));
    input.on("data", onData);
    input.resume();
    schedule();
    return await outcome;
  } finally {
    closed = true;
    clearTimeout(timer);
    input.off("data", onData);
    input.pause();
    process.stdout.off("resize", onResize);
    signal.removeEventListener("abort", onAbort);
    for (const pane of panes) {
      pane.attachment?.[Symbol.dispose]();
      pane.handle?.[Symbol.dispose]();
      pane.screen.dispose();
    }
  }
}
