const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { pool } = require("../db/db"); 
const { isAuthenticated } = require("./auth");
const { logActivity, ACTIONS, describeDevice } = require("../utils/activityLog");

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const deviceLabel = describeDevice(req.headers['user-agent']) || 'Unknown device';

  try {
    // status = 'active' excludes accounts that were invited but never
    // completed (they have no password yet) and accounts an admin disabled.
    const userResult = await pool.query(`
        SELECT u.*, r.role_name as role, r.permissions 
        FROM dashboard_users u
        JOIN roles r ON u.role_id = r.id
        WHERE u.username = $1
          AND u.status = 'active'
    `, [username]);

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      // Belt and braces: the status filter already rules this out, but
      // bcrypt.compare throws on a null hash, and a 500 here would be a
      // needlessly loud way to say "wrong credentials".
      const match = user.password_hash
        ? await bcrypt.compare(password, user.password_hash)
        : false;

      if (match) {
        const isAlreadyLoggedIn = await new Promise((resolve) => {
          if (!user.current_session_id) {
            return resolve(false); 
          }

          req.sessionStore.get(user.current_session_id, (err, existingSession) => {
            if (existingSession) {
              resolve(true); 
            } else {
              resolve(false); 
            }
          });
        });

        if (isAlreadyLoggedIn) {

          const deviceResult = await pool.query(
            'SELECT last_login_device FROM dashboard_users WHERE id = $1',
            [user.id]
          );
          const { last_login_device } = deviceResult.rows[0];

          logActivity(req, ACTIONS.LOGIN, {
            status: 'failure',
            user,
            details: { reason: 'already_logged_in', other_device: last_login_device },
          });

         return res.status(403).json({
            error: `You are already logged in on another device (${last_login_device || 'unknown device'}). Please log out there or wait for the session to expire.`
          });
        }

        // SECURITY: Remove sensitive data before saving to session
        delete user.password_hash;
        delete user.signup_token_hash;
        delete user.signup_token_expires_at;

        req.session.regenerate((err) => {
            if (err) {
                console.error("Regenerate Error:", err);
                return res.status(500).json({ error: "Could not log in" });
            }

            req.session.user = user;

            req.session.save(async (saveErr) => {
                if (saveErr) {
                    console.error("Session Save Error:", saveErr);
                    return res.status(500).json({ error: "Session save failed" });
                }

                try {
                    await pool.query(
                      `UPDATE dashboard_users 
                      SET current_session_id = $1, last_login_device = $2, last_login_at = NOW() 
                      WHERE id = $3`,
                      [req.sessionID, deviceLabel, user.id]
                    );
                    
                    // Logged after the session is saved, so reaching this line
                    // means the sign-in succeeded. Username rather than
                    // full_name: full_name is optional, and printing a null
                    // here read as though the session itself were empty.
                    console.log(`Signed in: ${user.username} (${user.role})`);
                    logActivity(req, ACTIONS.LOGIN, { details: { role: user.role } });
                    return res.json({
                        full_name: user.full_name,
                        email: user.email,
                        permissions: user.permissions,
                        role: user.role,
                        success: true
                    });
                } catch (dbErr) {
                    console.error("DB Update Error:", dbErr);
                    return res.status(500).json({ error: "Failed to set active session" });
                }
            });
        });

        return; 
      }
    }

    // The caller gets the same 401 either way; only the log tells the two
    // apart, so an admin can see whether an account is being guessed at.
    const knownUser = userResult.rows[0];
    logActivity(req, ACTIONS.LOGIN, {
      status: 'failure',
      user: knownUser || { username },
      details: { reason: knownUser ? 'wrong_password' : 'unknown_or_inactive_username' },
    });

    res.status(401).json({ error: "Invalid credentials" });
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/me", isAuthenticated, (req, res) => {
  res.json(req.session.user);
});

router.post("/logout", async (req, res) => {
  if (req.session && req.session.user) {
    try {
      await pool.query(
        "UPDATE dashboard_users SET current_session_id = NULL WHERE id = $1", 
        [req.session.user.id]
      );
    } catch (err) {
      console.error("Failed to clear DB session ID:", err);
    }
  }

  // Was console.log(req.session), which printed the whole session object --
  // the user's id, email, role and permissions -- into the server log on every
  // sign-out. The username is all that is useful here.
  const signedOut = req.session?.user?.username;
  if (signedOut) logActivity(req, ACTIONS.LOGOUT);

  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Could not log out" });
    }
    res.clearCookie("connect.sid"); 
    res.json({ message: "Logged out successfully" });
    console.log(`Signed out: ${signedOut || 'no active session'}`);
  });
});

router.get("/active-users", isAuthenticated, async (req, res) => {
  try {
    // Joining the session table limits this to users whose session still exists.
    const result = await pool.query(`
        SELECT u.id, u.username, u.full_name, u.email, r.role_name as role, r.permissions 
        FROM dashboard_users u
        JOIN roles r ON u.role_id = r.id
        INNER JOIN session s ON u.current_session_id = s.sid
        ORDER BY u.full_name ASC
    `);
    res.json(result.rows);

  } catch (err) {
    console.error("Active Users Error:", err);
    res.status(500).json({ error: "Failed to fetch active users" });
  }
});

module.exports = router;