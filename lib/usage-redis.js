import crypto from "node:crypto";

export const dayKey = (date) => date.toISOString().slice(0, 10);

function secondsUntilNextUtcMidnight(now) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.ceil((next.getTime() - now.getTime()) / 1000);
}

export class UsageLimitError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

// Redis-backed usage counter, safe across Vercel's stateless serverless functions
// (unlike the file-based UsageStore, whose /tmp counts don't survive cold starts
// or spread across concurrent instances). Counters are hashed, never raw ids;
// resume text never touches this store.
export class RedisUsageStore {
  constructor({
    redis,
    perDevicePerDay = 1,
    perIpPerDay = 5,
    globalPerDay = 200,
    historyDays = 14,
    salt = "roast-my-resume",
    // Keeps local/preview testing from polluting production counts on a shared Redis instance.
    env = process.env.VERCEL_ENV || "local",
    now = () => new Date(),
  }) {
    this.redis = redis;
    this.limits = { perDevicePerDay, perIpPerDay, globalPerDay };
    this.historyDays = historyDays;
    this.salt = salt;
    this.env = env;
    this.now = now;
  }

  hash(value) {
    return crypto.createHash("sha256").update(`${this.salt}:${value}`).digest("hex").slice(0, 16);
  }

  resetAt() {
    const next = new Date(this.now());
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
  }

  prefix(day) {
    return `usage:${this.env}:${day}`;
  }

  keys(day) {
    const p = this.prefix(day);
    return { roasts: `${p}:roasts`, styles: `${p}:styles`, tokens: `${p}:tokens`, devicesSet: `${p}:devices`, ipsSet: `${p}:ips` };
  }

  // Namespaced like everything else, so local/preview testing never inflates the public counters.
  lifetimeRoastsKey() {
    return `usage:${this.env}:lifetime:roasts`;
  }

  lifetimeViewsKey() {
    return `usage:${this.env}:lifetime:views`;
  }

  deviceKey(day, deviceHash) {
    return `${this.prefix(day)}:d:${deviceHash}`;
  }

  ipKey(day, ipHash) {
    return `${this.prefix(day)}:ip:${ipHash}`;
  }

  async consume(deviceId, ip, style) {
    const now = this.now();
    const day = dayKey(now);
    const device = this.hash(deviceId || "unknown");
    const ipHash = this.hash(ip || "unknown");
    const resetAt = this.resetAt();
    const ttlShort = secondsUntilNextUtcMidnight(now) + 60;
    const ttlLong = this.historyDays * 86400;
    const dKey = this.deviceKey(day, device);
    const iKey = this.ipKey(day, ipHash);
    const k = this.keys(day);

    let deviceCount, ipCount, globalCount;
    try {
      // Increment-then-rollback per tier: each INCR is atomic, so this stays correct
      // under concurrent requests even though the three checks aren't one transaction.
      deviceCount = await this.redis.incr(dKey);
      if (deviceCount === 1) await this.redis.expire(dKey, ttlShort);
      if (deviceCount > this.limits.perDevicePerDay) {
        await this.redis.decr(dKey);
        return { allowed: false, reason: "device", remaining: 0, resetAt, day };
      }

      ipCount = await this.redis.incr(iKey);
      if (ipCount === 1) await this.redis.expire(iKey, ttlShort);
      if (ipCount > this.limits.perIpPerDay) {
        await Promise.all([this.redis.decr(dKey), this.redis.decr(iKey)]);
        return { allowed: false, reason: "ip", remaining: 0, resetAt, day };
      }

      globalCount = await this.redis.incr(k.roasts);
      if (globalCount > this.limits.globalPerDay) {
        await Promise.all([this.redis.decr(dKey), this.redis.decr(iKey), this.redis.decr(k.roasts)]);
        return { allowed: false, reason: "global", remaining: 0, resetAt, day };
      }

      await Promise.all([
        this.redis.expire(k.roasts, ttlLong),
        this.redis.sadd(k.devicesSet, device),
        this.redis.expire(k.devicesSet, ttlLong),
        this.redis.sadd(k.ipsSet, ipHash),
        this.redis.expire(k.ipsSet, ttlLong),
        this.redis.incr(this.lifetimeRoastsKey()),
        ...(style ? [this.redis.hincrby(k.styles, style, 1), this.redis.expire(k.styles, ttlLong)] : []),
      ]);
    } catch (err) {
      // Fail closed: protecting the API budget matters more than availability here.
      throw new UsageLimitError(`Usage tracking is unavailable (${err.message}). Try again shortly.`);
    }

    return { allowed: true, remaining: this.limits.perDevicePerDay - deviceCount, resetAt, day, device, ipHash };
  }

