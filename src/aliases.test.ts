import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, symlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAlias, listAliases, removeAlias, resolveAlias } from "./aliases.js";
import { parseOptions } from "./options.js";

let dir: string;
const previous = process.env.CNS_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "cns-alias-")); process.env.CNS_CONFIG_DIR = dir; });
afterEach(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; rmSync(dir, { recursive: true, force: true }); });

test.skipIf(process.platform === "win32")("saved aliases resolve explicitly for existing peer commands", () => {
  addAlias("studio", "ws://localhost:47381");
  expect(listAliases()).toEqual([{ name: "studio", url: "ws://localhost:47381/" }]);
  expect(parseOptions(["run", "--peer", "studio", "--", "pwd"]).url).toBe("ws://localhost:47381/");
  expect(parseOptions(["screen", "--peer", "studio", "build"]).url).toBe("ws://localhost:47381/");
  expect(parseOptions(["connect", "--peer", "studio"]).url).toBe("ws://localhost:47381/");
  removeAlias("studio");
  expect(() => resolveAlias("studio")).toThrow("Unknown peer alias");
});

test.skipIf(process.platform === "win32")("aliases never silently replace, fall back or override explicit targets", () => {
  addAlias("studio", "ws://localhost:47381");
  expect(() => addAlias("studio", "ws://other:47381")).toThrow();
  expect(() => parseOptions(["run", "--peer", "missing", "--", "pwd"])).toThrow("Unknown peer alias");
  expect(() => parseOptions(["run", "ws://other:47381", "--peer", "studio", "--", "pwd"])).toThrow("either a URL or --peer");
  expect(() => parseOptions(["run", "--peer", "studio", "--port", "47382", "--", "pwd"])).toThrow("either a URL or --port");
  expect(() => addAlias("../other", "ws://localhost")).toThrow();
  expect(() => addAlias("bad", "ws://user:password@localhost")).toThrow();
});

test.skipIf(process.platform === "win32")("rejects alias files readable by other users", () => {
  addAlias("studio", "ws://localhost:47381");
  chmodSync(path.join(dir, "peers", "studio"), 0o644);
  expect(() => resolveAlias("studio")).toThrow("private file");
});

test.skipIf(process.platform === "win32")("saved addresses reject paths and queries while explicit URLs still allow them", () => {
  expect(() => addAlias("path", "ws://localhost/private-token")).toThrow("path or query");
  expect(() => addAlias("query", "ws://localhost/?token=secret")).toThrow("path or query");
  expect(parseOptions(["connect", "ws://localhost/private?token=secret"]).url).toBe("ws://localhost/private?token=secret");
});

test.skipIf(process.platform === "win32")("rejects unsafe directories and symlink aliases", () => {
  addAlias("studio", "ws://localhost:47381");
  chmodSync(path.join(dir, "peers"), 0o777);
  expect(() => resolveAlias("studio")).toThrow("directory must be private");
  chmodSync(path.join(dir, "peers"), 0o700);
  symlinkSync(path.join(dir, "peers", "studio"), path.join(dir, "peers", "link"));
  expect(() => resolveAlias("link")).toThrow();
});


test.skipIf(process.platform === "win32")("rejects a shared-writable non-sticky ancestor", () => {
  const parent = path.join(dir, "shared");
  mkdirSync(parent, { mode: 0o777 });
  chmodSync(parent, 0o777);
  process.env.CNS_CONFIG_DIR = path.join(parent, "config");
  mkdirSync(process.env.CNS_CONFIG_DIR, { mode: 0o700 });
  expect(() => addAlias("studio", "ws://localhost:47381")).toThrow("shared-writable ancestor");
});


test.skipIf(process.platform === "win32")("custom configuration directory must already exist", () => {
  process.env.CNS_CONFIG_DIR = path.join(dir, "missing");
  expect(() => addAlias("studio", "ws://localhost:47381")).toThrow();
});


test.skipIf(process.platform === "win32")("rejects a symlink as the custom configuration directory", () => {
  const target = path.join(dir, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = path.join(dir, "config-link");
  symlinkSync(target, link);
  process.env.CNS_CONFIG_DIR = link;
  expect(() => addAlias("studio", "ws://localhost:47381")).toThrow("directory must be private");
});

test.skipIf(process.platform !== "win32")("saved aliases fail closed on Windows", () => {
  expect(() => addAlias("studio", "ws://localhost:47381")).toThrow("not available on Windows");
  process.env.CNS_CONFIG_DIR = path.join(dir, "missing");
  expect(() => listAliases()).toThrow("not available on Windows");
  expect(() => resolveAlias("studio")).toThrow("not available on Windows");
  expect(() => removeAlias("studio")).toThrow("not available on Windows");
});
