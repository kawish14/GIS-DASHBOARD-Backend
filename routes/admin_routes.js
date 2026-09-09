const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { pool } = require("../db/db"); 
const {isAuthenticated, isAdmin} = require("./auth");
const { sendInvitationEmail, sendCredentialsEmail, getRegistrationUrl, getLoginUrl } = require("../utils/mailer");
const { generateUniqueUsername } = require("../utils/usernameGenerator");

// How long an invitation stays open before the admin has to re-issue it.
const INVITE_VALIDITY_DAYS = 2;

/**
 * Turn a Postgres unique violation (23505) into a message that names the
 * constraint that actually failed.
 *
 * Assuming every 23505 is a duplicate email is how a database problem gets
 * misreported as a form problem: if the table's id sequence has fallen behind
 * its rows, the INSERT collides on the primary key and the admin is told the
 * address is taken when it is not. Nothing they type will fix that, so say
 * what really happened and where the fix is.
 */
function uniqueViolationResponse(err, fallback) {
    const constraint = String(err.constraint || '');

    if (constraint.includes('email')) {
        return { status: 409, error: "A user with this email already exists." };
    }
    if (constraint.includes('username')) {
        return { status: 409, error: "That username is already taken." };
    }
    if (constraint.includes('role_name')) {
        return { status: 409, error: "A role with this name already exists." };
    }
    if (constraint.includes('pkey')) {
        // Happens when rows were loaded with their ids spelled out -- a restored
        // dump, or seed SQL listing `id` -- which does not advance the sequence
        // behind a serial column. It keeps handing out ids that are taken.
        return {
            status: 500,
            error: "The table's ID sequence has fallen behind its rows, so the record could not be "
                 + "created. This happens when rows were inserted with explicit ids. Reset it with: "
                 + "SELECT setval(pg_get_serial_sequence('dashboard_users', 'id'), "
                 + "COALESCE((SELECT max(id) FROM dashboard_users), 0) + 1, false);",
        };
    }

    return { status: 409, error: fallback };
}

/******************************* USERS *********************************/

