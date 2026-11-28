import assert from "node:assert/strict";
import dgram from "node:dgram";
import type os from "node:os";
import test from "node:test";
import { broadcastAddress, holds, lanCards, LIMITED_BROADCAST, macAddress, magicPacket, networkName, sendMagicPacket, WAKE_PORT, wakeable, wakeHere, wakeTargets, type SendPacket } from "./wake.js";

const MAC = "3c:22:fb:12:34:56";

test("the magic packet is six bytes of 0xFF, then the card's MAC address sixteen times", () => {
  const packet = magicPacket(MAC);
  assert.equal(packet.length, 6 + 16 * 6);
  assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  for (let at = 6; at < packet.length; at += 6) assert.deepEqual([...packet.subarray(at, at + 6)], [0x3c, 0x22, 0xfb, 0x12, 0x34, 0x56]);
  // Only a MAC address as cns writes it makes a packet.
  for (const bad of ["3C:22:FB:12:34:56", "3c-22-fb-12-34-56", "3c:22:fb:12:34", "3c:22:fb:12:34:56:78", ""]) assert.throws(() => magicPacket(bad), /not a MAC address/);
});

test("a MAC address is read with colons or hyphens in either case, and nothing else is one", () => {
  assert.equal(macAddress("3C-22-FB-12-34-56"), MAC);
  assert.equal(macAddress(" 3c:22:fb:12:34:56\n"), MAC);
  for (const bad of ["3c:22:fb:12:34", "3c:22:fb:12:34:5g", "3c22fb123456", "3c:22:fb:12:34:56; rm -rf ~", "3c:22:fb:12:34:56\n3c", "$(id)", "3c:22:fb:12:34:56 --address 1.2.3.4"]) {
    assert.equal(macAddress(bad), undefined, bad);
  }
});

test("a card's network says where its broadcasts go and which addresses it holds", () => {
  assert.equal(broadcastAddress("192.168.1.23/24"), "192.168.1.255");
  assert.equal(broadcastAddress("10.1.2.3/8"), "10.255.255.255");
  assert.equal(broadcastAddress("172.20.5.9/20"), "172.20.15.255");
  assert.equal(broadcastAddress("192.168.1.5/30"), "192.168.1.7");
  assert.equal(networkName("192.168.1.23/24"), "192.168.1.0/24");
  assert.equal(networkName("172.20.5.9/20"), "172.20.0.0/20");
  assert.ok(holds("192.168.1.23/24", "192.168.1.200"));
  assert.ok(holds("10.1.2.3/8", "10.200.0.1"));
  assert.ok(holds("192.168.200.1/16", "192.168.1.5"));
  assert.ok(!holds("192.168.1.23/24", "192.168.2.23"));
  assert.ok(!holds("172.20.5.9/20", "172.20.16.1"));
});

const entry = (address: string, netmask: string, cidr: string | null, mac: string, rest: Partial<os.NetworkInterfaceInfo> = {}) =>
  ({ address, netmask, cidr, mac, family: "IPv4", internal: false, ...rest }) as os.NetworkInterfaceInfo;

