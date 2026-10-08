/**
 * Invitation-based self-registration.
 *
 *   POST /user/verify-email     step 1 -- is this address invited?
 *   POST /user/complete-signup  step 2 -- set a password, get a username
 *
 * The flow only ever *completes* an account a GIS Admin already created from
 * the admin panel; it can never create one. An address the admin has not
 * invited is rejected outright.
 *
 * Step 1 hands back a short-lived signup token that step 2 requires. The token
 * is what makes the two calls one flow rather than two independent endpoints:
 * it expires, it is single-use, and only its SHA-256 is stored, so a completed
 * or stale registration cannot be replayed. Both endpoints are rate limited --
 * they are the only unauthenticated surface that touches the user table.
 */
const express = require('express');
const router = express.Router();

const { pool } = require('../db/db');
const { generateUniqueUsername } = require('../utils/usernameGenerator');
const { validatePasswordStrength, hashPassword } = require('../utils/password');
const { rateLimit, refundRateLimit } = require('../utils/rateLimiter');
const { logActivity, ACTIONS } = require('../utils/activityLog');
const {
  normalizeEmail, isPlausibleEmail, issueToken, tokenMatches, isExpired,
} = require('../utils/tokens');

// How long the user has between entering their email and submitting a
// password. Long enough to pick one from a password manager, short enough that
// a token left in a closed tab is worthless.
const SIGNUP_TOKEN_TTL_MS = 15 * 60 * 1000;

// Postgres unique-violation. Raised if a concurrent signup takes the username
// we generated between generating it and writing it.
const PG_UNIQUE_VIOLATION = '23505';

const NOT_INVITED_MESSAGE =
  'This email is not registered for the GIS Dashboard. Please raise a Service Request (SR) '
  + 'for registration, or contact your GIS Admin.';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// Rate limit by IP *and* address, so one caller cannot walk a list of
// addresses, and a single address cannot be attacked from a rotating IP.
const limitByIpAndEmail = (name, { windowMs, max, message }) =>
  rateLimit({
    name,
    windowMs,
    max,
    message,
    keyGenerator: (req) => `${req.ip}|${normalizeEmail(req.body && req.body.email)}`,
  });

/* -------------------------------------------------------------------------- */
/*  Step 1 -- verify the email was pre-registered by an admin                   */
/* -------------------------------------------------------------------------- */

