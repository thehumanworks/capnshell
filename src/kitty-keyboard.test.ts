import assert from "node:assert/strict";
import test from "node:test";
import { findControlKey, KeyboardMode, KeyboardModes, keyboardReply, TerminalKeyboard, withoutKeyboardReplies } from "./kitty-keyboard.js";

const CSI = "\x1b[";
/** Every `CSI prefix params u` in `text`, applied to a terminal's mode. */
function send(mode: KeyboardMode, text: string) {
  for (const match of text.matchAll(/\x1b\[([<=>])([0-9;]*)u/g)) mode.apply(match[1]!, match[2]!.split(";").filter(Boolean).map(Number));
}

test("a keyboard mode is set, pushed and popped as the kitty protocol says", () => {
  const mode = new KeyboardMode();
  mode.apply("=", [5]);
  assert.equal(mode.flags, 5);
  mode.apply("=", [2, 2]);
  assert.equal(mode.flags, 7, "mode 2 adds flags");
  mode.apply("=", [4, 3]);
  assert.equal(mode.flags, 3, "mode 3 removes flags");
  mode.apply("=", [255]);
  assert.equal(mode.flags, 31, "only the protocol's five flags exist");
  mode.apply(">", [1]);
  mode.apply(">", []);
  assert.deepEqual([mode.flags, mode.depth], [0, 2], "a push without flags sets none");
  mode.apply("<", []);
  assert.deepEqual([mode.flags, mode.depth], [1, 1]);
  mode.apply("<", [5]);
  assert.deepEqual([mode.flags, mode.depth], [0, 0], "a pop that empties the stack resets the flags");
  // A full stack loses its oldest entry.
  for (let flags = 1; flags <= 20; flags++) mode.push(flags);
  assert.equal(mode.depth, 16);
  mode.pop(16);
  assert.equal(mode.flags, 4);
});

test("a keyboard mode's replay gives another terminal the same flags and the same stack", () => {
  assert.equal(new KeyboardMode().replay(), "");
  for (const requests of [`${CSI}=5u`, `${CSI}>1u`, `${CSI}=3u${CSI}>1u${CSI}>15u`, `${CSI}>7u${CSI}>u`]) {
    const program = new KeyboardMode();
    send(program, requests);
    const terminal = new KeyboardMode();
    send(terminal, program.replay());
    for (let pops = 0; pops <= 4; pops++) {
      assert.deepEqual([terminal.flags, terminal.depth], [program.flags, program.depth], `${JSON.stringify(requests)} after ${pops} pops`);
      program.pop();
      terminal.pop();
    }
  }
});

// What changed: cns looked for the detach key as one byte. A program that asks its terminal
// for the kitty protocol, or for modifyOtherKeys as Vim does, gets the key as an escape
// sequence, and then nothing detached until the program ended.
const CTRL_RIGHT_BRACKET = 0x1d;
const DETACHES: Record<string, string> = {
  "the byte, as a terminal sends it by default": "\x1d",
  "a kitty key event": `${CSI}93;5u`,
  "a kitty key event that says it is a press": `${CSI}93;5:1u`,
  "a kitty key event that says it is a repeat": `${CSI}93;5:2u`,
  "a kitty key event with Caps Lock on": `${CSI}93;69u`,
  "a kitty key event with Num Lock on": `${CSI}93;133u`,
  "a kitty key event with both locks on": `${CSI}93;197u`,
  "a kitty key event with the key's place on a US keyboard": `${CSI}93::93;5u`,
  "a kitty key event from a layout that has another key where ] is": `${CSI}43::93;5u`,
  "a kitty key event with the text of the key": `${CSI}93;5;29u`,
  "a kitty key event with alternates, an event type and text": `${CSI}93::93;69:1;29u`,
  "Ctrl-5, which has always sent the same byte": `${CSI}53;5u`,
  "Ctrl-Shift with a shifted key that sends the byte": `${CSI}57:93;6u`,
  "modifyOtherKeys": `${CSI}27;5;93~`,
  "modifyOtherKeys with Num Lock on": `${CSI}27;133;93~`,
};
for (const [name, key] of Object.entries(DETACHES)) {
  test(`the detach key is found when it arrives as ${name}`, () => {
    assert.equal(findControlKey(Buffer.from(key, "latin1"), CTRL_RIGHT_BRACKET), 0);
    // Among other keys, it is found where it starts.
    assert.equal(findControlKey(Buffer.from(`ab${CSI}97;5u${key}cd`, "latin1"), CTRL_RIGHT_BRACKET), 2 + `${CSI}97;5u`.length);
  });
}

const OTHER_KEYS: Record<string, string> = {
  "the key without Ctrl": `${CSI}93u`,
  "the release of the key": `${CSI}93;5:3u`,
  "the key with Alt as well": `${CSI}93;7u`,
  "the key with Super as well": `${CSI}93;13u`,
  "Ctrl-Shift-] without a shifted key that sends the byte": `${CSI}93:125;6u`,
  "another key with Ctrl": `${CSI}97;5u`,
  "Ctrl itself going down": `${CSI}57442;5u`,
  "an arrow key with Ctrl": `${CSI}1;5C`,
  "a function key": `${CSI}15;5~`,
  "modifyOtherKeys for another key": `${CSI}27;5;91~`,
  "modifyOtherKeys with Alt as well": `${CSI}27;7;93~`,
  "a cursor restore": `${CSI}u`,
  "typed text": "echo 93;5u",
};
for (const [name, key] of Object.entries(OTHER_KEYS)) {
  test(`the detach key is not ${name}`, () => {
    assert.equal(findControlKey(Buffer.from(key, "latin1"), CTRL_RIGHT_BRACKET), -1);
  });
}

test("a control key is found in whichever form comes first, and for other keys than Ctrl-]", () => {
  assert.equal(findControlKey(Buffer.from(`ab\x1d${CSI}93;5u`, "latin1"), 0x1d), 2);
  assert.equal(findControlKey(Buffer.from(`${CSI}93;5:3uab\x1d`, "latin1"), 0x1d), `${CSI}93;5:3u`.length + 2);
  // Ctrl-C and Ctrl-B, as cns looks for them while reconnecting and with --key C-b.
  assert.equal(findControlKey(Buffer.from(`${CSI}99;5u`, "latin1"), 0x03), 0);
  assert.equal(findControlKey(Buffer.from(`x${CSI}98;5u`, "latin1"), 0x02), 1);
  assert.equal(findControlKey(Buffer.from(`${CSI}27;5;99~`, "latin1"), 0x03), 0);
  assert.equal(findControlKey(Buffer.from(`${CSI}99;5u`, "latin1"), 0x02), -1);
  // Ctrl-@ and Ctrl-Space send a null byte.
  assert.equal(findControlKey(Buffer.from(`${CSI}32;5u`, "latin1"), 0x00), 0);
  assert.equal(findControlKey(Buffer.from(`${CSI}50:64;6u`, "latin1"), 0x00), 0);
});

test("a terminal's replies say whether it speaks the kitty protocol once its device attributes arrive", () => {
  assert.equal(keyboardReply(""), undefined);
  assert.equal(keyboardReply(`${CSI}?0u`), undefined, "the attributes come last, so the answer is not complete");
  assert.equal(keyboardReply(`${CSI}?0u${CSI}?62;22c`), true);
  assert.equal(keyboardReply(`${CSI}?31u${CSI}?1;2c`), true);
  assert.equal(keyboardReply(`${CSI}?62;22c`), false);
  assert.equal(keyboardReply(`ls${CSI}?1;2c`), false);
  assert.equal(withoutKeyboardReplies(`l${CSI}?0us${CSI}?62;22c\r`), "ls\r");
  assert.equal(withoutKeyboardReplies(`${CSI}?62;22c`), "");
});

/**
 * A terminal as cns's requests reach it. A kitty-style terminal keeps a mode for each of its
 * screens; `shared` is a terminal that keeps one for both.
 */
function terminal(shared = false) {
  const modes = new KeyboardModes();
  let alternate = false;
  const mode = () => alternate && !shared ? modes.alternate : modes.main;
  return {
    receive(text: string) { send(mode(), text); },
    switch(to: boolean) { alternate = to; },
    get flags() { return mode().flags; },
    get depth() { return modes.main.depth + (shared ? 0 : modes.alternate.depth); },
  };
}

for (const shared of [false, true]) {
  test(`a terminal with ${shared ? "one keyboard mode for both screens" : "a keyboard mode for each screen"} reports keys as the program asked, and gets its own mode back`, () => {
    const local = terminal(shared);
    // The terminal's own mode, from before cns: a shell that asked for one.
    local.receive(`${CSI}>3u`);
    const keys = new TerminalKeyboard();
    const program = (prefix: string, ...params: number[]) => local.receive(keys.request(prefix, params));
    const enter = () => { local.switch(true); local.receive(keys.enter()); };
    const exit = () => { local.receive(keys.exit()); local.switch(false); };

    // A program that asks for nothing changes nothing.
    assert.equal(keys.request("<", []), "");
    assert.equal(keys.request("=", [0]), "");
    assert.deepEqual([local.flags, local.depth], [3, 1]);

    // A shell that sets flags at its prompt.
    program(">", 1);
    assert.equal(local.flags, 1);
    // An editor on the alternate screen pushes its own and pops them as it leaves.
    enter();
    assert.equal(local.flags, 0, "the alternate screen starts with no flags, whatever the normal screen has");
    program(">", 15);
    assert.equal(local.flags, 15);
    program(">", 5);
    program("<");
    assert.equal(local.flags, 15);
    program("<");
    assert.equal(local.flags, 0);
    exit();
    assert.equal(local.flags, 1, "back on the normal screen, its flags are in force again");
    program("=", 9);
    assert.equal(local.flags, 9);
    // However deep the program's stack, the terminal's is one entry deeper than before cns.
    for (let flags = 1; flags < 12; flags++) program(">", flags);
    assert.deepEqual([local.flags, local.depth], [11, 2]);

    // cns leaves from the alternate screen: the terminal has its own mode again.
    enter();
    program("=", 31);
    assert.equal(local.flags, 31);
    exit();
    local.receive(keys.end());
    assert.deepEqual([local.flags, local.depth], [3, 1]);
    assert.equal(keys.exit() + keys.end(), "", "leaving twice sends nothing more");
  });
}

test("a program's full reset leaves nothing for cns to take back from the terminal", () => {
  const keys = new TerminalKeyboard();
  assert.equal(keys.request(">", [5]), `${CSI}>5u`);
  assert.equal(keys.enter(), `${CSI}>0u`);
  keys.reset();
  assert.equal(keys.exit() + keys.end(), "");
  // The program starts again from nothing.
  assert.equal(keys.request("=", [1]), `${CSI}>1u`);
  assert.equal(keys.end(), `${CSI}<u`);
});
