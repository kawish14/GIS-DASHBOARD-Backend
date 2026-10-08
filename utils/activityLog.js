/**
 * User activity log -- who did what, when, from where, and whether it worked.
 *
 * Every entry is one row in the `user_logs` table (see schema.txt). A table
 * rather than a .log file because these entries are meant to be *asked
 * questions* later: "how many failed sign-ins did this account have this
 * week", "which admin disabled this user", "what hours is the dashboard busiest".
 * That is a WHERE / GROUP BY in SQL, and a grep-and-parse job on a text file.
 * Application errors and debugging output still go to the console as before.
 *
 * Usage, from any route:
 *
 *   logActivity(req, ACTIONS.LOGIN, { status: 'failure', details: { reason: 'invalid_credentials' } });
 *
 * Logging never throws and is not awaited by the routes: if the insert fails
 * the request carries on and the failure is printed to the console. A broken
 * audit log must never be the reason somebody cannot sign in.
 */
const { UAParser } = require('ua-parser-js');
const { pool } = require('../db/db');

// Every action the app records. Named <area>.<what happened>, so a whole area
// can be pulled at once with: WHERE action LIKE 'admin.%'
// To log something new, add it here and call logActivity() where it happens.
const ACTIONS = {
  // Signing in and out
  LOGIN:                'auth.login',
  LOGOUT:               'auth.logout',
  SESSION_ENDED:        'auth.session_ended',     // kicked out: account disabled, or session replaced

  // Invitation sign-up
  SIGNUP_VERIFY_EMAIL:  'signup.verify_email',
  SIGNUP_COMPLETE:      'signup.complete',

  // Forgotten passwords
  PASSWORD_RESET_REQUEST: 'password.reset_request',
  PASSWORD_RESET:         'password.reset',

  // Admin panel -- users
  USER_INVITE:          'admin.user_invite',
  USER_REINVITE:        'admin.user_reinvite',
  USER_CREATE:          'admin.user_create',
  USER_UPDATE:          'admin.user_update',
  USER_STATUS_CHANGE:   'admin.user_status_change',
  USER_DELETE:          'admin.user_delete',

  // Admin panel -- roles
  ROLE_CREATE:          'admin.role_create',
  ROLE_UPDATE:          'admin.role_update',
  ROLE_DELETE:          'admin.role_delete',
  ROLE_REASSIGN_DELETE: 'admin.role_reassign_delete',

  // Using the dashboard
  NCE_ANALYTICS:        'data.nce_analytics',
};

// How long rows are kept. 0 keeps them forever.
const RETENTION_DAYS = Number(process.env.USER_LOG_RETENTION_DAYS ?? 365);

/**
 * Record one action.
 *
 * @param {object} req      the Express request -- supplies the IP, the browser,
 *                          and (if signed in) the user
 * @param {string} action   one of ACTIONS
 * @param {object} [opts]
 * @param {'success'|'failure'} [opts.status='success']
 * @param {{id?: number, username?: string}} [opts.user]
 *                          who it was, when there is no signed-in session to
 *                          read it from (a failed login, a password reset)
 * @param {object} [opts.details]  anything else worth keeping. Never put a
 *                          password, token or hash in here.
 */
function logActivity(req, action, { status = 'success', user, details } = {}) {
  const who = user || req.session?.user || {};
  const userAgent = req.headers['user-agent'] || null;

  pool.query(
    `INSERT INTO user_logs (user_id, username, action, status, ip_address, device, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      who.id || null,
      who.username ? String(who.username).slice(0, 100) : null,
      action,
      status,
      req.ip || null,
      describeDevice(userAgent),
      userAgent,
      details ? JSON.stringify(details) : null,
    ]
  ).catch((err) => {
    console.error(`[user-log] could not record "${action}":`, err.message);
  });
}

// "Chrome on Windows" -- the same label login already shows for
// "you are signed in on another device".
function describeDevice(userAgent) {
  if (!userAgent) return null;
  const { browser, os } = new UAParser(userAgent).getResult();
  return `${browser.name || 'Unknown browser'} on ${os.name || 'Unknown OS'}`;
}

// Delete rows older than RETENTION_DAYS, now and once a day after.
function startLogRetentionJob() {
  if (!RETENTION_DAYS) return null;

  const purge = () => pool.query(
    `DELETE FROM user_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [RETENTION_DAYS]
  ).then((result) => {
    if (result.rowCount) {
      console.log(`[user-log] removed ${result.rowCount} entr(ies) older than ${RETENTION_DAYS} days`);
    }
  }).catch((err) => console.error('[user-log] retention cleanup failed:', err.message));

  purge();
  return setInterval(purge, 24 * 60 * 60 * 1000);
}

module.exports = { logActivity, ACTIONS, startLogRetentionJob, describeDevice };
