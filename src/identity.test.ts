import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureIdentity, fingerprint, generateIdentity, identityPath, loadIdentity, verify } from "./identity.js";

let dir: string;
const previous = process.env.CNS_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "cns-identity-")); process.env.CNS_CONFIG_DIR = dir; });
afterEach(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; rmSync(dir, { recursive: true, force: true }); });

test.skipIf(process.platform === "win32")("an identity is created once, privately, and loads back unchanged", () => {
  expect(loadIdentity()).toBeUndefined();
  const first = ensureIdentity();
  expect(first.created).toBe(true);
  expect(statSync(identityPath()).mode & 0o777).toBe(0o600);
  const again = ensureIdentity();
  expect(again.created).toBe(false);
  expect(again.identity.publicKey).toBe(first.identity.publicKey);
  expect(loadIdentity()?.fingerprint).toBe(first.identity.fingerprint);
  const message = new TextEncoder().encode("transcript");
  const signature = first.identity.sign(message);
  expect(signature.length).toBe(64);
  expect(verify(first.identity.publicKey, message, signature)).toBe(true);
  expect(verify(first.identity.publicKey, new TextEncoder().encode("other"), signature)).toBe(false);
  expect(verify(generateIdentity().publicKey, message, signature)).toBe(false);
});

test("fingerprints are stable, distinct and readable", () => {
  const key = "Ka4TUI49lUw7IavFEJGbsBafQ3n2EuMIKtScHXvyaJI";
  expect(fingerprint(key)).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){5}$/);
  expect(fingerprint(key)).toBe(fingerprint(key));
  expect(fingerprint(generateIdentity().publicKey)).not.toBe(fingerprint(key));
  expect(() => fingerprint("short")).toThrow();
});

test.skipIf(process.platform === "win32")("unsafe or inconsistent identity files are refused", () => {
  const { identity } = ensureIdentity();
  chmodSync(identityPath(), 0o644);
  expect(() => loadIdentity()).toThrow("private file");
  chmodSync(identityPath(), 0o600);
  const file = JSON.parse(readFileSync(identityPath(), "utf8"));
  writeFileSync(identityPath(), JSON.stringify({ ...file, publicKey: generateIdentity().publicKey }));
  expect(() => loadIdentity()).toThrow("inconsistent");
  writeFileSync(identityPath(), JSON.stringify({ ...file, version: 2 }));
  expect(() => loadIdentity()).toThrow();
  writeFileSync(identityPath(), JSON.stringify(file));
  expect(loadIdentity()?.publicKey).toBe(identity.publicKey);
  chmodSync(dir, 0o755);
  expect(() => loadIdentity()).toThrow("directory must be private");
  chmodSync(dir, 0o700);
});

test.skipIf(process.platform !== "win32")("identities fail closed on Windows", () => {
  expect(() => ensureIdentity()).toThrow("not available on Windows");
  expect(() => loadIdentity()).toThrow("not available on Windows");
});
