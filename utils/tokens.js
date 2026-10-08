/**
 * The one-time tokens behind the two unauthenticated flows: completing an
 * invitation, and resetting a forgotten password.
 *
 * Both work the same way. A random 32-byte token goes to the user (in a
 * response, or in an email); only its SHA-256 is written to the database. That
 * way a leaked dump cannot be used to finish somebody else's registration or
 * take over their account, and the stored value is worthless once the token
 * has been used and cleared.
 */
const crypto = require('crypto');

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Deliberately permissive: the address only has to be well-formed enough to
// look up. Whether it is a real, reachable mailbox is the admin's call, made
// when they send the invitation.
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 100;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a token and the values to store alongside it.
 *
 * @param {number} ttlMs how long it stays valid
 * @returns {{token: string, tokenHash: string, expiresAt: Date}}
 */
function issueToken(ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

/**
 * Compare a presented token against a stored hash without leaking, through
 * timing, how much of the value matched.
 */
function tokenMatches(providedToken, storedHash) {
  if (!providedToken || !storedHash) return false;

  const provided = Buffer.from(hashToken(providedToken), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');

  if (provided.length !== stored.length) return false;
  return crypto.timingSafeEqual(provided, stored);
}

/** True once `expiresAt` has passed, or if it was never set. */
function isExpired(expiresAt) {
  return !expiresAt || new Date(expiresAt) <= new Date();
}

module.exports = { normalizeEmail, isPlausibleEmail, issueToken, tokenMatches, isExpired };
