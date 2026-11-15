import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity, verify } from "./identity.js";
import { pairedPeerSchema } from "./peers.js";
import { decodeToken, explainTokenRefusal, mintToken, parseExpiry, TOKEN_EXPIRED, TOKEN_PREFIX, TokenError, tokenExpired, tokenRefusal, tokensFrom, tokenTarget } from "./tokens.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const studio = { name: "studio", publicKey: generateIdentity().publicKey, addresses: ["ws://192.168.1.5:47381", `wss://relay.example/v1/dial/${"A".repeat(43)}`] };
const laptop = { name: "laptop", publicKey: generateIdentity().publicKey, addresses: ["ws://10.0.0.2:47381"] };

test("a token carries a working identity whose public key is all the device saves", () => {
  const minted = mintToken(studio, "ci", NOW + 30 * DAY);
  assert.ok(minted.text.startsWith(TOKEN_PREFIX));
  const token = decodeToken(minted.text);
  assert.equal(token.identity.publicKey, minted.publicKey);
  assert.equal(token.as, "ci");
  assert.deepEqual(token.device, studio);
  assert.equal(token.expiresAt, NOW + 30 * DAY);
  // It signs as the key the device saved, which is how the handshake proves it.
  const data = new TextEncoder().encode("challenge");
  assert.ok(verify(minted.publicKey, data, token.identity.sign(data)));
  // Each token is a new key pair.
  assert.notEqual(mintToken(studio, "ci").publicKey, minted.publicKey);
  // Without an expiry it has none.
  assert.equal(decodeToken(mintToken(studio, "ci").text).expiresAt, undefined);
});

test("a token is refused unless whole and well formed, with a usage exit status", () => {
  const { text } = mintToken(studio, "ci");
  for (const bad of ["", "cns1:abc", text.slice(0, -4), `${TOKEN_PREFIX}not-json`, `${TOKEN_PREFIX}${Buffer.from(JSON.stringify({ v: 1 })).toString("base64url")}`]) {
    assert.throws(() => decodeToken(bad), (error: unknown) => error instanceof TokenError && error.exitCode === 2 && /CNS_TOKEN is not a cns token/.test(error.message), bad);
  }
  // An address that is not ws:// or wss:// is not a token cns made.
  const body = JSON.parse(Buffer.from(text.slice(TOKEN_PREFIX.length), "base64url").toString());
  const tampered = TOKEN_PREFIX + Buffer.from(JSON.stringify({ ...body, addr: ["http://example.com"] })).toString("base64url");
  assert.throws(() => decodeToken(tampered), /not a cns token/);
  assert.throws(() => mintToken({ ...studio, addresses: [] }, "ci"), /at least one address/);
});

test("CNS_TOKEN holds one token per device, separated by spaces, commas or lines", () => {
  assert.equal(tokensFrom(undefined), undefined);
  assert.equal(tokensFrom("  \n"), undefined);
  const a = mintToken(studio, "ci").text;
  const b = mintToken(laptop, "ci").text;
  assert.deepEqual(tokensFrom(`${a} ${b}`)!.map((token) => token.device.name), ["studio", "laptop"]);
  assert.deepEqual(tokensFrom(`${a},\n${b}\n`)!.map((token) => token.device.name), ["studio", "laptop"]);
  assert.throws(() => tokensFrom(`${a} ${mintToken(studio, "other").text}`), /two tokens for studio/);
});

test("a command names a device a token is for, before the token expires", () => {
  const tokens = tokensFrom(`${mintToken(studio, "ci", NOW + DAY).text} ${mintToken(laptop, "ci", NOW - 1).text}`)!;
  const target = tokenTarget("studio", tokens, NOW);
  assert.equal(target.publicKey, studio.publicKey);
  assert.deepEqual(target.addresses, studio.addresses);
  assert.equal(target.identity.publicKey, tokens[0]!.identity.publicKey);
  assert.throws(() => tokenTarget("beelink", tokens, NOW), (error: unknown) => error instanceof TokenError && error.exitCode === 2 && /reaches studio, laptop, not beelink/.test(error.message));
  assert.throws(() => tokenTarget("laptop", tokens, NOW), (error: unknown) => error instanceof TokenError && error.exitCode === 3 && /expired on 2026-11-15\. On laptop, make a new one: cns token create/.test(error.message));
  // At the instant it expires, it no longer works.
  assert.throws(() => tokenTarget("studio", tokens, NOW + DAY), /expired/);
});

test("a device refuses a token record from the moment it expires, and nothing else", () => {
  const record = { token: { expiresAt: new Date(NOW + DAY).toISOString() } };
  assert.equal(tokenExpired(record, NOW), false);
  assert.equal(tokenRefusal(record, NOW), undefined);
  assert.equal(tokenExpired(record, NOW + DAY), true);
  assert.deepEqual(tokenRefusal(record, NOW + DAY), { code: "not-paired", reason: TOKEN_EXPIRED });
  // A token without an expiry, and a device that paired, never expire.
  assert.equal(tokenRefusal({ token: {} }, Number.MAX_SAFE_INTEGER), undefined);
  assert.equal(tokenRefusal({}, Number.MAX_SAFE_INTEGER), undefined);
});

test("the program holding a token is told why the device refused it and what to run", () => {
  assert.match(explainTokenRefusal("studio", `The peer refused the connection: ${TOKEN_EXPIRED}`), /^studio refused this token: it has expired\. On studio, make a new one: cns token create/);
  assert.match(explainTokenRefusal("studio", "Not paired with this device. Run cns pair on it."), /^studio does not accept this token: it was revoked, or studio runs a cns older than \d+\.\d+\.\d+ .*cns token list/);
});

test("--expires takes days, hours or never", () => {
  assert.equal(parseExpiry("30d", NOW), NOW + 30 * DAY);
  assert.equal(parseExpiry("12h", NOW), NOW + 12 * 3_600_000);
  assert.equal(parseExpiry("never", NOW), undefined);
  for (const bad of ["0d", "30", "1w", "-1d", "1.5d", "999999d", ""]) assert.throws(() => parseExpiry(bad, NOW), /--expires takes/, bad);
});

test("a token record holds an expiry date and nothing else", () => {
  const record = { version: 2, publicKey: studio.publicKey, addresses: [], pairedAt: new Date(NOW).toISOString(), grants: { incoming: ["shell"], outgoing: [] } };
  assert.ok(pairedPeerSchema.safeParse({ ...record, token: { expiresAt: new Date(NOW).toISOString() } }).success);
  assert.ok(pairedPeerSchema.safeParse({ ...record, token: {} }).success);
  assert.ok(!pairedPeerSchema.safeParse({ ...record, token: { expiresAt: "soon" } }).success);
  assert.ok(!pairedPeerSchema.safeParse({ ...record, token: { expiresAt: new Date(NOW).toISOString(), extra: 1 } }).success);
});
