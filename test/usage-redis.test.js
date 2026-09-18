import { test } from "node:test";
import assert from "node:assert/strict";
import { RedisUsageStore, UsageLimitError, dayKey } from "../lib/usage-redis.js";

// A minimal in-memory stand-in for @upstash/redis, just the commands RedisUsageStore calls.
class FakeRedis {
  constructor() {
    this.data = new Map();
    this.calls = [];
  }
  async incr(key) {
    this.calls.push(["incr", key]);
    const v = (this.data.get(key) ?? 0) + 1;
    this.data.set(key, v);
    return v;
  }
  async decr(key) {
    const v = (this.data.get(key) ?? 0) - 1;
    this.data.set(key, v);
    return v;
  }
  async expire() {
    return 1;
  }
  async get(key) {
    return this.data.get(key) ?? null;
  }
  async sadd(key, member) {
    const s = this.data.get(key) ?? new Set();
    s.add(member);
    this.data.set(key, s);
    return 1;
  }
  async scard(key) {
    return (this.data.get(key) ?? new Set()).size;
  }
  async hincrby(key, field, by) {
    const h = this.data.get(key) ?? {};
    h[field] = (h[field] ?? 0) + by;
    this.data.set(key, h);
    return h[field];
  }
  async hgetall(key) {
    return this.data.get(key) ?? {};
  }
}

function store(overrides = {}) {
  let clock = new Date("2026-03-05T10:00:00Z");
  const redis = new FakeRedis();
  const s = new RedisUsageStore({ redis, env: "test", now: () => clock, ...overrides });
  return { s, redis, setNow: (iso) => (clock = new Date(iso)) };
}

test("allows one roast per device per day, then blocks with a reset time", async () => {
  const { s } = store();
  const first = await s.consume("device-a", "1.1.1.1", "savage");
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 0);

  const second = await s.consume("device-a", "1.1.1.1", "savage");
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "device");
  assert.equal(second.resetAt, "2026-03-06T00:00:00.000Z");
});

test("a different device on the same network still gets its own roast", async () => {
  const { s } = store();
  await s.consume("device-a", "1.1.1.1", "savage");
  assert.equal((await s.consume("device-b", "1.1.1.1", "corporate")).allowed, true);
});

test("the per-IP cap stops someone just clearing local storage", async () => {
  const { s } = store({ perIpPerDay: 2 });
  assert.equal((await s.consume("d1", "9.9.9.9")).allowed, true);
  assert.equal((await s.consume("d2", "9.9.9.9")).allowed, true);
  const blocked = await s.consume("d3", "9.9.9.9");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "ip");
});

test("the global daily cap protects the API budget, and rolls back the device/ip counters", async () => {
  const { s, redis } = store({ globalPerDay: 2, perIpPerDay: 99 });
  await s.consume("d1", "1.1.1.1");
  await s.consume("d2", "2.2.2.2");
  const blocked = await s.consume("d3", "3.3.3.3");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "global");
  // Rolled back, so device d3 isn't burned for a day it never got to use.
  assert.equal(await redis.get(s.deviceKey("2026-03-05", s.hash("d3"))), 0);
});

test("limits reset the next UTC day", async () => {
  const { s, setNow } = store();
  await s.consume("device-a", "1.1.1.1", "savage");
  setNow("2026-03-06T00:05:00Z");
  assert.equal((await s.consume("device-a", "1.1.1.1", "savage")).allowed, true);
});

test("refund returns the slot after a server-side failure", async () => {
  const { s } = store();
  const slot = await s.consume("device-a", "1.1.1.1", "savage");
  await s.refund(slot.device, slot.ipHash, "savage", slot.day);
  assert.equal((await s.consume("device-a", "1.1.1.1", "savage")).allowed, true);
});

test("never sends raw device ids or ips to redis", async () => {
  const { s, redis } = store();
  await s.consume("super-secret-device", "203.0.113.7", "savage");
  const allKeys = [...redis.data.keys()].join(" ");
  assert.ok(!allKeys.includes("super-secret-device"));
  assert.ok(!allKeys.includes("203.0.113.7"));
});

test("different VERCEL_ENV values (prod/preview/local) don't share counters", async () => {
  let clock = new Date("2026-03-05T10:00:00Z");
  const redis = new FakeRedis();
  const prod = new RedisUsageStore({ redis, env: "production", now: () => clock });
  const preview = new RedisUsageStore({ redis, env: "preview", now: () => clock });

  await prod.consume("device-a", "1.1.1.1", "savage");
  // Same device id, but a different environment's counter — must not be blocked by prod's usage.
  assert.equal((await preview.consume("device-a", "1.1.1.1", "savage")).allowed, true);
});

test("tracks tokens and styles for cost visibility", async () => {
  const { s } = store({ perDevicePerDay: 2 });
  await s.consume("d1", "1.1.1.1", "savage");
  await s.consume("d1", "1.1.1.1", "corporate");
  await s.recordTokens({ prompt: 1200, completion: 800 });
  await s.recordTokens({ prompt: 300, completion: 150 });
  const stats = await s.stats();
  assert.deepEqual(stats.today.styles, { savage: 1, corporate: 1 });
  assert.deepEqual(stats.today.tokens, { prompt: 1500, completion: 950 });
  assert.equal(stats.today.uniqueDevices, 1);
  assert.equal(stats.lifetimeRoasts, 2);
});

test("a redis failure fails closed with a UsageLimitError", async () => {
  const redis = new FakeRedis();
  redis.incr = async () => {
    throw new Error("connection refused");
  };
  const s = new RedisUsageStore({ redis, env: "test", now: () => new Date("2026-03-05T10:00:00Z") });
  await assert.rejects(() => s.consume("device-a", "1.1.1.1", "savage"), UsageLimitError);
});

test("dayKey is the UTC date", () => {
  assert.equal(dayKey(new Date("2026-03-05T23:59:59Z")), "2026-03-05");
});

test("view counts are separate from roasts and never blocked by rate limits", async () => {
  const { s } = store({ perDevicePerDay: 1, globalPerDay: 1 });
  await s.consume("d1", "1.1.1.1", "savage");
  await s.incrementViews();
  await s.incrementViews();
  await s.incrementViews();
  const stats = await s.stats();
  assert.equal(stats.lifetimeViews, 3);
  assert.equal(stats.lifetimeRoasts, 1);
});

test("lifetime roasts and views are namespaced by env, same as the daily counters", async () => {
  const redis = new FakeRedis();
  const prod = new RedisUsageStore({ redis, env: "production", now: () => new Date("2026-03-05T10:00:00Z") });
  const local = new RedisUsageStore({ redis, env: "local", now: () => new Date("2026-03-05T10:00:00Z") });

  await prod.consume("device-a", "1.1.1.1", "savage");
  await prod.incrementViews();
  await local.consume("device-b", "2.2.2.2", "savage");
  await local.incrementViews();
  await local.incrementViews();

  assert.equal((await prod.stats()).lifetimeRoasts, 1);
  assert.equal((await prod.stats()).lifetimeViews, 1);
  assert.equal((await local.stats()).lifetimeRoasts, 1);
  assert.equal((await local.stats()).lifetimeViews, 2);
});

test("a view-tracking failure never throws", async () => {
  const redis = new FakeRedis();
  redis.incr = async () => {
    throw new Error("connection refused");
  };
  const s = new RedisUsageStore({ redis, env: "test", now: () => new Date("2026-03-05T10:00:00Z") });
  await assert.doesNotReject(() => s.incrementViews());
});
