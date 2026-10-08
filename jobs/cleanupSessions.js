// jobs/cleanupSessions.js
//
// Belt-and-suspenders cleanup for the session store + the
// dashboard_users.current_session_id pointer that mirrors it.
//
// connect-pg-simple already prunes its own `session` table on an
// interval (make sure `pruneSessionInterval` is enabled where you
// configure the store). This job additionally clears any
// current_session_id that points at a session row which no longer
// exists -- that dangling pointer was the root cause of users being
// stuck behind "you're already logged in elsewhere" with no session
// left to actually log out of.

const { pool } = require("../db/db");

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

async function cleanupSessions() {
    try {
        // 1. Defensive: remove session rows the store itself considers
        //    expired, in case pruning is ever disabled/misconfigured.
        const expired = await pool.query('DELETE FROM session WHERE expire < NOW()');

        // 2. Clear orphaned pointers: a user's current_session_id that
        //    references a session row that no longer exists.
        const orphaned = await pool.query(`
            UPDATE dashboard_users u
            SET current_session_id = NULL
            WHERE current_session_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM session s WHERE s.sid = u.current_session_id
              )
        `);

        if (expired.rowCount || orphaned.rowCount) {
            console.log(
                `[session-cleanup] removed ${expired.rowCount} expired session row(s), ` +
                `cleared ${orphaned.rowCount} orphaned pointer(s)`
            );
        }
    } catch (err) {
        console.error("[session-cleanup] failed:", err);
    }
}

function startSessionCleanupJob() {
    cleanupSessions(); // run once at boot so orphans don't linger until the first interval
    return setInterval(cleanupSessions, CLEANUP_INTERVAL_MS);
}

module.exports = { startSessionCleanupJob };