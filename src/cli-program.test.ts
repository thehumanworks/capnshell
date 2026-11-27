import assert from "node:assert/strict";
import test from "node:test";
import type { Command } from "commander";
import { createCli, uiTarget } from "./cli-program.js";

/** Every command a person can type, the root included. */
function commands(command: Command): Command[] {
  return [command, ...command.commands.filter((sub) => !(sub as unknown as { _hidden: boolean })._hidden).flatMap(commands)];
}
const path = (command: Command): string => command.parent ? `${path(command.parent)} ${command.name()}` : command.name();

test("every option has a short form, and no two options of a command share one", () => {
  for (const command of commands(createCli())) {
    const shorts = new Map<string, string>([["-h", "--help"]]);
    // Hidden options are for cns itself, such as the ones cns daemon runs the daemon with.
    for (const option of command.options.filter((option) => !option.hidden)) {
      assert.ok(option.short, `${path(command)} ${option.long} has no short form`);
      assert.ok(!shorts.has(option.short), `${path(command)}: ${option.short} is both ${shorts.get(option.short)} and ${option.long}`);
      shorts.set(option.short, option.long!);
    }
  }
});

test("the options that name a device, a session or a state file have the same short form everywhere", () => {
  const same: Record<string, string> = { "--device": "-D", "--session": "-s", "--state": "-S", "--json": "-j", "--secret": "-e", "--cwd": "-w", "--history": "-H", "--key": "-k" };
  for (const command of commands(createCli())) {
    for (const option of command.options.filter((option) => !option.hidden)) {
      if (option.long && same[option.long]) assert.equal(option.short, same[option.long], `${path(command)} ${option.long}`);
    }
  }
});

test("cns ui opens DEVICE or DEVICE/SESSION, named as its argument or with --device and --session", () => {
  assert.equal(uiTarget(undefined, {}), undefined);
  assert.equal(uiTarget("studio", {}), "studio");
  assert.equal(uiTarget("studio/build", {}), "studio/build");
  assert.equal(uiTarget(undefined, { device: "studio" }), "studio");
  assert.equal(uiTarget(undefined, { device: "studio", session: "build" }), "studio/build");
  assert.equal(uiTarget("studio", { session: "build" }), "studio/build");
  assert.throws(() => uiTarget("studio", { device: "studio" }), /Name the device once/);
  assert.throws(() => uiTarget(undefined, { session: "build" }), /--session needs its device/);
  assert.throws(() => uiTarget("studio/build", { session: "build" }), /Name the session once/);
});

test("peer and gateway commands take the device as their argument or with --device, once", async () => {
  const parse = (argv: string[]) => createCli().configureOutput({ writeOut: () => {}, writeErr: () => {} }).parseAsync(argv, { from: "user" });
  await assert.rejects(parse(["peer", "remove"]), /peer remove requires a paired device's name: cns peer remove NAME, or --device DEVICE/);
  await assert.rejects(parse(["peer", "remove", "-D", "studio", "laptop"]), /peer remove takes one device/);
  await assert.rejects(parse(["peer", "address", "-D", "studio"]), /peer address requires at least one address/);
  await assert.rejects(parse(["gateway", "remove", "studio", "-D", "studio"]), /gateway remove takes one device/);
  await assert.rejects(parse(["doctor", "studio", "--device", "studio"]), /Name the device once: cns doctor studio, or cns doctor --device studio/);
});