// List all users
router.get('/users', isAuthenticated, isAdmin, async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.username, u.full_name, u.email, u.status,
               u.invited_at, u.activated_at, u.invite_expires_at,
               r.role_name as role, r.permissions 
        FROM dashboard_users u
        JOIN roles r ON u.role_id = r.id
        ORDER BY u.id DESC
    `);
    res.json(result.rows);
});

// Pre-register ("invite") a user.
//
// This is the entry point for invitation-based registration: the admin fixes
// the email and the role, and the username is generated here so it can be put
// in the invitation email. The invitee supplies only a password, through
// /user/complete-signup. The row exists from this moment on, with
// status = 'invited' and a username but no password.
router.post('/users/invite', isAuthenticated, isAdmin, async (req, res) => {
    const { full_name, role } = req.body;
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';

    if (!email) {
        return res.status(400).json({ error: "Email is required to invite a user" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100) {
        return res.status(400).json({ error: "Please enter a valid email address" });
    }
    if (!role) {
        return res.status(400).json({ error: "A role must be assigned to the invited user" });
    }

    try {
        const roleResult = await pool.query('SELECT id FROM roles WHERE role_name = $1', [role]);
        if (roleResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid role selected" });
        }
        const roleId = roleResult.rows[0].id;

        // Checked up front so the admin gets a message that says what actually
        // happened, rather than the unique-violation fallback below.
        const existing = await pool.query(
            'SELECT id, status FROM dashboard_users WHERE lower(email) = lower($1)',
            [email]
        );
        if (existing.rows.length > 0) {
            const message = existing.rows[0].status === 'invited'
                ? "This email has already been invited and is waiting for the user to register."
                : "A user with this email already exists.";
            return res.status(409).json({ error: message });
        }

        // The username is generated now rather than at signup, so the
        // invitation email can tell the user what to sign in with. Generation
        // and insert are two steps, so a concurrent invite can take the handle
        // in between -- the unique index is the real guard and this retries
        // around it.
        const MAX_USERNAME_ATTEMPTS = 3;
        let invited = null;

        for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt += 1) {
            const username = await generateUniqueUsername(pool, { email, fullName: full_name });

            try {
                const result = await pool.query(
                    `INSERT INTO dashboard_users
                         (username, email, full_name, role_id, status, invited_at, invited_by, invite_expires_at)
                     VALUES ($1, $2, $3, $4, 'invited', NOW(), $5, NOW() + ($6::int * INTERVAL '1 day'))
                     RETURNING id, username, email, full_name, status, invite_expires_at`,
                    [username, email, full_name || null, roleId, req.session.user.id, INVITE_VALIDITY_DAYS]
                );
                invited = result.rows[0];
                break;
            } catch (e) {
                const usernameTaken = e.code === '23505'
                    && String(e.constraint || '').includes('username');

                if (usernameTaken && attempt < MAX_USERNAME_ATTEMPTS) {
                    console.warn(`Username "${username}" was taken mid-insert, regenerating.`);
                    continue;
                }
                throw e;
            }
        }

        if (!invited) {
            return res.status(500).json({ error: "Could not allocate a username. Please try again." });
        }

        // The row above is what actually grants access, so the invitation
        // stands whether or not the notice reaches them. Report the outcome
        // rather than failing the request -- an admin who knows the email did
        // not go out can pass the link on themselves.
        const mail = await sendInvitationEmail({
            email: invited.email,
            username: invited.username,
            fullName: invited.full_name,
            role,
            expiresAt: invited.invite_expires_at,
        });

        res.status(201).json({
            ...invited,
            emailSent: mail.sent,
            registrationUrl: getRegistrationUrl(),
            message: mail.sent
                ? `Invitation emailed to ${email}. Username: ${invited.username}`
                : `${email} can now register as "${invited.username}", but the email was not sent: `
                  + `${mail.reason} Send them ${getRegistrationUrl()} and their username directly.`,
        });
    } catch (e) {
        console.error("Invite User Error:", e);
        if (e.code === '23505') {
            const { status, error } = uniqueViolationResponse(e, "A user with this email already exists.");
            return res.status(status).json({ error });
        }
        res.status(500).json({ error: "Failed to invite user" });
    }
});

// Re-open an invitation whose window has closed, or extend one still open.
router.post('/users/:id/reinvite', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE dashboard_users
                SET invited_at              = NOW(),
                    invited_by              = $1,
                    invite_expires_at       = NOW() + ($2::int * INTERVAL '1 day'),
                    signup_token_hash       = NULL,
                    signup_token_expires_at = NULL
              WHERE id = $3
                AND status = 'invited'
          RETURNING id, username, email, full_name, invite_expires_at,
                    (SELECT role_name FROM roles WHERE id = dashboard_users.role_id) AS role`,
            [req.session.user.id, INVITE_VALIDITY_DAYS, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "No pending invitation found for this user. Only invited users can be re-invited."
            });
        }

        const renewed = result.rows[0];
        const mail = await sendInvitationEmail({
            email: renewed.email,
            username: renewed.username,
            fullName: renewed.full_name,
            role: renewed.role,
            expiresAt: renewed.invite_expires_at,
        });

        res.json({
            ...renewed,
            emailSent: mail.sent,
            registrationUrl: getRegistrationUrl(),
            message: mail.sent
                ? `Invitation renewed and re-sent to ${renewed.email}.`
                : `Invitation renewed, but the email was not sent: ${mail.reason}`,
        });
    } catch (err) {
        console.error("Re-invite Error:", err);
        res.status(500).json({ error: "Failed to renew the invitation" });
    }
});

// Create a complete user directly, credentials and all.
//
// Kept for the cases the invitation flow does not cover -- service accounts,
// or an admin who would rather hand over a password in person.
//
// The username is generated here the same way it is for an invitation, so the
// admin does not have to invent one; passing an explicit `username` still
// overrides that.
router.post('/users', isAuthenticated, isAdmin, async (req, res) => {
    // We intentionally ignore "permissions" from req.body now
    const { username, password, full_name, email, role } = req.body;

    if (!password) {
        return res.status(400).json({
            error: "A password is required. To let the user set their own, invite them instead."
        });
    }
    if (!username && !email && !full_name) {
        return res.status(400).json({
            error: "Provide an email address or a full name so a username can be generated."
        });
    }

    try {
        // 1. Look up the role_id from the roles table
        const roleResult = await pool.query('SELECT id FROM roles WHERE role_name = $1', [role]);
        if (roleResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid role selected" });
        }
        const roleId = roleResult.rows[0].id;

        const hash = await bcrypt.hash(password, 10);

        // 2. Insert the user using the role_id. Created this way the account is
        //    complete, so it starts out active rather than invited. Generating
        //    and inserting the username are two steps, so retry if a concurrent
        //    create takes the handle in between.
        const MAX_USERNAME_ATTEMPTS = 3;
        let created = null;

        for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt += 1) {
            const handle = (typeof username === 'string' && username.trim() !== '')
                ? username.trim()
                : await generateUniqueUsername(pool, { email, fullName: full_name });

            try {
                const result = await pool.query(
                    `INSERT INTO dashboard_users (username, password_hash, full_name, email, role_id, status, activated_at)
                     VALUES ($1, $2, $3, $4, $5, 'active', NOW())
                     RETURNING id, username, full_name, email`,
                    [handle, hash, full_name || null, email || null, roleId]
                );
                created = result.rows[0];
                break;
            } catch (e) {
                // An explicit username the admin typed is not ours to change,
                // so only a generated one is retried.
                const canRetry = e.code === '23505'
                    && String(e.constraint || '').includes('username')
                    && !username
                    && attempt < MAX_USERNAME_ATTEMPTS;

                if (canRetry) {
                    console.warn(`Username "${handle}" was taken mid-insert, regenerating.`);
                    continue;
                }
                throw e;
            }
        }

        if (!created) {
            return res.status(500).json({ error: "Could not allocate a username. Please try again." });
        }

        // Mail the account its credentials. Best-effort, exactly as for an
        // invitation: the account works either way, and an admin who knows the
        // message did not go out can pass the details on themselves.
        //
        // Note this puts a live password in a mailbox, where it stays. That is
        // the cost of creating accounts this way -- inviting the user instead
        // never sends a secret at all.
        const mail = await sendCredentialsEmail({
            email: created.email,
            username: created.username,
            password,
            fullName: created.full_name,
            role,
        });

        res.json({
            ...created,
            emailSent: mail.sent,
            loginUrl: getLoginUrl(),
            message: mail.sent
                ? `User created. Sign-in details emailed to ${created.email}.`
                : `User "${created.username}" created, but the details were not emailed: `
                  + `${mail.reason} Pass the username and password on yourself.`,
        });
    } catch (e) { 
        console.error(e);
        if (e.code === '23505') {
            const { status, error } = uniqueViolationResponse(e, "That user already exists.");
            return res.status(status).json({ error });
        }
        res.status(400).json({ error: "User already exists or DB error" }); 
    }
}); 

