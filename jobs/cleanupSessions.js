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

const { pool, SESSION_IDLE_MS } = require("../db/db");

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

async function cleanupSessions() {
    try {
        // 1. Remove expired sessions (the store's own pruning is off, see
        //    db/db.js) and log each signed-in one as auth.session_timeout.
        const expired = await removeExpiredSessions();

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
                `[session-cleanup] ended ${expired.rowCount} expired session(s), ` +
                `cleared ${orphaned.rowCount} orphaned pointer(s)`
            );
        }
    } catch (err) {
        console.error("[session-cleanup] failed:", err);
    }
}

// A session expires SESSION_IDLE_MS after its last request, so that is when
// the user actually stopped -- the row is dated then, not now. The user's id is
// checked against dashboard_users because the account may have been deleted.
async function removeExpiredSessions() {
    try {
        return await pool.query(`
            WITH gone AS (
                DELETE FROM session WHERE expire < NOW() RETURNING sid, sess, expire
            )
            INSERT INTO user_logs (created_at, user_id, username, action, status, session_id)
            SELECT expire - ($1::int * INTERVAL '1 millisecond'),
                   (SELECT id FROM dashboard_users WHERE id = (sess->'user'->>'id')::int),
                   sess->'user'->>'username',
                   'auth.session_timeout',
                   'success',
                   left(encode(sha256(convert_to(sid, 'UTF8')), 'hex'), 16)
              FROM gone
             WHERE sess->'user' IS NOT NULL
        `, [SESSION_IDLE_MS]);
    } catch (err) {
        // Most likely user_logs does not exist yet. Expired sessions still
        // have to go, so fall back to deleting them without logging.
        console.error("[session-cleanup] could not log timeouts:", err.message);
        return pool.query('DELETE FROM session WHERE expire < NOW()');
    }
}

function startSessionCleanupJob() {
    cleanupSessions(); // run once at boot so orphans don't linger until the first interval
    return setInterval(cleanupSessions, CLEANUP_INTERVAL_MS);
}

module.exports = { startSessionCleanupJob };