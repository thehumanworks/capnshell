import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import { generateIdentity, newKeyPair } from "./identity.js";
import { firstList, nextList, signList } from "./mesh.js";
import { BOT_TOKEN_PREFIX, decodeBotToken, MAX_TOKEN_CHARS, mintBotToken } from "./mesh-token.js";

const admin = generateIdentity();
const bot = newKeyPair();
const NOW = Date.parse("2026-11-15T12:00:00Z");
const listed = (key = bot.publicKey) => signList(nextList(firstList("home", { key: admin.publicKey, name: "hub" }, NOW), (members) => [...members, { key, name: "ci" }], NOW), admin);

test("a bot token carries the bot's key, its mesh's signed list, the admin's addresses and what members may use", () => {
  const text = mintBotToken(bot.privateKey, listed(), ["ws://192.0.2.1:47381/"], ["shell"]);
  assert.ok(text.startsWith(BOT_TOKEN_PREFIX));
  const token = decodeBotToken(text);
  assert.equal(token.keys.publicKey, bot.publicKey);
  assert.deepEqual([token.list.mesh, token.list.version, token.adminAddresses, token.allow], ["home", 2, ["ws://192.0.2.1:47381/"], ["shell"]]);
});

test("a secret store may preserve outer quotes or wrap an otherwise whole token", () => {
  const text = mintBotToken(bot.privateKey, listed(), [], ["shell"]);
  const wrapped = BOT_TOKEN_PREFIX + text.slice(BOT_TOKEN_PREFIX.length).match(/.{1,72}/g)!.join("\r\n");
  for (const value of [text + "\n\n", `"${text}"`, `'${wrapped}'\r\n`]) {
    assert.equal(decodeBotToken(value).keys.publicKey, bot.publicKey);
  }
});

test("a rejected token says which check failed without echoing its contents", () => {
  const text = mintBotToken(bot.privateKey, listed(), [], ["shell"]);
  const body = JSON.parse(Buffer.from(text.slice(BOT_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  const reencode = (value: unknown) => BOT_TOKEN_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
  const rejects = (value: string, reason: RegExp) => assert.throws(() => decodeBotToken(value), (err: Error) => {
    assert.match(err.message, /CNS_TOKEN/);
    assert.match(err.message, reason);
    assert.ok(!err.message.includes(body.sk) && !err.message.includes(text.slice(8, 40)));
    return true;
  });
  rejects(text.slice(0, -12), /incomplete or damaged/);
  rejects(`CNS_TOKEN=${text}`, /must start with cnsbot1:/);
  rejects(text + "\nToken for ci.", /only the token/);
  rejects(reencode({ ...body, v: 2 }), /token fields/);
  rejects(reencode({ ...body, sk: Buffer.alloc(48).toString("base64url") }), /private key/);
  rejects(reencode({ ...body, list: listed(generateIdentity().publicKey) }), /not listed/);
  rejects(reencode({ ...body, list: { ...body.list, text: body.list.text.replace('"ci"', '"cj"') } }), /signed member list/);
  rejects(reencode({ ...body, admin: ["http://example.com"] }), /admin address/);
  rejects(BOT_TOKEN_PREFIX + "a".repeat(MAX_TOKEN_CHARS), /too long/);
});

test("minting checks what the bot will check, before handing out its key", () => {
  assert.throws(() => mintBotToken(bot.privateKey, listed(), ["http://example.com"], []), /admin address/);
  assert.throws(() => mintBotToken(bot.privateKey, listed(generateIdentity().publicKey), [], []), /not listed/);
  // A token must neither be the admin's identity nor exceed the environment size limit.
  const keys = newKeyPair();
  const privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, "base64url"), format: "der", type: "pkcs8" });
  const signer = { ...admin, publicKey: keys.publicKey, sign: (data: Uint8Array) => sign(null, data, privateKey) };
  assert.throws(() => mintBotToken(keys.privateKey, signList(firstList("home", { key: keys.publicKey, name: "hub" }, NOW), signer), [], []), /admin's own key/);
  assert.throws(() => mintBotToken(bot.privateKey, { text: "x".repeat(MAX_TOKEN_CHARS), sig: listed().sig }, [], []), /more than an environment variable/);
});