// Update user
//
// SECURITY: this route ran without isAuthenticated/isAdmin, which let anyone
// who could reach the API set any user's password. Both guards are applied
// here as they are on every other route in this file.
router.put('/users/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    // We intentionally ignore "permissions" from req.body now
    const { username, password, full_name, email, role } = req.body;

    try {
        // 1. Look up the role_id from the roles table
        const roleResult = await pool.query('SELECT id FROM roles WHERE role_name = $1', [role]);
        if (roleResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid role selected" });
        }
        const roleId = roleResult.rows[0].id;

        const target = await pool.query('SELECT status FROM dashboard_users WHERE id = $1', [id]);
        if (target.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        // Username and password are optional here: an invited user has neither
        // yet, and blanking them on an ordinary edit would lock the account.
        const setUsername = typeof username === 'string' && username.trim() !== "";
        const setPassword = typeof password === 'string' && password.trim() !== "";

        const assignments = ['full_name = $1', 'email = $2', 'role_id = $3'];
        const values = [full_name, email || null, roleId];

        if (setUsername) {
            values.push(username.trim());
            assignments.push(`username = $${values.length}`);
        }
        if (setPassword) {
            values.push(await bcrypt.hash(password, 10));
            assignments.push(`password_hash = $${values.length}`);
        }

        // Filling in both credentials by hand completes an invitation, so the
        // account graduates to active in the same statement.
        if (target.rows[0].status === 'invited' && setUsername && setPassword) {
            assignments.push("status = 'active'", 'activated_at = NOW()',
                             'signup_token_hash = NULL', 'signup_token_expires_at = NULL');
        }

        values.push(id);
        await pool.query(
            `UPDATE dashboard_users SET ${assignments.join(', ')} WHERE id = $${values.length}`,
            values
        );

        res.json({ message: "User updated successfully" });
    } catch (err) {
        console.error("Update Error:", err);
        if (err.code === '23505') {
            const { status, error } = uniqueViolationResponse(err, "Those details are already taken.");
            return res.status(status).json({ error });
        }
        res.status(500).json({ error: "Database error" });
    }
});

// Enable or disable a user without deleting them.
//
// Disabling is the reversible alternative to a delete: the account keeps its
// history, but routes/auth.js drops the session on the very next request.
router.patch('/users/:id/status', isAuthenticated, isAdmin, async (req, res) => {
    const { status } = req.body;

    if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: "Status must be either 'active' or 'disabled'" });
    }
    if (String(req.session.user.id) === String(req.params.id)) {
        return res.status(400).json({ error: "You cannot change the status of your own account." });
    }

    try {
        // An invited user has no credentials, so there is nothing to enable or
        // disable yet -- the WHERE clause leaves those rows alone.
        //
        // $1 is cast on both uses: without it Postgres infers varchar from the
        // assignment and text from the comparison, then rejects the statement
        // with "inconsistent types deduced for parameter $1".
        const result = await pool.query(
            `UPDATE dashboard_users
                SET status = $1::text,
                    current_session_id = CASE WHEN $1::text = 'disabled'
                                              THEN NULL
                                              ELSE current_session_id END
              WHERE id = $2
                AND status IN ('active', 'disabled')
          RETURNING id, username, status`,
            [status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "User not found, or still waiting to complete their registration."
            });
        }

        res.json({ ...result.rows[0], success: true });
    } catch (err) {
        console.error("Status Update Error:", err);
        res.status(500).json({ error: "Failed to update user status" });
    }
});

