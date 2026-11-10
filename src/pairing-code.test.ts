import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import test from "node:test";
import sodium from "libsodium-wrappers-sumo";
import {
  calculateGenerator, CODE_WORDS, formatCode, generatorString, hostCode, intermediateKey, inviteForCode, isPairingCode, lvCat, MAX_WRONG_CODES,
  parseCode, PairingCodeError, prependLen, randomWords, sampleScalar, scalarMult, scalarMultVfy,
} from "./pairing-code.js";
import { createInvite } from "./pairing.js";
import { startRelay } from "./relay-server.js";
import { unusedPort } from "./test-support.js";
import { WORDS } from "./words.js";

const hex = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "hex");
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the word list is BIP-39's English list: 2048 lowercase words, unique in their first four letters", () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(createHash("sha256").update(WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
  assert.equal(new Set(WORDS.map((word) => word.slice(0, 4))).size, 2048);
  assert.ok(WORDS.every((word) => /^[a-z]{3,8}$/.test(word)));
});

test("codes are a number and three words, typed with dashes or spaces, any case, four letters per word", () => {
  const code = { room: 42, words: ["orbit", "canyon", "velvet"] };
  assert.equal(formatCode(code), "42-orbit-canyon-velvet");
  assert.deepEqual(parseCode("42-orbit-canyon-velvet"), code);
  assert.deepEqual(parseCode(["42", "Orbit", "CANYON", "velvet"]), code);
  assert.deepEqual(parseCode("42 orbi cany velv"), code);
  // Four letters name one word; what follows them does not matter, as in BIP-39.
  assert.deepEqual(parseCode("42-orbitt-canyonn-velvit"), code);
  // Three-letter words are typed whole.
  assert.deepEqual(parseCode("7-act-add-zoo").words, ["act", "add", "zoo"]);
  assert.throws(() => parseCode("42-orb-canyon-velvet"), /"orb" is not a word cns uses/);
  assert.throws(() => parseCode("42-qqqq-canyon-velvet"), /"qqqq" is not a word/);
  assert.throws(() => parseCode("42-orbit-canyon"), /a number and three words/);
  assert.throws(() => parseCode("orbit-canyon-velvet-42"), /a number and three words/);
  assert.throws(() => parseCode("0-orbit-canyon-velvet"), /a number and three words/);
  assert.ok(isPairingCode("42-orbit-canyon-velvet"));
  assert.ok(!isPairingCode("cns1:abc"));
  const words = randomWords();
  assert.equal(words.length, CODE_WORDS);
  assert.ok(words.every((word) => WORDS.includes(word)));
});

test("LEB128 lengths and lv_cat match the CPace draft's vectors", () => {
  assert.equal(toHex(prependLen(new Uint8Array(0))), "00");
  assert.equal(toHex(prependLen(Buffer.from("1234"))), "0431323334");
  assert.equal(toHex(prependLen(new Uint8Array(127))).slice(0, 2), "7f");
  assert.equal(toHex(prependLen(new Uint8Array(128))).slice(0, 4), "8001");
  assert.equal(toHex(lvCat(Buffer.from("1234"), Buffer.from("5"), Buffer.from(""), Buffer.from("678"))), "043132333401350003363738");
});

