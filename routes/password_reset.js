/**
 * Forgotten passwords.
 *
 *   POST /user/forgot-password   ask for a reset link
 *   POST /user/reset-password    set a new password using the link's token
 *
 * /forgot-password answers plainly whether the address is known, matching
 * /user/verify-email, so somebody who mistypes their address is told so instead
 * of waiting for mail that will never arrive. The trade-off is that both
 * endpoints can be used to check whether an address belongs to a user here;
 * the rate limits are what keep that from being practical at scale.
 *
 * The link carries a token whose SHA-256 alone is stored, valid for an hour and
 * usable once. Setting a new password also clears the account's active session,
 * so anyone already signed in with the old one is turned out.
 */
const express = require('express');
const router = express.Router();

const { pool } = require('../db/db');
const { validatePasswordStrength, hashPassword } = require('../utils/password');
const { rateLimit, refundRateLimit } = require('../utils/rateLimiter');
const { logActivity, ACTIONS } = require('../utils/activityLog');
const {
  normalizeEmail, isPlausibleEmail, issueToken, tokenMatches, isExpired,
} = require('../utils/tokens');
const {
  sendPasswordResetEmail, sendInvitationEmail, getRegistrationUrl, getLoginUrl,
} = require('../utils/mailer');

// Long enough to find the mail and act on it, short enough that a link left in
// an inbox is not a standing key to the account.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const RESET_PATH = '/reset-password';

const NOT_REGISTERED_MESSAGE =
  'This email is not registered for the GIS Dashboard. Please raise a Service Request (SR) '
  + 'for registration, or contact your GIS Admin.';

const limitByIpAndEmail = (name, opts) =>
  rateLimit({
    ...opts,
    name,
    keyGenerator: (req) => `${req.ip}|${normalizeEmail(req.body && req.body.email)}`,
  });

