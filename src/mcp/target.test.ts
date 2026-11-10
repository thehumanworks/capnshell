import { expect, test } from "bun:test";
import type { PeerSummary } from "../console.js";
import { resolvePeer } from "./target.js";

const info = { platform: "linux" as const, name: "linux", shell: "Bash" as const, hostname: "host", cwd: "/home/u", pid: 1 };
const studio: PeerSummary = { id: "p14", info, peer: { name: "studio", fingerprint: "f", daemon: true, via: "direct" } };
const unpaired: PeerSummary = { id: "p3", info };

test("resolvePeer selects by ID or by a paired device's name", () => {
  expect(resolvePeer([unpaired, studio], "studio")).toBe("p14");
  expect(resolvePeer([unpaired, studio], "p3")).toBe("p3");
  expect(resolvePeer([studio], undefined)).toBe("p14");
});

test("resolvePeer names paired devices in its errors, since their IDs change on reconnect", () => {
  expect(() => resolvePeer([unpaired, studio], "p4"))
    .toThrow("Unknown peer p4. Connected peers: p3, studio (p14). Pass a paired device's name: its ID changes whenever it reconnects.");
  expect(() => resolvePeer([unpaired], "p4")).toThrow(/^Unknown peer p4\. Connected peers: p3\.$/);
  expect(() => resolvePeer([unpaired, studio], undefined)).toThrow("Several peers are connected (p3, studio (p14)); pass peer to choose one.");
});