// Delete user
router.delete('/users/:id', isAuthenticated, isAdmin, async (req, res) => {
    // Deleting the account you are signed in as would leave the panel with one
    // fewer administrator and no way back in.
    if (String(req.session.user.id) === String(req.params.id)) {
        return res.status(400).json({ error: "You cannot delete your own account." });
    }

    await pool.query('DELETE FROM dashboard_users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});


/******************************* ROLES *********************************/

// List all roles
router.get('/roles', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, role_name, permissions FROM roles ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch roles" });
    }
});

// Create new role
router.post('/roles', isAuthenticated, isAdmin, async (req, res) => {
    const { role_name } = req.body;
    
    if (!role_name || role_name.trim() === "") {
        return res.status(400).json({ error: "Role name is required" });
    }

    try {
        // Create the default empty permissions JSON
        const defaultPermissions = {
            layers: [],
            regions: [],
            features: {}
        };

        const result = await pool.query(
            'INSERT INTO roles (role_name, permissions) VALUES ($1, $2) RETURNING id',
            [role_name.toLowerCase().trim(), JSON.stringify(defaultPermissions)]
        );
        
        res.json({ id: result.rows[0].id, message: "Role created successfully" });
    } catch (err) {
        console.error("Create Role Error:", err);
        // Postgres error 23505 means unique violation (role already exists)
        if (err.code === '23505') {
            const { status, error } = uniqueViolationResponse(err, "A role with this name already exists");
            return res.status(status).json({ error });
        }
        res.status(500).json({ error: "Failed to create role" });
    }
});

// Update role name and/or permissions
router.put('/roles/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { role_name, permissions } = req.body;
    
    try {
        if (role_name && role_name.trim() !== "") {
            await pool.query(
                'UPDATE roles SET role_name = $1 WHERE id = $2', 
                [role_name.toLowerCase().trim(), req.params.id]
            );
        }
        
        if (permissions) {
            await pool.query(
                'UPDATE roles SET permissions = $1 WHERE id = $2', 
                [JSON.stringify(permissions), req.params.id]
            );
        }
        
        res.json({ message: "Role updated successfully" });
    } catch (err) {
        console.error("Role Update Error:", err);
        if (err.code === '23505') {
            const { status, error } = uniqueViolationResponse(err, "A role with this name already exists.");
            return res.status(status).json({ error });
        }
        res.status(500).json({ error: "Failed to update role" });
    }
});

// Delete a role (Protected against deleting 'admin')
router.delete('/roles/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // 1. Check what role is being deleted
        const roleCheck = await pool.query('SELECT role_name FROM roles WHERE id = $1', [req.params.id]);
        
        if (roleCheck.rows.length === 0) {
            return res.status(404).json({ error: "Role not found" });
        }

        if (roleCheck.rows[0].role_name === 'admin') {
            return res.status(400).json({ error: "Security Error: The 'admin' role is protected and cannot be deleted." });
        }

        // 2. Proceed with deletion if it's not admin
        await pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: "Role deleted successfully" });
    } catch (err) {
        console.error("Delete Role Error:", err);
        
        if (err.code === '23503') {
            return res.status(400).json({ 
                error: "Cannot delete this role because users are currently assigned to it. Reassign those users first." 
            });
        }
        
        res.status(500).json({ error: "Failed to fetch or delete role" });
    }
});

// Reassign users to a new role and delete the old role
router.post('/roles/:id/reassign-and-delete', isAuthenticated, isAdmin, async (req, res) => {
    const oldRoleId = req.params.id;
    const { new_role_id } = req.body;

    if (!new_role_id) {
        return res.status(400).json({ error: "Please select a target role to reassign users to." });
    }

    try {
        // 1. Check that the role being deleted isn't admin
        const roleCheck = await pool.query('SELECT role_name FROM roles WHERE id = $1', [oldRoleId]);
        if (roleCheck.rows.length > 0 && roleCheck.rows[0].role_name === 'admin') {
            return res.status(400).json({ error: "Security Error: The 'admin' role cannot be deleted." });
        }

        // 2. Reassign all users from the old role to the new role
        await pool.query(
            'UPDATE dashboard_users SET role_id = $1 WHERE role_id = $2',
            [new_role_id, oldRoleId]
        );

        // 3. Delete the old role
        await pool.query('DELETE FROM roles WHERE id = $1', [oldRoleId]);

        res.json({ success: true, message: "Users reassigned and role deleted successfully." });
    } catch (err) {
        console.error("Reassign & Delete Error:", err);
        res.status(500).json({ error: "Failed to reassign users and delete role." });
    }
});

module.exports = router;