function buildResetUrl(token, email) {
  const base = getLoginUrl().replace(/\/login$/, '');
  return `${base}${RESET_PATH}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
}

/* -------------------------------------------------------------------------- */
/*  Ask for a reset link                                                       */
/* -------------------------------------------------------------------------- */

router.post(
  '/forgot-password',
  rateLimit({
    name: 'forgot-password-ip',
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many reset requests from this network. Please try again later.',
  }),
  limitByIpAndEmail('forgot-password', {
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'A reset link has already been requested for this address. Please try again shortly.',
  }),
  async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);

    if (!email || !isPlausibleEmail(email)) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT id, username, email, full_name, status, invite_expires_at,
                (SELECT role_name FROM roles WHERE id = dashboard_users.role_id) AS role
           FROM dashboard_users
          WHERE lower(email) = $1`,
        [email]
      );

      const user = rows[0];
      const log = (status, details) =>
        logActivity(req, ACTIONS.PASSWORD_RESET_REQUEST, { status, user, details: { email, ...details } });

      // No account for this address: say so, rather than leaving them waiting
      // on a link that is never coming.
      if (!user) {
        log('failure', { reason: 'not_registered' });
        return res.status(404).json({ error: NOT_REGISTERED_MESSAGE, code: 'NOT_REGISTERED' });
      }

      if (user.status === 'disabled') {
        log('failure', { reason: 'account_disabled' });
        return res.status(403).json({
          error: 'This account has been disabled. Please contact your GIS Admin.',
          code: 'ACCOUNT_DISABLED',
        });
      }

      // Someone who never finished their invitation has no password to reset.
      // Re-sending the invitation is what they actually need.
      if (user.status === 'invited') {
        await sendInvitationEmail({
          email: user.email,
          username: user.username,
          fullName: user.full_name,
          role: user.role,
          expiresAt: user.invite_expires_at,
        });
        console.log(`Forgot-password for a pending invitation (${user.email}); re-sent the invitation.`);
        log('success', { outcome: 'invitation_resent' });
        return res.json({
          success: true,
          code: 'INVITATION_RESENT',
          message: 'You have not set a password yet. We have re-sent your invitation email — '
                 + 'open the link in it to finish setting up your account.',
        });
      }

      const { token, tokenHash, expiresAt } = issueToken(RESET_TOKEN_TTL_MS);

      await pool.query(
        `UPDATE dashboard_users
            SET reset_token_hash = $1, reset_token_expires_at = $2
          WHERE id = $3`,
        [tokenHash, expiresAt, user.id]
      );

      const mail = await sendPasswordResetEmail({
        email: user.email,
        username: user.username,
        fullName: user.full_name,
        resetUrl: buildResetUrl(token, user.email),
        expiresAt,
      });

      // A reset the user cannot act on is worse than an error: the link only
      // ever exists in that email, so if it did not go out, say so.
      if (!mail.sent) {
        log('failure', { reason: 'mail_failed' });
        return res.status(502).json({
          error: `We could not send the reset email: ${mail.reason} Please contact your GIS Admin.`,
          code: 'MAIL_FAILED',
        });
      }

      log('success', { outcome: 'reset_link_sent' });
      return res.json({
        success: true,
        message: `A reset link is on its way to ${user.email}. Check your inbox, and your spam folder.`,
      });
    } catch (err) {
      console.error('Forgot Password Error:', err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*  Use the link                                                               */
/* -------------------------------------------------------------------------- */

router.post(
  '/reset-password',
  rateLimit({
    name: 'reset-password-ip',
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many attempts from this network. Please try again later.',
  }),
  limitByIpAndEmail('reset-password', {
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many attempts for this address. Please request a fresh link.',
  }),
  async (req, res) => {
    const { token, password, confirmPassword } = req.body || {};
    const email = normalizeEmail(req.body && req.body.email);

    // As in complete-signup, only a wrong token is treated as an attack; a
    // password the user has to correct is not charged against the limit.
    if (!email || !isPlausibleEmail(email)) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'This reset link is incomplete. Please request a new one.' });
    }
    if (!token || typeof token !== 'string') {
      refundRateLimit(req);
      return res.status(400).json({
        error: 'This reset link is incomplete. Please request a new one.',
        code: 'INVALID_TOKEN',
      });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    const earlyPolicyError = validatePasswordStrength(password, { email });
    if (earlyPolicyError) {
      refundRateLimit(req);
      return res.status(400).json({ error: earlyPolicyError, code: 'WEAK_PASSWORD' });
    }

    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (err) {
      console.error('Password Hash Error:', err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // FOR UPDATE so two submissions of the same link cannot both succeed --
      // the second one finds the token already cleared.
      const { rows } = await client.query(
        `SELECT id, username, email, full_name, status,
                reset_token_hash, reset_token_expires_at
           FROM dashboard_users
          WHERE lower(email) = $1
          FOR UPDATE`,
        [email]
      );

      const user = rows[0];
      const usable = user
        && user.status === 'active'
        && !isExpired(user.reset_token_expires_at)
        && tokenMatches(token, user.reset_token_hash);

      if (!usable) {
        await client.query('ROLLBACK');
        logActivity(req, ACTIONS.PASSWORD_RESET, {
          status: 'failure',
          user,
          details: { email, reason: 'invalid_or_expired_token' },
        });
        return res.status(401).json({
          error: 'This reset link has expired or has already been used. Please request a new one.',
          code: 'INVALID_TOKEN',
        });
      }

      const policyError = validatePasswordStrength(password, {
        email: user.email,
        fullName: user.full_name,
      });
      if (policyError) {
        await client.query('ROLLBACK');
        refundRateLimit(req);
        return res.status(400).json({ error: policyError, code: 'WEAK_PASSWORD' });
      }

      // current_session_id is cleared as well: changing a password should end
      // whatever session the old one was holding open, on this device or any
      // other. routes/auth.js drops the stale session on its next request.
      await client.query(
        `UPDATE dashboard_users
            SET password_hash          = $1,
                reset_token_hash       = NULL,
                reset_token_expires_at = NULL,
                current_session_id     = NULL
          WHERE id = $2`,
        [passwordHash, user.id]
      );

      await client.query('COMMIT');

      console.log(`Password reset completed for ${user.username}`);
      logActivity(req, ACTIONS.PASSWORD_RESET, { user, details: { email } });
      refundRateLimit(req);

      return res.json({
        success: true,
        username: user.username,
        message: 'Your password has been changed. Please sign in.',
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Reset Password Error:', err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
