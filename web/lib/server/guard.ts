// In-memory rate limits and admin passcode check. Per server instance; good enough for a demo.
import "server-only";
import { timingSafeEqual } from "node:crypto";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Returns true if the key is still under `max` hits in the current window. */
export function hit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60_000;

/** Checks ADMIN_PASSCODE. Locks an IP out after 5 wrong tries for 10 minutes. */
export function checkAdmin(req: Request, passcode: unknown): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return { ok: false, status: 500, error: "ADMIN_PASSCODE is not set on the server" };

  const key = `admin-fail:${clientIp(req)}`;
  const b = buckets.get(key);
  if (b && b.resetAt > Date.now() && b.count >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, status: 429, error: "Too many wrong passcodes. Try again in 10 minutes." };
  }

  const given = Buffer.from(typeof passcode === "string" ? passcode : "");
  const want = Buffer.from(expected);
  const match = given.length === want.length && timingSafeEqual(given, want);
  if (!match) {
    hit(key, MAX_FAILED_ATTEMPTS, LOCKOUT_MS);
    return { ok: false, status: 401, error: "Wrong passcode" };
  }
  return { ok: true };
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: string; message?: string };
    return e.shortMessage || e.message || "Unknown error";
  }
  return String(err);
}
