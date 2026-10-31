import { RpcTarget } from "capnweb";
import type {
  AttachOptions as SessionAttachOptions, CaptureOptions, KeysOptions, PtyExit, PtyOptions, PtyScreen, PtySessionInfo, PtySink, PtyWait, WaitOptions,
} from "./shell.js";
import { MAX_PTY_INPUT_BYTES } from "./shell.js";
import type { PeerController } from "./console.js";

type Result<T> = Promise<T & { [Symbol.dispose]?(): void }>;
/** The caller's view of a remote PtySession or PtyAttachment stub. */
export interface RemotePty {
  write(data: Uint8Array): unknown;
  resize(cols: number, rows: number): unknown;
  capture(options?: CaptureOptions): Result<PtyScreen>;
  onRpcBroken?(callback: (error: unknown) => void): void;
  [Symbol.dispose](): void;
}
/** The caller's view of a remote NamedPty stub. */
export interface RemoteNamedPty {
  info(): Result<PtySessionInfo>;
  write(data: Uint8Array | string): Promise<unknown>;
  keys(keys: string[], options?: KeysOptions): Promise<unknown>;
  resize(cols: number, rows: number): Promise<unknown>;
  capture(options?: CaptureOptions): Result<PtyScreen>;
  wait(options: WaitOptions): Result<PtyWait>;
  attach(sink: PtySink, options?: SessionAttachOptions): Promise<RemotePty>;
  kill(): Result<PtyExit>;
  [Symbol.dispose](): void;
}
export type OpenPty = (sink: PtySink, options: PtyOptions) => Promise<RemotePty>;

/** Copy an RPC result into a plain value and release the result's stubs. */
export async function plain<T>(value: PromiseLike<T & { [Symbol.dispose]?(): void }>): Promise<T> {
  const result = await value;
  try { return structuredClone(result); }
  finally { result[Symbol.dispose]?.(); }
}

export interface AttachOptions {
  signal?: AbortSignal;
  /** Print nothing while it runs; return the rendered screen from when it ended. */
  screen?: CaptureOptions;
  /** For named sessions: this byte typed at a local terminal detaches instead of being sent. */
  detachKey?: number;
}
export type AttachResult =
  | { exit: PtyExit; screen?: PtyScreen }
  /** Detached from a named session: by the user (null) or by the executor, with its reason. */
  | { exit: null; detached: string | null };

// Leave the modes a full-screen program may have set, as tmux does on detach.
const RESET_MODES = "\x1b[0m\x1b[?25h\x1b[?1l\x1b>\x1b[?66l\x1b[?2004l\x1b[?1004l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?7h\x1b[4l";

