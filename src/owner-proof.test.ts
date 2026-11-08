import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity } from "./identity.js";
import { ownerKeys, ownerProof, OWNER_SKEW_MS, verifyOwner } from "./owner-proof.js";

const url = "https://gateway.example/admin/approve";
const body = new TextEncoder().encode(JSON.stringify({ code: "ABCD-EFGH" }));

function checker(owners: string[]) {
  const seen = new Set<string>();
  return { owners, claimNonce: async (nonce: string) => { if (seen.has(nonce)) return false; seen.add(nonce); return true; } };
}

test("an owner's signed request is accepted once, and only as signed", async () => {
  const owner = generateIdentity();
  const check = checker([owner.publicKey]);
  const header = ownerProof(owner, "POST", url, body);
  const accepted = await verifyOwner(header, { method: "POST", url }, body, check);
  assert.deepEqual(accepted, { owner: owner.publicKey, fingerprint: owner.fingerprint });
  assert.match(JSON.stringify(await verifyOwner(header, { method: "POST", url }, body, check)), /already received/);

  const fresh = () => ownerProof(owner, "POST", url, body);
  // Each part of the request is covered: another body, path, host or method does not verify.
  assert.match(JSON.stringify(await verifyOwner(fresh(), { method: "POST", url }, new TextEncoder().encode("{}"), check)), /does not match/);
  assert.match(JSON.stringify(await verifyOwner(fresh(), { method: "POST", url: "https://gateway.example/admin/revoke" }, body, check)), /does not match/);
  assert.match(JSON.stringify(await verifyOwner(fresh(), { method: "POST", url: "https://other.example/admin/approve" }, body, check)), /does not match/);
  assert.match(JSON.stringify(await verifyOwner(fresh(), { method: "PUT", url }, body, check)), /does not match/);
});

test("requests from other devices, stale requests and unreadable headers are refused", async () => {
  const owner = generateIdentity();
  const stranger = generateIdentity();
  const check = checker([owner.publicKey]);
  assert.match(JSON.stringify(await verifyOwner(ownerProof(stranger, "POST", url, body), { method: "POST", url }, body, check)), /not an owner/);
  const old = ownerProof(owner, "POST", url, body, Date.now() - OWNER_SKEW_MS - 1000);
  assert.match(JSON.stringify(await verifyOwner(old, { method: "POST", url }, body, check)), /too far/);
  // A stranger's signature under the owner's key does not verify.
  const forged = ownerProof(stranger, "POST", url, body).replace(stranger.publicKey, owner.publicKey);
  assert.match(JSON.stringify(await verifyOwner(forged, { method: "POST", url }, body, check)), /does not match/);
  for (const header of [null, "", "cns-owner-1", "Bearer x", `cns-owner-1 ${owner.publicKey} now nonce sig`]) {
    assert.ok("refused" in await verifyOwner(header, { method: "POST", url }, body, check));
  }
});

test("OWNER_KEYS takes public keys separated by commas or spaces", () => {
  const a = generateIdentity().publicKey;
  const b = generateIdentity().publicKey;
  assert.deepEqual(ownerKeys(`${a}, ${b}\n`), [a, b]);
  assert.deepEqual(ownerKeys(undefined), []);
  assert.throws(() => ownerKeys("not-a-key"), /not a device public key/);
});
