import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

test.skipIf(process.platform !== "win32")("on Windows, an identity is created in a private directory and loads back", () => {
  const first = ensureIdentity();
  expect(first.created).toBe(true);
  expect(loadIdentity()?.publicKey).toBe(first.identity.publicKey);
  expect(ensureIdentity().created).toBe(false);
});

test.skipIf(process.platform !== "win32")("on Windows, a directory that other users can read is refused", () => {
  // Grant Users (S-1-5-32-545) read access, as a shared folder might.
  execFileSync("icacls.exe", [dir, "/grant", "*S-1-5-32-545:(OI)(CI)R"]);
  expect(() => ensureIdentity()).toThrow("must be private");
});

test.skipIf(process.platform !== "win32")("on Windows, the default directory is created with a private ACL", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cns-home-"));
  // Even under a parent that Users can read, the new directory keeps only its own entries.
  execFileSync("icacls.exe", [home, "/grant", "*S-1-5-32-545:(OI)(CI)R"]);
  const previousHome = process.env.USERPROFILE;
  delete process.env.CNS_CONFIG_DIR;
  process.env.USERPROFILE = home;
  try {
    expect(ensureIdentity().created).toBe(true);
    expect(loadIdentity()).toBeDefined();
  } finally {
    process.env.USERPROFILE = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
