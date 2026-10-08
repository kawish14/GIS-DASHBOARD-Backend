/**
 * Password hashing and the strength policy applied to self-set passwords.
 *
 * The cost factor matches the one already used when an admin creates a user
 * in routes/admin_routes.js, so hashes are consistent across both paths.
 */
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 10;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128; // bcrypt silently truncates past 72 bytes;
                                 // rejecting long input is clearer than that.

/**
 * Validate a password a user chose for themselves.
 *
 * Returns null when the password is acceptable, or a message safe to show the
 * user. Kept deliberately modest -- length is what actually matters -- but the
 * character-class rules are here because most GIS deployments are asked for
 * them by policy.
 *
 * @param {string} password
 * @param {{email?: string, fullName?: string}} identity  used to reject
 *        passwords that are just the user's own details
 */
function validatePasswordStrength(password, identity = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  }
  if (password.trim() !== password) {
    return 'Password cannot start or end with a space.';
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return 'Password must contain both uppercase and lowercase letters.';
  }
  if (!/\d/.test(password)) {
    return 'Password must contain at least one number.';
  }

  const lowered = password.toLowerCase();
  const emailLocalPart = (identity.email || '').split('@')[0].toLowerCase();
  if (emailLocalPart.length >= 4 && lowered.includes(emailLocalPart)) {
    return 'Password cannot contain your email address.';
  }
  if (/^(password|welcome|qwerty|letmein|gisadmin)/i.test(password)) {
    return 'Password is too easy to guess. Please choose something less common.';
  }

  return null;
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

module.exports = { validatePasswordStrength, hashPassword };
