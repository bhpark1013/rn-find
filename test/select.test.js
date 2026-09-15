import { test } from "node:test";
import assert from "node:assert/strict";
import { selectElements, parseScreen, formatPlain } from "../src/select.js";
import { buildQuerySource, buildPressSource, buildTypeSource } from "../src/query.js";

const screen = { w: 400, h: 800 };
const el = (i, text, rect, pressType = "Pressable") => ({ i, text, matchedBy: "text", role: "text", hostType: "RCTText", pressType, rect });

test("drops off-screen and zero-size hits, keeps reading order, assigns index", () => {
  const out = selectElements(
    [
      el(0, "bottom", { x: 10, y: 700, w: 50, h: 20 }),
      el(1, "collapsed sheet", { x: 0, y: 900, w: 400, h: 600 }),
      el(2, "zero", { x: 0, y: 0, w: 0, h: 0 }),
      el(3, "top-right", { x: 300, y: 100, w: 50, h: 20 }),
      el(4, "top-left", { x: 10, y: 100, w: 50, h: 20 }, null),
    ],
    screen,
  );
  assert.deepEqual(out.map((e) => e.text), ["top-left", "top-right", "bottom"]);
  assert.deepEqual(out.map((e) => e.index), [0, 1, 2]);
  assert.equal(out[0].pressable, false);
  assert.equal(out[2].cx, 35);
  assert.equal(out[2].cy, 710);
  assert.equal(out[2].i, 0, "keeps the in-app hit id for press/type");
});

test("--all keeps everything, flagged with onScreen", () => {
  const out = selectElements([el(0, "a", { x: 0, y: 900, w: 10, h: 10 }), el(1, "b", null)], screen, { all: true });
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.text === "a").onScreen, false);
  assert.equal(out.find((e) => e.text === "b").w, 0);
});

test("parseScreen", () => {
  assert.deepEqual(parseScreen("390x844"), { w: 390, h: 844 });
  assert.deepEqual(parseScreen(undefined), { w: 402, h: 874 });
  assert.throws(() => parseScreen("big"));
});

test("formatPlain is one line per element", () => {
  const out = selectElements([el(0, "Go", { x: 0, y: 0, w: 20, h: 10 })], screen);
  assert.equal(formatPlain(out), '0\t10,5\ttext/press\t"Go"');
});

test("in-app sources embed the pattern safely and are valid ES5", () => {
  const src = buildQuerySource({ pattern: 'He said "hi"\\d+', flags: "i" });
  assert.ok(src.includes('"He said \\"hi\\"\\\\d+"'));
  assert.doesNotThrow(() => new Function(src));
  assert.doesNotThrow(() => new Function(buildPressSource(3)));
  assert.doesNotThrow(() => new Function(buildTypeSource(3, "한글 text")));
  assert.ok(!/\basync\b|\bawait\b/.test(src), "Hermes eval rejects async syntax");
});
