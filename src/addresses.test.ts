import { expect, test } from "bun:test";
import { allPrivate, isPrivateAddress } from "./addresses.js";

test("private ranges are private, public and overlay addresses are not", () => {
  for (const host of ["10.0.0.1", "172.16.0.1", "172.20.61.227", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.1.1", "::1", "[::1]", "fe80::1", "fe80::1%en0", "fd12::1", "fc00::1"]) expect(isPrivateAddress(host)).toBe(true);
  for (const host of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.64.0.1", "192.169.0.1", "2001:db8::1", "example.com", "relay.example.com"]) expect(isPrivateAddress(host)).toBe(false);
});

test("allPrivate: only when every address is private; a hostname or relay makes the list reachable", () => {
  expect(allPrivate(["ws://172.20.61.227:47381"])).toBe(true);
  expect(allPrivate(["ws://10.0.0.5:1", "ws://[fd00::1]:1"])).toBe(true);
  expect(allPrivate([])).toBe(true);
  expect(allPrivate(["ws://172.20.61.227:47381", "wss://relay.example.com/dial/abc"])).toBe(false);
  expect(allPrivate(["ws://203.0.113.9:47381"])).toBe(false);
  expect(allPrivate(["not a url"])).toBe(false);
});
