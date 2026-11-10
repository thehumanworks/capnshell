import assert from "node:assert/strict";
import test from "node:test";
import sodium from "libsodium-wrappers-sumo";
import * as nacl from "./nacl.js";
import shim from "./sodium.js";

await sodium.ready;
const bytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

test("crypto_kx session keys match libsodium's on both sides", () => {
  for (let i = 0; i < 20; i++) {
    const client = nacl.kxKeypair();
    const server = sodium.crypto_kx_keypair();
    const ours = nacl.kxClientSessionKeys(client.publicKey, client.privateKey, server.publicKey);
    const theirs = sodium.crypto_kx_server_session_keys(server.publicKey, server.privateKey, client.publicKey);
    assert.deepEqual(ours.sharedTx, theirs.sharedRx);
    assert.deepEqual(ours.sharedRx, theirs.sharedTx);

    const client2 = sodium.crypto_kx_keypair();
    const server2 = nacl.kxKeypair();
    const theirs2 = sodium.crypto_kx_client_session_keys(client2.publicKey, client2.privateKey, server2.publicKey);
    const ours2 = nacl.kxServerSessionKeys(server2.publicKey, server2.privateKey, client2.publicKey);
    assert.deepEqual(ours2.sharedTx, theirs2.sharedRx);
    assert.deepEqual(ours2.sharedRx, theirs2.sharedTx);
  }
});

for (const direction of ["nacl to libsodium", "libsodium to nacl"] as const) {
  test(`secretstream records travel ${direction}, with associated data and rekeying`, () => {
    const key = bytes(32);
    const fromNacl = direction === "nacl to libsodium";
    const pushed = fromNacl ? nacl.initPush(key) : sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    const sender = pushed.state;
    const receiver = fromNacl
      ? sodium.crypto_secretstream_xchacha20poly1305_init_pull(pushed.header, key)
      : nacl.initPull(pushed.header, key);
    for (let i = 0; i < 300; i++) {
      // Every length mod 16, empty messages, and lengths past one ChaCha20 block.
      const message = bytes((i * 37) % 5000);
      const tag = i % 50 === 49 ? nacl.TAG_REKEY : nacl.TAG_MESSAGE;
      const ad = i % 3 === 0 ? bytes(i % 20) : null;
      const record = fromNacl
        ? nacl.push(sender as nacl.StreamState, message, ad ?? undefined, tag)
        : sodium.crypto_secretstream_xchacha20poly1305_push(sender as never, message, ad, tag);
      assert.equal(record.length, message.length + nacl.ABYTES);
      const opened = fromNacl
        ? sodium.crypto_secretstream_xchacha20poly1305_pull(receiver as never, record, ad)
        : nacl.pull(receiver as nacl.StreamState, record, ad ?? undefined);
      assert.ok(opened, `record ${i} failed to open`);
      assert.deepEqual(opened.message, message);
      assert.equal(opened.tag, tag);
    }
  });
}

test("a tampered, truncated or replayed record does not open, and leaves the stream usable", () => {
  const key = bytes(32);
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const first = sodium.crypto_secretstream_xchacha20poly1305_push(state, new Uint8Array([1, 2, 3]), null, 0);
  const second = sodium.crypto_secretstream_xchacha20poly1305_push(state, new Uint8Array([4, 5]), null, 0);
  const receiver = nacl.initPull(header, key);
  for (let index = 0; index < first.length; index++) {
    const tampered = first.slice();
    tampered[index]! ^= 1;
    assert.equal(nacl.pull(receiver, tampered), undefined);
  }
  assert.equal(nacl.pull(receiver, first.subarray(0, 16)), undefined);
  assert.equal(nacl.pull(receiver, second), undefined, "out of order");
  assert.deepEqual(nacl.pull(receiver, first)?.message, new Uint8Array([1, 2, 3]));
  assert.equal(nacl.pull(receiver, first), undefined, "replayed");
  assert.deepEqual(nacl.pull(receiver, second)?.message, new Uint8Array([4, 5]));
});

test("the libsodium stand-in answers as libsodium-wrappers does", () => {
  const key = bytes(32);
  const pushed = shim.crypto_secretstream_xchacha20poly1305_init_push(key);
  const record = shim.crypto_secretstream_xchacha20poly1305_push(pushed.state, new Uint8Array([9]), null, shim.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
  const receiver = shim.crypto_secretstream_xchacha20poly1305_init_pull(pushed.header, key);
  assert.equal(shim.crypto_secretstream_xchacha20poly1305_pull(receiver, record.subarray(1), null), false);
  const opened = shim.crypto_secretstream_xchacha20poly1305_pull(receiver, record, null);
  assert.ok(opened);
  assert.deepEqual(opened.message, new Uint8Array([9]));
});
