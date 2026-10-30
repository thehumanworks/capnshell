import { RpcTarget } from "capnweb";
import { MAX_PTY_INPUT_BYTES, type PtyExit, type PtyOptions, type PtySink } from "./shell.js";

/** The caller's view of a remote PtySession stub. */
export interface RemotePty {
  write(data: Uint8Array): unknown;
  resize(cols: number, rows: number): unknown;
  onRpcBroken?(callback: (error: unknown) => void): void;
  [Symbol.dispose](): void;
}
export type OpenPty = (sink: PtySink, options: PtyOptions) => Promise<RemotePty>;

/** Receives remote output by reference. Acknowledging after the local write is the flow control. */
class OutputSink extends RpcTarget implements PtySink {
  #exit: (result: PtyExit) => void;
  constructor(exit: (result: PtyExit) => void) {
    super();
    this.#exit = exit;
  }
  output(data: Uint8Array): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new TypeError("PTY output must be bytes.");
    return new Promise((resolve) => process.stdout.write(data, () => resolve()));
  }
  exit(result: PtyExit): void { this.#exit(result); }
}

/**
 * Bridge this process's stdin/stdout to a remote PTY until the program exits.
 * A local terminal is switched to raw mode and kept in sync with resizes. Piped
 * input is forwarded verbatim; its end is not translated into a keystroke, because
 * Ctrl-D would also quit TUIs started with stdin closed.
 */
export async function attachTerminal(open: OpenPty, options: PtyOptions, signal?: AbortSignal): Promise<PtyExit> {
  const input = process.stdin;
  const interactive = !!(input.isTTY && process.stdout.isTTY);
  const fixedSize = options.cols !== undefined || options.rows !== undefined;
  const size = () => ({
    cols: options.cols ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? 80,
    rows: options.rows ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? 24,
  });
  let exited!: (result: PtyExit) => void;
  let failed!: (error: Error) => void;
  const result = new Promise<PtyExit>((resolve, reject) => { exited = resolve; failed = reject; });
  const abort = () => failed(new Error("PTY session cancelled."));
  if (signal?.aborted) throw new Error("PTY session cancelled.");
  signal?.addEventListener("abort", abort, { once: true });
  const sink = new OutputSink(exited);
  let pty: RemotePty;
  try {
    pty = await open(sink, { ...options, ...size() });
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
    // Hold further input until the peer has accepted this chunk.
    input.pause();
    void send(typeof chunk === "string" ? Buffer.from(chunk) : chunk).then(() => { if (!ended) input.resume(); });
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
    return await result;
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
