import { expect, test } from "bun:test";
import { createInvite, decodeInvite, DEFAULT_INVITE_MS, MAX_INVITE_MS, PairingApi } from "./pairing.js";
import { generateIdentity } from "./identity.js";

test("invites round-trip and expire", () => {
  const studio = generateIdentity();
  const invite = createInvite(studio.publicKey, ["ws://192.168.1.10:47381", "ws://[fe80::1]:47381"]);
  expect(invite.text.startsWith("cns1:")).toBe(true);
  const decoded = decodeInvite(invite.text);
  expect(decoded.id).toBe(invite.id);
  expect(decoded.key).toBe(studio.publicKey);
  expect(decoded.addresses).toEqual(invite.addresses);
  expect(Buffer.from(decoded.secret).equals(Buffer.from(invite.secret))).toBe(true);
  expect(decoded.expiresAt - Date.now()).toBeLessThanOrEqual(DEFAULT_INVITE_MS);
  expect(() => decodeInvite(invite.text, invite.expiresAt)).toThrow("expired");
  expect(() => decodeInvite("cns1:nope")).toThrow("not readable");
  expect(() => decodeInvite("ssh-rsa AAAA")).toThrow("starts with cns1:");
  expect(() => decodeInvite(invite.text.slice(0, -4) + "AAAA")).toThrow();
  expect(() => createInvite(studio.publicKey, [])).toThrow("at least one address");
  expect(() => createInvite(studio.publicKey, ["http://x"])).toThrow();
  expect(() => createInvite(studio.publicKey, ["ws://x"], MAX_INVITE_MS + 1)).toThrow();
  // The inviting device's suggested name for itself travels with the invite.
  expect(decodeInvite(createInvite(studio.publicKey, ["ws://x"], undefined, "studio").text).name).toBe("studio");
  expect(decoded.name).toBeUndefined();
  expect(() => createInvite(studio.publicKey, ["ws://x"], undefined, "../etc")).toThrow();
});

test("a pairing API takes one proposal and answers with the decision", async () => {
  const api = new PairingApi(async (proposal) => ({ accept: true, name: proposal.name, granted: proposal.requests.filter((p) => p === "shell") }));
  const decision = await api.propose({ name: "laptop", requests: ["shell", "files"], offers: [] });
  expect(decision).toEqual({ accept: true, name: "laptop", granted: ["shell"] });
  await expect(api.propose({ name: "laptop", requests: [], offers: [] })).rejects.toThrow("already received");
  await expect(new PairingApi(async () => ({ accept: false })).propose({ name: "bad name!", requests: [], offers: [] })).rejects.toThrow();
});
