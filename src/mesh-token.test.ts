import assert from "node:assert/strict";
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

test("a bot token is refused unless it is whole and its mesh's admin lists the bot", () => {
  const unreadable = /CNS_TOKEN is not a cns mesh bot token/;
  const text = mintBotToken(bot.privateKey, listed(), [], ["shell"]);
  assert.throws(() => decodeBotToken(text.slice(0, -12)), unreadable);
  assert.throws(() => decodeBotToken(`cnst1:${text.slice(BOT_TOKEN_PREFIX.length)}`), unreadable);
  // A list without the bot, or the admin's own key passed off as a bot.
  assert.throws(() => decodeBotToken(mintBotToken(bot.privateKey, listed(generateIdentity().publicKey), [], [])), unreadable);
  const body = JSON.parse(Buffer.from(text.slice(BOT_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  const reencode = (value: unknown) => BOT_TOKEN_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
  // A list someone changed after the admin signed it.
  assert.throws(() => decodeBotToken(reencode({ ...body, list: { ...body.list, text: body.list.text.replace('"ci"', '"cj"') } })), unreadable);
  assert.throws(() => decodeBotToken(reencode({ ...body, admin: ["http://example.com"] })), unreadable);
  // One that would not fit in an environment variable is never printed.
  assert.throws(() => mintBotToken(bot.privateKey, { text: "x".repeat(MAX_TOKEN_CHARS), sig: listed().sig }, [], []), /more than an environment variable/);
});
