import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_STOP,
  COLORS,
  buildActionPacket,
  buildColorPacket,
  buildMovePacket,
  buildStopPacket,
  fromHex,
  isValidAction,
  isValidColor,
  toHex,
} from "../index.js";

test("buildActionPacket arm 100 with default color matches protocol example", () => {
  const packet = buildActionPacket({ action: 100 });
  const expected = new Uint8Array([
    0xaa, 0xaa, 0xcc, // header
    0x32, 0x01,       // cmd action + count
    0x64, 0x64,       // action, action (100 = 0x64)
    0x08,             // speed_byte
    0x00,             // speed_level
    0x02,             // color (blue)
    0x00,             // color_mode (on)
    0x02, 0x02,       // fixed
    0x01, 0x01,       // separator
    0x55, 0x55,       // footer
  ]);
  assert.deepEqual(packet, expected);
  assert.equal(toHex(packet), "AAAACC3201646408000200020201015555");
});

test("buildStopPacket produces AA AA CC 0C 55 55", () => {
  const packet = buildStopPacket();
  assert.deepEqual(
    packet,
    new Uint8Array([0xaa, 0xaa, 0xcc, 0x0c, 0x55, 0x55]),
  );
  assert.equal(toHex(packet), "AAAACC0C5555");
});

test("buildMovePacket('up') uses action 2 and speedByte 0xFF", () => {
  const packet = buildMovePacket("up");
  // action byte index = 5 and 6 (0-indexed)
  assert.equal(packet[5], 2);
  assert.equal(packet[6], 2);
  // speedByte index = 7
  assert.equal(packet[7], 0xff);
  // default blue color
  assert.equal(packet[9], COLORS.BLUE);
  assert.equal(
    toHex(packet),
    "AAAACC32010202FF000200020201015555",
  );
});

test("buildMovePacket directions cover down/up/left/right", () => {
  assert.equal(buildMovePacket("down")[5], 1);
  assert.equal(buildMovePacket("up")[5], 2);
  assert.equal(buildMovePacket("left")[5], 3);
  assert.equal(buildMovePacket("right")[5], 4);
});

test("buildColorPacket(5) emits action 77 with red", () => {
  const packet = buildColorPacket(5);
  // action byte 77 = 0x4D
  assert.equal(packet[5], ACTION_STOP);
  assert.equal(packet[6], ACTION_STOP);
  // color at index 9
  assert.equal(packet[9], COLORS.RED);
  assert.equal(
    toHex(packet),
    "AAAACC32014D4D08000500020201015555",
  );
});

test("buildActionPacket with custom color and color_mode off", () => {
  const packet = buildActionPacket({
    action: 200,
    color: COLORS.WHITE,
    colorMode: 4,
  });
  assert.equal(packet[5], 200);
  assert.equal(packet[9], 7);
  assert.equal(packet[10], 4);
});

test("isValidAction accepts ranges 1-93, 100-110, 200-235, and 77", () => {
  for (const n of [1, 50, 77, 93, 100, 105, 110, 200, 235]) {
    assert.ok(isValidAction(n), `expected ${n} to be valid`);
  }
  for (const n of [0, 94, 99, 111, 199, 236, -1, 1.5, NaN]) {
    assert.ok(!isValidAction(n), `expected ${n} to be invalid`);
  }
});

test("isValidColor accepts 1-7 only", () => {
  for (let c = 1; c <= 7; c++) assert.ok(isValidColor(c));
  for (const c of [0, 8, -1, 1.5, NaN]) assert.ok(!isValidColor(c));
});

test("buildActionPacket throws on invalid action", () => {
  assert.throws(() => buildActionPacket({ action: 999 }), /Invalid action/);
  assert.throws(() => buildActionPacket({ action: 0 }), /Invalid action/);
});

test("buildActionPacket throws on invalid color", () => {
  assert.throws(
    () => buildActionPacket({ action: 100, color: 9 }),
    /Invalid color/,
  );
});

test("buildColorPacket throws on invalid color", () => {
  assert.throws(() => buildColorPacket(0), /Invalid color/);
  assert.throws(() => buildColorPacket(8), /Invalid color/);
});

test("toHex / fromHex round-trip", () => {
  const original = new Uint8Array([
    0xaa, 0xaa, 0xcc, 0x32, 0x01, 0x64, 0x64, 0x08, 0x00, 0x02, 0x00, 0x02,
    0x02, 0x01, 0x01, 0x55, 0x55,
  ]);
  const hex = toHex(original);
  assert.equal(hex, "AAAACC3201646408000200020201015555");
  assert.deepEqual(fromHex(hex), original);
});

test("fromHex accepts whitespace and mixed case", () => {
  const a = fromHex("aa aa cc");
  const b = fromHex("AAAACC");
  const c = fromHex("aA Aa cC");
  assert.deepEqual(a, new Uint8Array([0xaa, 0xaa, 0xcc]));
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test("fromHex rejects odd length and non-hex chars", () => {
  assert.throws(() => fromHex("ABC"), /even length/);
  assert.throws(() => fromHex("ZZ"), /non-hex/);
});
