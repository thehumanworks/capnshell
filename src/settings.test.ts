import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredRelay, loadSettings, saveSettings, settingsPath } from "./settings.js";

let dir: string;
const previous = { config: process.env.CNS_CONFIG_DIR, relay: process.env.CNS_RELAY };
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "cns-settings-")); process.env.CNS_CONFIG_DIR = dir; delete process.env.CNS_RELAY; });
afterEach(() => {
  for (const [name, value] of [["CNS_CONFIG_DIR", previous.config], ["CNS_RELAY", previous.relay]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("the relay is saved privately and read back", () => {
  expect(loadSettings()).toEqual({});
  expect(configuredRelay()).toBeUndefined();
  saveSettings({ relay: "wss://relay.example/?token=secret" });
  expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ version: 1, relay: "wss://relay.example/?token=secret" });
  expect(configuredRelay()).toEqual({ url: "wss://relay.example/?token=secret", source: "config" });
  saveSettings({});
  expect(configuredRelay()).toBeUndefined();
});

test.skipIf(process.platform === "win32")("--relay, then CNS_RELAY, then the saved relay", () => {
  saveSettings({ relay: "wss://saved.example" });
  process.env.CNS_RELAY = "wss://env.example";
  expect(configuredRelay()).toEqual({ url: "wss://env.example", source: "env" });
  expect(configuredRelay("wss://flag.example")).toEqual({ url: "wss://flag.example", source: "flag" });
});

test.skipIf(process.platform === "win32")("bad relay URLs and unsafe or invalid settings files are refused", () => {
  expect(() => saveSettings({ relay: "ftp://relay.example" })).toThrow("A relay URL starts with");
  expect(() => saveSettings({ relay: "wss://user:pass@relay.example" })).toThrow("no credentials");
  saveSettings({ relay: "wss://relay.example" });
  chmodSync(settingsPath(), 0o644);
  expect(() => loadSettings()).toThrow("private file");
  writeFileSync(settingsPath(), "{", { mode: 0o600 });
  chmodSync(settingsPath(), 0o600);
  expect(() => loadSettings()).toThrow("not valid JSON");
  writeFileSync(settingsPath(), JSON.stringify({ version: 1, other: true }));
  expect(() => loadSettings()).toThrow("not valid");
});
