import { RpcTarget } from "capnweb";
import { localShellInfo, ShellApi, type ShellInfo } from "./shell.js";

/**
 * What a client that only wants to use a peer offers that peer in return: the
 * handshake's info(), and a refusal of everything else. Every ShellApi method,
 * including ones added later, is refused, so the peer never gets a shell or the
 * files of the client's machine.
 */
export class RefusingShell extends RpcTarget {
  static readonly refusal = "This peer only uses your shell; it does not run commands or share files.";
  info(): ShellInfo { return localShellInfo(); }
  [Symbol.dispose]() {}
}

for (const name of Object.getOwnPropertyNames(ShellApi.prototype)) {
  if (name === "constructor" || name === "info") continue;
  Object.defineProperty(RefusingShell.prototype, name, {
    value: function refuse(): never { throw new Error(RefusingShell.refusal); },
    writable: true, configurable: true, enumerable: false,
  });
}