router.post(
  '/verify-email',
  rateLimit({
    name: 'verify-email-ip',
    windowMs: 15 * 60 * 1000,
    // Generous enough for a whole office onboarding from one NAT address;
    // still far too slow to harvest which addresses have been invited.
    max: 30,
    message: 'Too many verification attempts from this network. Please try again later.',
  }),
  limitByIpAndEmail('verify-email', {
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many attempts for this email. Please try again in a few minutes.',
  }),
  async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);

    // A malformed address tells an attacker nothing, so it should not eat into
    // the caller's budget -- only lookups of well-formed addresses do.
    if (!email) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'Please enter your email address.' });
    }
    if (!isPlausibleEmail(email)) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.status, u.invite_expires_at,
                r.role_name AS role
           FROM dashboard_users u
           JOIN roles r ON u.role_id = r.id
          WHERE lower(u.email) = $1`,
        [email]
      );

      if (rows.length === 0) {
        logActivity(req, ACTIONS.SIGNUP_VERIFY_EMAIL, { status: 'failure', details: { email, reason: 'not_invited' } });
        return res.status(404).json({ error: NOT_INVITED_MESSAGE, code: 'NOT_INVITED' });
      }

      const user = rows[0];
      const fail = (reason) => logActivity(req, ACTIONS.SIGNUP_VERIFY_EMAIL, { status: 'failure', user, details: { email, reason } });

      if (user.status === 'active') {
        fail('already_registered');
        return res.status(409).json({
          error: 'This email is already registered. Please sign in with your username instead.',
          code: 'ALREADY_REGISTERED',
        });
      }

      if (user.status !== 'invited') {
        // 'disabled', or any state added later. Same wording as an unknown
        // address: whether an account exists but is blocked is not something a
        // stranger needs to know.
        fail(`account_${user.status}`);
        return res.status(403).json({ error: NOT_INVITED_MESSAGE, code: 'NOT_INVITED' });
      }

      if (user.invite_expires_at && new Date(user.invite_expires_at) <= new Date()) {
        fail('invite_expired');
        return res.status(410).json({
          error: 'This invitation has expired. Please ask the GIS Admin to invite you again.',
          code: 'INVITE_EXPIRED',
        });
      }

      const { token, tokenHash, expiresAt } = issueToken(SIGNUP_TOKEN_TTL_MS);

      await pool.query(
        `UPDATE dashboard_users
            SET signup_token_hash = $1, signup_token_expires_at = $2
          WHERE id = $3`,
        [tokenHash, expiresAt, user.id]
      );

      logActivity(req, ACTIONS.SIGNUP_VERIFY_EMAIL, { user, details: { email } });

      return res.json({
        success: true,
        email: user.email,
        // Assigned when the admin sent the invitation and already in the
        // invitation email, so showing it here is a confirmation rather than a
        // disclosure. Null only for rows invited before usernames moved to
        // invite time; the signup step generates one for those.
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        signupToken: token,
        expiresInSeconds: Math.floor(SIGNUP_TOKEN_TTL_MS / 1000),
      });
    } catch (err) {
      console.error('Verify Email Error:', err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*  Step 2 -- set the password, generate the username, activate the account     */
/* -------------------------------------------------------------------------- */

router.post(
  '/complete-signup',
  rateLimit({
    name: 'complete-signup-ip',
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many registration attempts from this network. Please try again later.',
  }),
  limitByIpAndEmail('complete-signup', {
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many attempts for this email. Please try again in a few minutes.',
  }),
  async (req, res) => {
    const { password, confirmPassword, signupToken } = req.body || {};
    const email = normalizeEmail(req.body && req.body.email);

    // Everything rejected below is a mistake the user can see and correct --
    // a typo, a password that is too short. None of it probes for a secret, so
    // none of it is charged against the rate limit; only a wrong or expired
    // token is. Otherwise five fumbled passwords would lock somebody out of
    // their own registration for fifteen minutes.
    if (!email || !isPlausibleEmail(email)) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!signupToken || typeof signupToken !== 'string') {
      refundRateLimit(req);
      return res.status(400).json({
        error: 'Your registration session is missing. Please start again from the email step.',
        code: 'INVALID_TOKEN',
      });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      refundRateLimit(req);
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    // The account exists but we do not have its full name yet, so the policy
    // check runs once more inside the transaction where we do. This first pass
    // rejects obviously weak input before we take a row lock.
    const earlyPolicyError = validatePasswordStrength(password, { email });
    if (earlyPolicyError) {
      refundRateLimit(req);
      return res.status(400).json({ error: earlyPolicyError, code: 'WEAK_PASSWORD' });
    }

    // Hashing is the slow part; do it before opening the transaction so the
    // row lock is held for as short a time as possible.
    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (err) {
      console.error('Password Hash Error:', err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }

    // The username is assigned when the admin sends the invitation, so all
    // this step has to do is store the password and flip the account on.
    // Rows invited before that change still have a null username, so one is
    // generated here as a fallback -- with a retry, because generation and
    // write are two steps and the unique index is the real guard.
    const MAX_USERNAME_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt += 1) {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // FOR UPDATE serialises two submissions of the same registration, so
        // the second one sees status = 'active' rather than overwriting the
        // password the first one just set.
        const { rows } = await client.query(
          `SELECT id, username, email, full_name, status,
                  signup_token_hash, signup_token_expires_at, invite_expires_at
             FROM dashboard_users
            WHERE lower(email) = $1
            FOR UPDATE`,
          [email]
        );

        if (rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: NOT_INVITED_MESSAGE, code: 'NOT_INVITED' });
        }

        const user = rows[0];

        if (user.status === 'active') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'This email is already registered. Please sign in instead.',
            code: 'ALREADY_REGISTERED',
          });
        }

        if (user.status !== 'invited') {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: NOT_INVITED_MESSAGE, code: 'NOT_INVITED' });
        }

        if (isExpired(user.signup_token_expires_at)
            || !tokenMatches(signupToken, user.signup_token_hash)) {
          await client.query('ROLLBACK');
          logActivity(req, ACTIONS.SIGNUP_COMPLETE, { status: 'failure', user, details: { email, reason: 'invalid_or_expired_token' } });
          return res.status(401).json({
            error: 'Your registration session has expired. Please verify your email again.',
            code: 'INVALID_TOKEN',
          });
        }

        if (user.invite_expires_at && new Date(user.invite_expires_at) <= new Date()) {
          await client.query('ROLLBACK');
          return res.status(410).json({
            error: 'This invitation has expired. Please ask the GIS Admin to invite you again.',
            code: 'INVITE_EXPIRED',
          });
        }

        // Now that the account's own details are known, re-run the policy so a
        // password that is simply the user's own name is rejected too.
        const policyError = validatePasswordStrength(password, {
          email: user.email,
          fullName: user.full_name,
        });
        if (policyError) {
          await client.query('ROLLBACK');
          refundRateLimit(req);
          return res.status(400).json({ error: policyError, code: 'WEAK_PASSWORD' });
        }

        // Normally already set by the invitation; generated only for rows
        // that predate usernames being assigned at invite time.
        const username = user.username
          || await generateUniqueUsername(client, { email: user.email, fullName: user.full_name });

        await client.query(
          `UPDATE dashboard_users
              SET username                = $1,
                  password_hash           = $2,
                  status                  = 'active',
                  activated_at            = NOW(),
                  signup_token_hash       = NULL,
                  signup_token_expires_at = NULL,
                  invite_expires_at       = NULL
            WHERE id = $3`,
          [username, passwordHash, user.id]
        );

        await client.query('COMMIT');

        console.log(`Registration completed for ${user.email} as "${username}"`);
        logActivity(req, ACTIONS.SIGNUP_COMPLETE, { user: { id: user.id, username }, details: { email } });

        refundRateLimit(req);
        return res.json({
          success: true,
          username,
          full_name: user.full_name,
          message: 'Your account is ready. Please sign in with your new username.',
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        const isUsernameCollision =
          err.code === PG_UNIQUE_VIOLATION &&
          String(err.constraint || '').includes('username');

        if (isUsernameCollision && attempt < MAX_USERNAME_ATTEMPTS) {
          console.warn(`Username collision on attempt ${attempt}, regenerating.`);
          continue; // eslint-disable-line no-continue
        }

        console.error('Complete Signup Error:', err);
        return res.status(500).json({ error: 'Server error. Please try again.' });
      } finally {
        client.release();
      }
    }

    return res
      .status(500)
      .json({ error: 'Could not allocate a username. Please try again.' });
  }
);

module.exports = router;
