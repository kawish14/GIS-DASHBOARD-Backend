const { pool } = require("../db/db");

const isAuthenticated = async (req, res, next) => {
    // 1. Check if session exists at all
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // 2. Fetch the current active session ID from the database
        const result = await pool.query(
            "SELECT current_session_id, status FROM dashboard_users WHERE id = $1", 
            [req.session.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "User not found" });
        }

        const { current_session_id: dbSessionId, status } = result.rows[0];

        // An admin can disable an account while its owner is signed in. Check
        // it here rather than only at login, so revoking access takes effect
        // on the next request instead of the next sign-in.
        if (status !== 'active') {
            req.session.destroy(() => {});
            res.clearCookie("connect.sid");
            return res.status(403).json({ error: "This account is no longer active." });
        }

        // 3. THE MAGIC CHECK: If the IDs don't match, they logged in somewhere else!
        if (dbSessionId !== req.sessionID) {
            console.log(`Destroying stale session for ${req.session.user.username}`);
            req.session.destroy(); // Kill old session
            res.clearCookie("connect.sid"); // Clear their cookie
            return res.status(401).json({ error: "Logged in from another device." });
        }

        // If everything matches, proceed!
        return next();

    } catch (err) {
        console.error("Auth DB Check Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

const isAdmin = (req, res, next) => {
    if (req.session.user?.role === 'admin') return next();
    res.status(403).json({ error: "Access Denied" });
};

module.exports = { isAuthenticated, isAdmin };