test("CPace on ristretto255 with SHA-512 matches draft-irtf-cfrg-cpace-21 appendix B.3", async () => {
  await sodium.ready;
  const prs = Buffer.from("Password");
  const ci = hex("0b415f696e69746961746f720b425f726573706f6e646572");
  const sid = hex("7e4b4791d6a8ef019b936c79fb7f2c57");
  assert.equal(toHex(generatorString(prs, ci, sid)), [
    "11435061636552697374726574746f3235350850617373776f726464",
    "00000000000000000000000000000000000000000000000000000000",
    "00000000000000000000000000000000000000000000000000000000",
    "00000000000000000000000000000000000000000000000000000000",
    "00000000000000000000000000000000180b415f696e69746961746f",
    "720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f",
    "2c57",
  ].join(""));
  const g = calculateGenerator(prs, ci, sid);
  assert.equal(toHex(g), "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56");
  const ya = hex("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08");
  const yb = hex("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d");
  const Ya = scalarMult(ya, g);
  const Yb = scalarMult(yb, g);
  assert.equal(toHex(Ya), "d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157");
  assert.equal(toHex(Yb), "3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258");
  const k = "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f";
  assert.equal(toHex(scalarMultVfy(ya, Yb)!), k);
  assert.equal(toHex(scalarMultVfy(yb, Ya)!), k);
  assert.equal(toHex(intermediateKey(sid, hex(k), Ya, Buffer.from("ADa"), Yb, Buffer.from("ADb"))), [
    "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dc",
    "ae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c",
    "3fa2068af7900447",
  ].join(""));
  // B.3.10 and B.3.11: a valid point multiplies; an invalid encoding or the identity aborts.
  const s = hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05");
  assert.equal(toHex(scalarMultVfy(s, hex("2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c"))!), "7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e");
  assert.equal(scalarMultVfy(s, hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c")), undefined);
  assert.equal(scalarMultVfy(s, new Uint8Array(32)), undefined);
  assert.equal(scalarMultVfy(s, new Uint8Array(31)), undefined);
});

test("sampled scalars have the bits above 252 clear", () => {
  for (let i = 0; i < 64; i++) assert.ok(sampleScalar()[31]! < 0x10);
});

async function withRelay(t: test.TestContext) {
  const port = Number(await unusedPort("127.0.0.1"));
  const relay = startRelay({ bind: "127.0.0.1", port });
  t.after(() => relay.stop());
  return `ws://127.0.0.1:${port}`;
}
const invite = () => createInvite(Buffer.alloc(32, 7).toString("base64url"), ["ws://192.0.2.1:47381"], 60_000, os.hostname().split(".")[0]?.replace(/[^a-zA-Z0-9_-]/g, "") || "studio").text;

test("a device that types the code gets the invite through the relay, once", async (t) => {
  const relay = await withRelay(t);
  const text = invite();
  const hosted = await hostCode(relay, text);
  assert.match(hosted.code, /^1-[a-z]+-[a-z]+-[a-z]+$/);
  assert.equal(await inviteForCode(relay, parseCode(hosted.code)), text);
  await hosted.delivered;
  // The room closed with the delivery: the same code no longer reaches anything.
  await assert.rejects(inviteForCode(relay, parseCode(hosted.code)), (error: unknown) => error instanceof PairingCodeError && error.code === "unknown" && /No device is showing code/.test(error.message));
});

test("wrong codes are reported to both sides, and the code stops working after three", async (t) => {
  const relay = await withRelay(t);
  const wrongs: number[] = [];
  const hosted = await hostCode(relay, invite(), { wrong: (tries) => wrongs.push(tries) });
  const right = parseCode(hosted.code);
  const other = WORDS.find((word) => !right.words.includes(word))!;
  const wrong = { room: right.room, words: [right.words[0]!, right.words[1]!, other] };
  for (let tries = 1; tries <= MAX_WRONG_CODES; tries++) {
    await assert.rejects(inviteForCode(relay, wrong), (error: unknown) => error instanceof PairingCodeError && error.code === "wrong" && (tries < MAX_WRONG_CODES ? /(try|tries) left/ : /last try/).test(error.message));
    assert.equal(wrongs.length, tries);
  }
  await assert.rejects(hosted.delivered, (error: unknown) => error instanceof PairingCodeError && error.code === "wrong" && /no longer works/.test(error.message));
  // Even the right words reach nothing now.
  await assert.rejects(inviteForCode(relay, right), (error: unknown) => error instanceof PairingCodeError && error.code === "unknown");
});

test("a mistyped word costs a try but the right code still works after it", async (t) => {
  const relay = await withRelay(t);
  const text = invite();
  const hosted = await hostCode(relay, text);
  const right = parseCode(hosted.code);
  const other = WORDS.find((word) => !right.words.includes(word))!;
  await assert.rejects(inviteForCode(relay, { room: right.room, words: [right.words[0]!, other, right.words[2]!] }), (error: unknown) => error instanceof PairingCodeError && error.code === "wrong" && /2 tries left/.test(error.message));
  assert.equal(await inviteForCode(relay, right), text);
  await hosted.delivered;
});

test("rooms get the lowest free number, one guest at a time, and closing a room ends its code", async (t) => {
  const relay = await withRelay(t);
  const first = await hostCode(relay, invite());
  const second = await hostCode(relay, invite());
  assert.deepEqual([parseCode(first.code).room, parseCode(second.code).room], [1, 2]);
  second.close();
  await second.delivered;
  // A closed room's number is not given out again at once, so a late guest cannot reach a newer room.
  const third = await hostCode(relay, invite());
  assert.equal(parseCode(third.code).room, 3);
  await assert.rejects(inviteForCode(relay, parseCode(second.code)), (error: unknown) => error instanceof PairingCodeError && error.code === "unknown");
  first.close();
  third.close();
});
