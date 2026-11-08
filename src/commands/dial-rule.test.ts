import assert from "node:assert/strict";
import test from "node:test";
import { worthDialing } from "./peer.js";

const relay = "wss://relay.example/relay";
const key = "A".repeat(43);

test("a daemon keeps no standing link to a device that gave no address and grants it nothing, such as the gateway", () => {
  assert.equal(worthDialing({ publicKey: key, addresses: [], grants: { outgoing: [] } }, relay), false);
  // It still dials, through the relay, a device that lets it do something.
  assert.equal(worthDialing({ publicKey: key, addresses: [], grants: { outgoing: ["shell"] } }, relay), true);
  // And a device it was told where to reach.
  assert.equal(worthDialing({ publicKey: key, addresses: ["ws://192.0.2.1:47381"], grants: { outgoing: [] } }, relay), true);
  assert.equal(worthDialing({ publicKey: key, addresses: [], grants: { outgoing: ["shell"] } }, undefined), false);
});
