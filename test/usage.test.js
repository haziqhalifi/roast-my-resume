import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageStore, dayKey } from "../lib/usage.js";

function store(overrides = {}) {
  let clock = new Date("2026-03-05T10:00:00Z");
  const s = new UsageStore({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rmr-")), "usage.json"),
    now: () => clock,
    ...overrides,
  });
  return { s, setNow: (iso) => (clock = new Date(iso)) };
}

test("allows one roast per device per day, then blocks with a reset time", () => {
  const { s } = store();
  const first = s.consume("device-a", "1.1.1.1", "savage");
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 0);

  const second = s.consume("device-a", "1.1.1.1", "savage");
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "device");
  assert.equal(second.resetAt, "2026-03-06T00:00:00.000Z");
});

test("a different device on the same network still gets its own roast", () => {
  const { s } = store();
  s.consume("device-a", "1.1.1.1", "savage");
  assert.equal(s.consume("device-b", "1.1.1.1", "corporate").allowed, true);
});

test("the per-IP cap stops someone just clearing local storage", () => {
  const { s } = store({ perIpPerDay: 2 });
  assert.equal(s.consume("d1", "9.9.9.9").allowed, true);
  assert.equal(s.consume("d2", "9.9.9.9").allowed, true);
  const blocked = s.consume("d3", "9.9.9.9");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "ip");
});

test("the global daily cap protects the API budget", () => {
  const { s } = store({ globalPerDay: 2, perIpPerDay: 99 });
  s.consume("d1", "1.1.1.1");
  s.consume("d2", "2.2.2.2");
  const blocked = s.consume("d3", "3.3.3.3");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "global");
});

test("limits reset the next day and yesterday moves into history", () => {
  const { s, setNow } = store();
  s.consume("device-a", "1.1.1.1", "savage");
  setNow("2026-03-06T00:05:00Z");
  assert.equal(s.consume("device-a", "1.1.1.1", "savage").allowed, true);
  const stats = s.stats();
  assert.equal(stats.today.day, "2026-03-06");
  assert.equal(stats.today.roasts, 1);
  assert.equal(stats.history[0].day, "2026-03-05");
  assert.equal(stats.history[0].roasts, 1);
  assert.equal(stats.lifetimeRoasts, 2);
});

test("refund returns the slot after a server-side failure", () => {
  const { s } = store();
  const slot = s.consume("device-a", "1.1.1.1", "savage");
  s.refund(slot.device, slot.ipHash, "savage");
  assert.equal(s.consume("device-a", "1.1.1.1", "savage").allowed, true);
  assert.equal(s.stats().today.roasts, 1);
});

test("counts survive a restart and never store raw ids", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rmr-")), "usage.json");
  const now = () => new Date("2026-03-05T10:00:00Z");
  new UsageStore({ file, now }).consume("device-a", "8.8.8.8", "savage");

  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("device-a"));
  assert.ok(!raw.includes("8.8.8.8"));

  const reopened = new UsageStore({ file, now });
  assert.equal(reopened.consume("device-a", "8.8.8.8", "savage").allowed, false);
  assert.equal(reopened.stats().today.roasts, 1);
});

test("tracks tokens and styles for cost visibility", () => {
  const { s } = store({ perDevicePerDay: 2 });
  s.consume("d1", "1.1.1.1", "savage");
  s.consume("d1", "1.1.1.1", "corporate");
  s.recordTokens({ prompt: 1200, completion: 800 });
  s.recordTokens({ prompt: 300, completion: 150 });
  const stats = s.stats();
  assert.deepEqual(stats.today.styles, { savage: 1, corporate: 1 });
  assert.deepEqual(stats.today.tokens, { prompt: 1500, completion: 950 });
  assert.equal(stats.today.uniqueDevices, 1);
});

test("dayKey is the UTC date", () => {
  assert.equal(dayKey(new Date("2026-03-05T23:59:59Z")), "2026-03-05");
});

test("view counts are separate from roasts and never blocked by rate limits", () => {
  const { s } = store({ perDevicePerDay: 1, globalPerDay: 1 });
  s.consume("d1", "1.1.1.1", "savage");
  s.incrementViews();
  s.incrementViews();
  s.incrementViews();
  const stats = s.stats();
  assert.equal(stats.lifetimeViews, 3);
  assert.equal(stats.lifetimeRoasts, 1);
});

test("views survive a restart alongside roasts", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rmr-")), "usage.json");
  const now = () => new Date("2026-03-05T10:00:00Z");
  const first = new UsageStore({ file, now });
  first.incrementViews();
  first.incrementViews();

  const reopened = new UsageStore({ file, now });
  assert.equal(reopened.stats().lifetimeViews, 2);
});

test("loading an older data file without a views field defaults to zero", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rmr-")), "usage.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ current: { day: "2026-03-05", roasts: 0, devices: {}, ips: {}, styles: {}, tokens: { prompt: 0, completion: 0 } }, history: [], lifetime: { roasts: 5 } })
  );
  const s = new UsageStore({ file, now: () => new Date("2026-03-05T10:00:00Z") });
  assert.equal(s.stats().lifetimeViews, 0);
  assert.equal(s.stats().lifetimeRoasts, 5);
  s.incrementViews();
  assert.equal(s.stats().lifetimeViews, 1);
});
