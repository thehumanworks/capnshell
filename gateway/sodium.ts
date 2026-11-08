/**
 * What src/secure.ts uses of libsodium-wrappers, for the gateway Worker: wrangler.toml
 * aliases libsodium-wrappers to this file. Workers forbid compiling WebAssembly at run
 * time, which libsodium.js does when it loads, so this delegates to nacl.ts.
 */
import * as nacl from "./nacl.js";

const sodium = {
  ready: Promise.resolve(),
  crypto_kx_keypair: nacl.kxKeypair,
  crypto_kx_client_session_keys: nacl.kxClientSessionKeys,
  crypto_kx_server_session_keys: nacl.kxServerSessionKeys,
  crypto_secretstream_xchacha20poly1305_HEADERBYTES: nacl.HEADERBYTES,
  crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: nacl.TAG_MESSAGE,
  crypto_secretstream_xchacha20poly1305_init_push: nacl.initPush,
  crypto_secretstream_xchacha20poly1305_init_pull: nacl.initPull,
  crypto_secretstream_xchacha20poly1305_push: (stream: nacl.StreamState, message: Uint8Array, ad: Uint8Array | null, tag: number) =>
    nacl.push(stream, message, ad ?? undefined, tag),
  crypto_secretstream_xchacha20poly1305_pull: (stream: nacl.StreamState, record: Uint8Array, ad: Uint8Array | null) =>
    nacl.pull(stream, record, ad ?? undefined) ?? false,
  /** secure.ts wipes and frees libsodium's heap copies of stream states; these states are plain objects, so there is nothing to free. */
  libsodium: { HEAPU8: new Uint8Array(0), _free() {} },
};

export default sodium;
