import assert from "node:assert/strict";
import test from "node:test";
import { encodeKeys } from "./keys.js";

test("key names encode as a terminal sends them; other arguments are literal text", () => {
  assert.equal(encodeKeys(["ls -la", "Enter"]), "ls -la\r");
  assert.equal(encodeKeys(["Tab", "BTab", "S-Tab", "Escape", "Esc", "Space", "BSpace"]), "\t\x1b[Z\x1b[Z\x1b\x1b \x7f");
  assert.equal(encodeKeys(["C-c", "C-d", "C-Space", "C-[", "C-]", "C-?", "c-a"]), "\x03\x04\0\x1b\x1d\x7f\x01");
  assert.equal(encodeKeys(["M-x", "M-C-a", "M-Enter", "S-a"]), "\x1bx\x1b\x01\x1b\rA");
  // Names are case-insensitive, as in tmux.
  assert.equal(encodeKeys(["enter", "ENTER", "up"]), "\r\r\x1b[A");
  assert.equal(encodeKeys(["PageUp", "PPage", "NPage", "Delete", "DC", "Insert", "F1", "F5", "F12"]),
    "\x1b[5~\x1b[5~\x1b[6~\x1b[3~\x1b[3~\x1b[2~\x1bOP\x1b[15~\x1b[24~");
  // Not key names: words, unknown modifier targets and bare prefixes.
  assert.equal(encodeKeys(["Enterprise", "C-3PO", "C-", "M-", "x", "漢"]), "EnterpriseC-3POC-M-x漢");
});

test("cursor keys follow the program's cursor-key mode and take modifiers", () => {
  assert.equal(encodeKeys(["Up", "Down", "Right", "Left", "Home", "End"]), "\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F");
  assert.equal(encodeKeys(["Up", "Left", "Home"], { applicationCursor: true }), "\x1bOA\x1bOD\x1bOH");
  assert.equal(encodeKeys(["C-Left", "S-Up", "M-Right", "C-S-End"], { applicationCursor: true }),
    "\x1b[1;5D\x1b[1;2A\x1b[1;3C\x1b[1;6F");
  assert.equal(encodeKeys(["C-PageUp", "S-F1", "C-F5"]), "\x1b[5;5~\x1b[1;2P\x1b[15;5~");
});

test("literal mode sends every argument as text", () => {
  assert.equal(encodeKeys(["Enter", "C-c", " "], { literal: true }), "EnterC-c ");
});
