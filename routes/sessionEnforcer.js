// middleware/sessionEnforcer.js

const ABSOLUTE_TIMEOUT = 30 * 60 * 1000; // 30 Minutes (adjust as needed)

const enforceAbsoluteTimeout = (req, res, next) => {
    // 1. If no session exists, just pass through (let other auth checks handle it)
    if (!req.session || !req.session.user) {
        return next();
    }

    // 2. Check how long ago the session was created
    const now = Date.now();
    const createdAt = req.session.createdAt || now; // Default to now if missing
    
    // 3. If session is older than the limit...
    if (now - createdAt > ABSOLUTE_TIMEOUT) {
        console.log(`Session for ${req.session.user.username} exceeded absolute limit. Destroying.`);
        
        // KILL IT
        req.session.destroy((err) => {
            res.clearCookie("connect.sid");
            return res.status(401).json({ error: "Session limit reached. Please login again." });
        });
        return; // Stop execution
    }

    // 4. If safe, proceed
    next();
};

module.exports = enforceAbsoluteTimeout;