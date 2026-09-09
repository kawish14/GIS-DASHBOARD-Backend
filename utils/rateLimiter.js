/**
 * A small fixed-window rate limiter for the unauthenticated registration
 * endpoints.
 *
 * Those endpoints are the one place in the app where an anonymous caller can
 * probe the user table, so they need a brake: without one, /verify-email is a
 * free oracle for harvesting which addresses an admin has invited, and
 * /complete-signup can be hammered with token guesses.
 *
 * State is in-process, which is the right fit while the API runs as the single
 * node in server.js. If this is ever put behind more than one worker, move the
 * counters to Postgres or Redis -- the interface here would not change.
 *
 * NOTE: the default key is req.ip, which is the socket address unless Express
 * is told otherwise. If this API is ever put behind nginx or another reverse
 * proxy, every request will look like it came from the proxy and the per-IP
 * limits below will throttle everyone at once. Set `app.set('trust proxy', 1)`
 * in server.js at the same time as adding the proxy, so req.ip reads the
 * X-Forwarded-For hop the proxy sets.
 */

const buckets = new Map(); // key -> { count, resetAt }

// Drop expired buckets periodically so a burst of unique keys cannot grow the
// map without bound. unref() keeps this timer from holding the process open.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

/**
 * Build an Express middleware that allows `max` requests per `windowMs` per
 * caller.
 *
 * @param {object}   options
 * @param {number}   options.windowMs
 * @param {number}   options.max
 * @param {string}   options.name     namespaces the counters between limiters
 * @param {string}   [options.message] shown to the caller when they are over
 * @param {(req: import('express').Request) => string} [options.keyGenerator]
 */
function rateLimit({ windowMs, max, name, message, keyGenerator }) {
  const identify = keyGenerator || ((req) => req.ip || 'unknown');
  const overLimitMessage =
    message || 'Too many attempts. Please wait a moment and try again.';

  return (req, res, next) => {
    const key = `${name}:${identify(req)}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    // Remember what this request was charged to, so the route can hand the
    // attempt back if it turns out not to have been an attack. See
    // refundRateLimit below.
    req.rateLimitCharges = req.rateLimitCharges || [];
    req.rateLimitCharges.push(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: overLimitMessage, retryAfterSeconds });
    }

    return next();
  };
}

/**
 * Give back the attempt this request was charged for.
 *
 * The limits exist to slow down guessing at secrets. A user who mistypes their
 * password, or whose new password is too short, is not guessing at anything --
 * charging them for it would lock a legitimate person out of their own
 * registration after a handful of typos. Call this for outcomes that carry no
 * information an attacker could use.
 *
 * Refunding one attempt rather than clearing the counter matters: otherwise an
 * attacker could alternate a real guess with a deliberately invalid request
 * and reset their budget every other call.
 */
function refundRateLimit(req) {
  for (const key of req.rateLimitCharges || []) {
    const bucket = buckets.get(key);
    if (bucket && bucket.count > 0) bucket.count -= 1;
  }
}

module.exports = { rateLimit, refundRateLimit };