  async refund(device, ipHash, style, day) {
    const d = day || dayKey(this.now());
    const k = this.keys(d);
    try {
      await Promise.all([
        this.redis.decr(this.deviceKey(d, device)),
        this.redis.decr(this.ipKey(d, ipHash)),
        this.redis.decr(k.roasts),
        this.redis.decr(this.lifetimeRoastsKey()),
        ...(style ? [this.redis.hincrby(k.styles, style, -1)] : []),
      ]);
    } catch {
      // A failed refund just means the user's slot isn't returned; not worth failing the response over.
    }
  }

  // Cosmetic counter for the homepage's social-proof strip. Unlike roasts, this has no cost
  // implication (no model call), so it isn't gated behind the daily rate limiter.
  async incrementViews() {
    try {
      await this.redis.incr(this.lifetimeViewsKey());
    } catch {
      // A missed view tick is never worth failing a page load over.
    }
  }

  async recordTokens(usage, day) {
    if (!usage) return;
    const d = day || dayKey(this.now());
    const k = this.keys(d);
    try {
      await Promise.all([
        this.redis.hincrby(k.tokens, "prompt", usage.prompt || 0),
        this.redis.hincrby(k.tokens, "completion", usage.completion || 0),
        this.redis.expire(k.tokens, this.historyDays * 86400),
      ]);
    } catch {
      // Token totals are for cost visibility only; never block a response over them.
    }
  }

  async stats() {
    const now = this.now();
    const day = dayKey(now);
    const k = this.keys(day);

    const [roasts, uniqueDevices, uniqueIps, styles, tokens, lifetimeRoasts, lifetimeViews] = await Promise.all([
      this.redis.get(k.roasts),
      this.redis.scard(k.devicesSet),
      this.redis.scard(k.ipsSet),
      this.redis.hgetall(k.styles),
      this.redis.hgetall(k.tokens),
      this.redis.get(this.lifetimeRoastsKey()),
      this.redis.get(this.lifetimeViewsKey()),
    ]);

    const history = [];
    for (let i = 1; i <= this.historyDays; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const dk = dayKey(d);
      const hk = this.keys(dk);
      const [hRoasts, hDevices, hStyles, hTokens] = await Promise.all([
        this.redis.get(hk.roasts),
        this.redis.scard(hk.devicesSet),
        this.redis.hgetall(hk.styles),
        this.redis.hgetall(hk.tokens),
      ]);
      if (hRoasts) {
        history.push({
          day: dk,
          roasts: Number(hRoasts) || 0,
          uniqueDevices: hDevices || 0,
          styles: hStyles || {},
          tokens: { prompt: Number(hTokens?.prompt) || 0, completion: Number(hTokens?.completion) || 0 },
        });
      }
    }

    return {
      today: {
        day,
        roasts: Number(roasts) || 0,
        uniqueDevices: uniqueDevices || 0,
        uniqueIps: uniqueIps || 0,
        styles: styles || {},
        tokens: { prompt: Number(tokens?.prompt) || 0, completion: Number(tokens?.completion) || 0 },
        remainingToday: Math.max(0, this.limits.globalPerDay - (Number(roasts) || 0)),
      },
      limits: this.limits,
      lifetimeRoasts: Number(lifetimeRoasts) || 0,
      lifetimeViews: Number(lifetimeViews) || 0,
      history,
    };
  }
}
