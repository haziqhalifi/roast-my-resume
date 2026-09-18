import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const dayKey = (date) => date.toISOString().slice(0, 10);

const emptyDay = (day) => ({
  day,
  roasts: 0,
  devices: {},
  ips: {},
  styles: {},
  tokens: { prompt: 0, completion: 0 },
});

export class UsageStore {
  // Counters only: no resume text is ever written to disk, and IPs are stored as salted hashes.
  constructor({
    file,
    perDevicePerDay = 1,
    perIpPerDay = 5,
    globalPerDay = 200,
    historyDays = 90,
    salt = "roast-my-resume",
    now = () => new Date(),
  } = {}) {
    this.file = file;
    this.limits = { perDevicePerDay, perIpPerDay, globalPerDay };
    this.historyDays = historyDays;
    this.salt = salt;
    this.now = now;
    this.data = { current: emptyDay(dayKey(this.now())), history: [], lifetime: { roasts: 0, views: 0 } };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.current?.day) {
        // Back-compat: older files were written before the views counter existed.
        parsed.lifetime ??= { roasts: 0, views: 0 };
        parsed.lifetime.views ??= 0;
        this.data = parsed;
      }
    } catch {
      // No file yet, or it's unreadable: start fresh rather than crash the server.
    }
    this.rollover();
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // Tracking must never break a roast.
    }
  }

  rollover() {
    const today = dayKey(this.now());
    if (this.data.current.day === today) return;
    const { day, roasts, devices, styles, tokens } = this.data.current;
    if (roasts > 0) {
      this.data.history.unshift({ day, roasts, uniqueDevices: Object.keys(devices).length, styles, tokens });
      this.data.history = this.data.history.slice(0, this.historyDays);
    }
    this.data.current = emptyDay(today);
  }

  hash(value) {
    return crypto.createHash("sha256").update(`${this.salt}:${value}`).digest("hex").slice(0, 16);
  }

  resetAt() {
    const next = new Date(this.now());
    next.setUTCHours(24, 0, 0, 0);
    return next.toISOString();
  }

  check(deviceId, ip) {
    this.rollover();
    const cur = this.data.current;
    const device = this.hash(deviceId || "unknown");
    const ipHash = this.hash(ip || "unknown");
    const used = cur.devices[device] || 0;
    const resetAt = this.resetAt();

    if (cur.roasts >= this.limits.globalPerDay) {
      return { allowed: false, reason: "global", remaining: 0, resetAt, day: cur.day };
    }
    if (used >= this.limits.perDevicePerDay) {
      return { allowed: false, reason: "device", remaining: 0, resetAt, day: cur.day };
    }
    if ((cur.ips[ipHash] || 0) >= this.limits.perIpPerDay) {
      return { allowed: false, reason: "ip", remaining: 0, resetAt, day: cur.day };
    }
    return { allowed: true, remaining: this.limits.perDevicePerDay - used, resetAt, device, ipHash, day: cur.day };
  }

  consume(deviceId, ip, style) {
    const result = this.check(deviceId, ip);
    if (!result.allowed) return result;

    const cur = this.data.current;
    cur.roasts++;
    cur.devices[result.device] = (cur.devices[result.device] || 0) + 1;
    cur.ips[result.ipHash] = (cur.ips[result.ipHash] || 0) + 1;
    if (style) cur.styles[style] = (cur.styles[style] || 0) + 1;
    this.data.lifetime.roasts++;
    this.persist();

    return { ...result, remaining: this.limits.perDevicePerDay - cur.devices[result.device] };
  }

  refund(device, ipHash, style) {
    const cur = this.data.current;
    if (cur.devices[device]) cur.devices[device]--;
    if (cur.ips[ipHash]) cur.ips[ipHash]--;
    if (style && cur.styles[style]) cur.styles[style]--;
    if (cur.roasts) cur.roasts--;
    if (this.data.lifetime.roasts) this.data.lifetime.roasts--;
    this.persist();
  }

  recordTokens(usage) {
    if (!usage) return;
    this.data.current.tokens.prompt += usage.prompt || 0;
    this.data.current.tokens.completion += usage.completion || 0;
    this.persist();
  }

  // Cosmetic counter for the homepage's social-proof strip. Unlike roasts, this has no cost
  // implication (no model call), so it isn't behind the daily rate limiter.
  incrementViews() {
    this.data.lifetime.views++;
    this.persist();
  }

  stats() {
    this.rollover();
    const cur = this.data.current;
    return {
      today: {
        day: cur.day,
        roasts: cur.roasts,
        uniqueDevices: Object.keys(cur.devices).length,
        uniqueIps: Object.keys(cur.ips).length,
        styles: cur.styles,
        tokens: cur.tokens,
        remainingToday: Math.max(0, this.limits.globalPerDay - cur.roasts),
      },
      limits: this.limits,
      lifetimeRoasts: this.data.lifetime.roasts,
      lifetimeViews: this.data.lifetime.views,
      history: this.data.history.slice(0, 30),
    };
  }
}
