import { RpcTarget } from "capnweb";
import { describeGrants, type Permission } from "./peers.js";
import { ShellApi, type ShellInfo } from "./shell.js";

/**
 * A peer's view of this device's shell, limited to what this device granted it.
 * Permitted methods delegate to the real ShellApi; every other method, including
 * ones added to ShellApi later, is refused without side effects. Session handles are
 * returned whole, so `sessions:view` currently needs `sessions:control` and
 * `sessions:kill` too; derived read-only handles are a later slice.
 */
export class GrantedShell extends RpcTarget {
  #shell: ShellApi;
  #grants: ReadonlySet<Permission>;
  #peer: string;
  constructor(shell: ShellApi, grants: readonly Permission[], peer: string) {
    super();
    this.#shell = shell;
    this.#grants = new Set(grants);
    this.#peer = peer;
  }
  /** What the peer may do here, as people read it. */
  get grants(): string { return describeGrants([...this.#grants]); }
  #require(...permissions: Permission[]) {
    const missing = permissions.filter((permission) => !this.#grants.has(permission));
    if (missing.length) throw new Error(`Permission denied: ${missing.join(", ")} not granted to ${this.#peer}.`);
  }
  info(): ShellInfo { return this.#shell.info(); }
  run(...args: Parameters<ShellApi["run"]>) { this.#require("shell"); return this.#shell.run(...args); }
  exec(...args: Parameters<ShellApi["exec"]>) { this.#require("shell"); return this.#shell.exec(...args); }
  openPty(...args: Parameters<ShellApi["openPty"]>) { this.#require("shell"); return this.#shell.openPty(...args); }
  /** A fork carries the same grants. */
  fork(): GrantedShell { this.#require("shell"); return new GrantedShell(this.#shell.fork(), [...this.#grants], this.#peer); }
  stat(...args: Parameters<ShellApi["stat"]>) { this.#require("files"); return this.#shell.stat(...args); }
  access(...args: Parameters<ShellApi["access"]>) { this.#require("files"); return this.#shell.access(...args); }
  readdir(...args: Parameters<ShellApi["readdir"]>) { this.#require("files"); return this.#shell.readdir(...args); }
  mkdir(...args: Parameters<ShellApi["mkdir"]>) { this.#require("files"); return this.#shell.mkdir(...args); }
  glob(...args: Parameters<ShellApi["glob"]>) { this.#require("files"); return this.#shell.glob(...args); }
  readFile(...args: Parameters<ShellApi["readFile"]>) { this.#require("files"); return this.#shell.readFile(...args); }
  writeFile(...args: Parameters<ShellApi["writeFile"]>) { this.#require("files"); return this.#shell.writeFile(...args); }
  ptySessions() { this.#require("sessions:list"); return this.#shell.ptySessions(); }
  startPtySession(...args: Parameters<ShellApi["startPtySession"]>) { this.#require("sessions:create", "sessions:view", "sessions:control", "sessions:kill"); return this.#shell.startPtySession(...args); }
  ptySession(...args: Parameters<ShellApi["ptySession"]>) { this.#require("sessions:view", "sessions:control", "sessions:kill"); return this.#shell.ptySession(...args); }
  /** Closing the view closes the shell behind it: its commands end and its handles are revoked. */
  [Symbol.dispose]() { this.#shell[Symbol.dispose](); }
}

// Refuse anything ShellApi gains later that this class does not know about.
for (const name of Object.getOwnPropertyNames(ShellApi.prototype)) {
  if (name === "constructor" || Object.prototype.hasOwnProperty.call(GrantedShell.prototype, name)) continue;
  Object.defineProperty(GrantedShell.prototype, name, {
    value: function refuse(): never { throw new Error(`Permission denied: ${name} is not available to peers.`); },
    writable: true, configurable: true, enumerable: false,
  });
}