/** Receives remote output by reference. Acknowledging after the local write is the flow control. */
class OutputSink extends RpcTarget implements PtySink {
  #exit: (result: PtyExit) => void;
  #detached: (reason: string) => void;
  constructor(exit: (result: PtyExit) => void, detached: (reason: string) => void) {
    super();
    this.#exit = exit;
    this.#detached = detached;
  }
  output(data: Uint8Array): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new TypeError("PTY output must be bytes.");
    return new Promise((resolve) => process.stdout.write(data, () => resolve()));
  }
  exit(result: PtyExit): void { this.#exit(result); }
  detached(reason: string): void { this.#detached(String(reason)); }
}

/**
 * Bridge this process's stdin/stdout to a remote PTY until the program exits.
 * A local terminal is switched to raw mode and kept in sync with resizes. Piped
 * input is forwarded verbatim; its end is not translated into a keystroke, because
 * Ctrl-D would also quit TUIs started with stdin closed.
 */
export async function attachTerminal(open: OpenPty, options: PtyOptions, { signal, screen, detachKey }: AttachOptions = {}): Promise<AttachResult> {
  const input = process.stdin;
  const interactive = !!(input.isTTY && process.stdout.isTTY);
  // A local terminal answers queries such as cursor-position reports only when it
  // both displays the output and types the replies; otherwise the remote screen must.
  const remote = { stream: !screen, respond: !!screen || !interactive };
  const fixedSize = options.cols !== undefined || options.rows !== undefined;
  const size = () => ({
    cols: options.cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? 80,
    rows: options.rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? 24,
  });
  let finish!: (result: PtyExit | { detached: string | null }) => void;
  let failed!: (error: Error) => void;
  const result = new Promise<PtyExit | { detached: string | null }>((resolve, reject) => { finish = resolve; failed = reject; });
  const abort = () => failed(new Error("PTY session cancelled."));
  if (signal?.aborted) throw new Error("PTY session cancelled.");
  signal?.addEventListener("abort", abort, { once: true });
  const sink = new OutputSink(finish, (reason) => finish({ detached: reason }));
  let pty: RemotePty;
  try {
    pty = await open(sink, { ...remote, ...options, ...size() });
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  pty.onRpcBroken?.((error) => failed(new Error(`PTY connection lost: ${error instanceof Error ? error.message : String(error)}`)));

  const wasRaw = input.isTTY ? input.isRaw : false;
  const restore = () => { if (interactive) input.setRawMode(wasRaw); };
  // Never leave the user's terminal raw, even if the process exits abruptly.
  process.once("exit", restore);
  let writing = Promise.resolve();
  const send = (data: Uint8Array) => {
    writing = writing.then(async () => {
      for (let offset = 0; offset < data.length; offset += MAX_PTY_INPUT_BYTES) {
        await pty.write(data.subarray(offset, offset + MAX_PTY_INPUT_BYTES));
      }
    }).catch(() => { /* The exit or broken-connection path reports the outcome. */ });
    return writing;
  };
  const onData = (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const detach = interactive && detachKey !== undefined ? data.indexOf(detachKey) : -1;
    if (detach >= 0) data = data.subarray(0, detach);
    // Hold further input until the peer has accepted this chunk.
    input.pause();
    void send(data).then(() => {
      if (detach >= 0) finish({ detached: null });
      else if (!ended) input.resume();
    });
  };
  const onResize = () => {
    const { cols, rows } = size();
    Promise.resolve(pty.resize(cols, rows)).catch(() => {});
  };
  let ended = false;
  if (interactive) input.setRawMode(true);
  input.on("data", onData);
  if (process.stdout.isTTY && !fixedSize) process.stdout.on("resize", onResize);
  input.resume();
  try {
    const outcome = await result;
    if ("detached" in outcome) {
      if (interactive) {
        const { alternateScreen } = await plain(pty.capture()).catch(() => ({ alternateScreen: false }));
        await new Promise((resolve) => process.stdout.write(RESET_MODES + (alternateScreen ? "\x1b[?1049l" : ""), resolve));
      }
      return { exit: null, detached: outcome.detached };
    }
    if (!screen) return { exit: outcome };
    return { exit: outcome, screen: await plain(pty.capture(screen)) };
  } finally {
    ended = true;
    signal?.removeEventListener("abort", abort);
    input.off("data", onData);
    process.stdout.off("resize", onResize);
    input.pause();
    restore();
    process.off("exit", restore);
    pty[Symbol.dispose]();
  }
}

/** Ctrl-], as in telnet. */
export const DETACH_KEY = 0x1d;

/** Attach this process's stdin/stdout to a named session until Ctrl-] detaches or the program ends. */
export async function attachSession(controller: PeerController, id: string, name: string,
  { cols, rows, signal }: { cols?: number; rows?: number; signal?: AbortSignal } = {}): Promise<AttachResult> {
  const session = await controller.ptySession(id, name);
  try {
    // Only a real terminal or an explicit size resizes a session others may share.
    const sized = !!process.stdout.isTTY || cols !== undefined || rows !== undefined;
    return await attachTerminal((sink, options) => session.attach(sink, {
      ...(sized ? { cols: options.cols, rows: options.rows } : {}), answers: !options.respond,
    }), { cols, rows }, { signal, detachKey: DETACH_KEY });
  } finally {
    session[Symbol.dispose]();
  }
}