test("a device tells its paired devices its IPv4 cards on local networks, and no loopback, tunnel or one-address network", () => {
  const cards = lanCards({
    lo: [entry("127.0.0.1", "255.0.0.0", "127.0.0.1/8", "00:00:00:00:00:00", { internal: true })],
    eth0: [
      entry("192.168.1.23", "255.255.255.0", "192.168.1.23/24", "3C:22:FB:12:34:56"),
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", cidr: "fe80::1/64", mac: "3c:22:fb:12:34:56", family: "IPv6", internal: false, scopeid: 2 },
      // The same card twice, as some systems list it.
      entry("192.168.1.23", "255.255.255.0", "192.168.1.23/24", "3c:22:fb:12:34:56"),
    ],
    wlan0: [entry("192.168.1.24", "255.255.255.0", "192.168.1.24/24", "a6:0b:11:22:33:44")],
    docker0: [entry("172.17.0.1", "255.255.0.0", "172.17.0.1/16", "02:42:ac:11:00:01")],
    tailscale0: [entry("100.101.1.2", "255.255.255.255", "100.101.1.2/32", "00:00:00:00:00:00")],
    wg0: [entry("10.8.0.2", "255.255.255.0", "10.8.0.2/24", "00:00:00:00:00:00")],
    p2p: [entry("10.9.0.0", "255.255.255.254", "10.9.0.0/31", "3c:22:fb:00:00:01")],
    odd: [entry("10.10.0.1", "255.255.255.0", null, "3c:22:fb:00:00:02")],
  });
  assert.deepEqual(cards, [
    { mac: MAC, cidr: "192.168.1.23/24" },
    { mac: "a6:0b:11:22:33:44", cidr: "192.168.1.24/24" },
    { mac: "02:42:ac:11:00:01", cidr: "172.17.0.1/16" },
  ]);
  // All of them say which networks the device is on; only a card a maker gave its address wakes a machine.
  assert.deepEqual(cards.filter(wakeable), [{ mac: MAC, cidr: "192.168.1.23/24" }]);
  assert.ok(!wakeable({ mac: "00:15:5d:01:02:03", cidr: "172.23.80.5/20" }), "Hyper-V's, as WSL's own card is");
  assert.ok(!wakeable({ mac: "01:00:5e:00:00:01", cidr: "192.168.1.9/24" }), "a group address");
  assert.ok(wakeable({ mac: "b8:27:eb:01:02:03", cidr: "192.168.1.9/24" }));
});

test("a packet goes to the broadcast address of the network that holds the card, then to 255.255.255.255", () => {
  const here = [{ mac: "a6:0b:11:22:33:44", cidr: "192.168.1.24/24" }, { mac: "02:42:ac:11:00:01", cidr: "172.17.0.1/16" }, { mac: MAC, cidr: "192.168.1.25/24" }];
  assert.equal(LIMITED_BROADCAST, "255.255.255.255");
  assert.deepEqual(wakeTargets(here, "192.168.1.23"), ["192.168.1.255", "255.255.255.255"]);
  assert.deepEqual(wakeTargets(here), ["192.168.1.255", "172.17.255.255", "255.255.255.255"]);
  assert.deepEqual(wakeTargets(here, "10.0.0.5"), ["255.255.255.255"]);
});

test("the packet goes out in UDP datagrams to port 9, a few times over", async (t) => {
  assert.equal(WAKE_PORT, 9);
  // A listener on loopback stands in for the network: the same socket calls, at another port.
  const listener = dgram.createSocket("udp4");
  t.after(() => listener.close());
  const received: Buffer[] = [];
  listener.on("message", (message) => received.push(message));
  await new Promise<void>((resolve) => listener.bind(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  const result = await sendMagicPacket(MAC, ["127.0.0.1"], { port, rounds: 3, gapMs: 10 });
  assert.deepEqual(result, { sent: ["127.0.0.1"], failed: [] });
  const until = Date.now() + 5000;
  while (received.length < 3 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 3);
  for (const message of received) assert.deepEqual(message, magicPacket(MAC));
});

test("this device sends only to a network that holds the card, and says what to check when nothing goes out", async () => {
  const here = [{ mac: "a6:0b:11:22:33:44", cidr: "192.168.1.24/24" }];
  const sent: string[][] = [];
  const send: SendPacket = async (mac, to) => { sent.push([mac, ...to]); return { sent: [...to], failed: [] }; };
  assert.deepEqual(await wakeHere(MAC, "192.168.1.23", here, send), ["192.168.1.255", "255.255.255.255"]);
  assert.deepEqual(sent, [[MAC, "192.168.1.255", "255.255.255.255"]]);
  await assert.rejects(wakeHere(MAC, "10.0.0.5", here, send), /^Error: No network of this device holds 10\.0\.0\.5, so a packet from here would not reach 3c:22:fb:12:34:56: a broadcast does not cross a router\. Send it from a device on that network\.$/);
  assert.equal(sent.length, 1, "nothing was sent for it");
  const refused: SendPacket = async (_mac, to) => ({ sent: [], failed: to.map((address) => ({ to: address, error: "send EHOSTUNREACH" })) });
  await assert.rejects(wakeHere(MAC, "192.168.1.23", here, refused), /Could not send the magic packet for 3c:22:fb:12:34:56 \(192\.168\.1\.255: send EHOSTUNREACH; 255\.255\.255\.255: send EHOSTUNREACH\)\. Check that this device is on that network; on macOS/);
});
