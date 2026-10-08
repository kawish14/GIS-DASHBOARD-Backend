# GIS Dashboard — Backend reference

What this service is, every route it serves, and which frontend file calls each
one. Written against the code as it stands; every mapping below was taken from
the source rather than from memory.

- **Service:** Node + Express, entry point `server.js`, listening on **port 2000**
- **Database:** PostgreSQL (`db/db.js`), sessions stored in the `session` table
- **Frontend repo:** `GIS-DASHBOARD` — the paths below refer to files in it
- **Start:** `npm install && npm start` (nodemon)
- **Size:** 22 routes across 5 routers, plus `routes/auth.js` (middleware, not a
  router) and 6 helpers in `utils/`. Every route but `GET /admin/logs` has a
  frontend caller — see §3 for what was removed to get here.

---

## 1. Three different servers — only one of them is this one

The frontend reads three base URLs from `public/config.js` via
`src/shared/config/runtimeConfig.js`. They are **not** the same backend, which
matters when tracing a failing request:

| Config key | Variable | Points at | Documented here? |
|---|---|---|---|
| `AUTHENTICATE` | `authenticate` | **This service**, port 2000 | **Yes** |
| `API` | `api` | GeoServer (WMS/WFS/WMTS) | No — separate product |
| `Realtime` | `Realtime` | Realtime/socket server | No — separate service |
| `SUPPORT_URL` / `SUPPORT_EMAIL` | `supportUrl`, `supportEmail` | Service desk for access requests | n/a — frontend only |

So a `${api}/geoserver/...` call in the frontend never reaches this codebase.
Only `${authenticate}/...` does.

---

## 2. Route reference

Mounted in `server.js`:

```js
app.use('/user',  registrationRoutes);   // routes/registration.js
app.use('/user',  passwordResetRoutes);  // routes/password_reset.js
app.use('/user',  userRoutes);           // routes/user_auth.js
app.use('/admin', adminRoutes);          // routes/admin_routes.js
app.use('/nce',   nce);                  // routes/nce_history.js
```

Three routers share the `/user` prefix. Express runs them in the order above,
and their paths do not overlap.

That is the whole surface — **21 routes across 5 routers**, every one of them
called by the frontend. `/map`, `/service`, `/faults` and `/ai` used to be
mounted here too; see §3.

### 2.1 `/user` — sign-in and session · `routes/user_auth.js`

| Method | Path | Guard | Called from |
|---|---|---|---|
| POST | `/user/login` | — | `features/auth/AuthContext.jsx` → `login()` |
| GET | `/user/me` | `isAuthenticated` | `features/auth/AuthContext.jsx` → `checkSession()` |
| POST | `/user/logout` | — | `features/auth/AuthContext.jsx` → `logout()` |
| GET | `/user/active-users` | `isAuthenticated` | `features/sidebars/left/ActiveUsers.jsx` |

`AuthContext` is the only place the app signs in or out. Every screen reads the
user through `useAuth()` — 24 files do, including `app/ProtectedRoute.jsx`,
`features/dashboard/TopBar.jsx` and `features/auth/FeatureGuard.jsx`.

`POST /user/login` takes `{ username, password }` and requires
`status = 'active'`. It refuses a second concurrent session with **403**, and
bad credentials with **401** — the two are indistinguishable on purpose, so the
form cannot be used to discover which usernames exist.

### 2.2 `/user` — invitation sign-up · `routes/registration.js`

| Method | Path | Guard | Called from |
|---|---|---|---|
| POST | `/user/verify-email` | — (rate limited) | `AuthContext.jsx` → `verifyEmail()`, used by `features/auth/RegisterPage.jsx` |
| POST | `/user/complete-signup` | — (rate limited) | `AuthContext.jsx` → `completeSignup()`, used by `RegisterPage.jsx` |

Two steps, in order. Step 1 confirms a GIS Admin pre-registered the address and
returns a **signup token**; step 2 requires that token back. Only the token's
SHA-256 is stored (`dashboard_users.signup_token_hash`), it lasts 15 minutes and
is cleared on use — so those columns are `NULL` except between the two calls.

Step 1 returns **404 `NOT_INVITED`** for an unknown address, which `RegisterPage`
renders as the service-request notice rather than a red error.

### 2.3 `/user` — forgotten passwords · `routes/password_reset.js`

| Method | Path | Guard | Called from |
|---|---|---|---|
| POST | `/user/forgot-password` | — (rate limited) | `AuthContext.jsx` → `requestPasswordReset()`, used by `features/auth/ForgotPasswordPage.jsx` |
| POST | `/user/reset-password` | — (rate limited) | `AuthContext.jsx` → `resetPassword()`, used by `features/auth/ResetPasswordPage.jsx` |

`forgot-password` answers what actually happened:

| Outcome | Status | Code |
|---|---|---|
| No account for that address | 404 | `NOT_REGISTERED` |
| Account disabled | 403 | `ACCOUNT_DISABLED` |
| Invited but never finished — invitation re-sent | 200 | `INVITATION_RESENT` |
| Link sent | 200 | — |
| Mail server refused it | 502 | `MAIL_FAILED` |

The reset token lives in `reset_token_hash` / `reset_token_expires_at`, lasts one
hour, and works once. Completing a reset also clears `current_session_id`, so
changing a password signs the account out everywhere.

### 2.4 `/admin` — user and role administration · `routes/admin_routes.js`

Every route below is guarded by `isAuthenticated, isAdmin`. All but `/admin/logs` are called from
the single file **`features/admin/AdminPage.jsx`**:

| Method | Path | AdminPage function |
|---|---|---|
| GET | `/admin/users` | `fetchUsers()` |
| POST | `/admin/users/invite` | `handleInviteSubmit()` |
| POST | `/admin/users/:id/reinvite` | `handleResendInvite()` |
| POST | `/admin/users` | `handleUserSubmit()` — "Add Directly" |
| PUT | `/admin/users/:id` | `handleUserSubmit()` — edit |
| PATCH | `/admin/users/:id/status` | `handleToggleStatus()` |
| DELETE | `/admin/users/:id` | `handleDeleteUser()` |
| GET | `/admin/roles` | `fetchRoles()` |
| POST | `/admin/roles` | `handleCreateRole()` |
| PUT | `/admin/roles/:id` | `handleSaveRole()` |
| DELETE | `/admin/roles/:id` | `executeDirectDelete()` |
| POST | `/admin/roles/:id/reassign-and-delete` | `handleConfirmReassignAndDelete()` |
| GET | `/admin/logs` | *not called yet* — reads the activity log, see §5.3 |

`POST /admin/users/invite` and `POST /admin/users` both generate the username
(see `utils/usernameGenerator.js`) and send an email. Neither fails if the mail
does not go out — the response carries `emailSent` so the panel can say so.

### 2.5 `/nce` — alarm diagnostics · `routes/nce_history.js`

| Method | Path | Guard | Called from |
|---|---|---|---|
| POST | `/nce/nce-history/advanced-analytics` | `isAuthenticated` | `features/filters/widgets/AlarmAnalyticsFilter.jsx` |

The only route here that had a caller. It reads `webappPool`, not `pool` — see
§5.1.

---

## 3. What was removed, and how to get it back

Everything below had **no caller in the frontend** and has been deleted. Recover
any of it from git history — commit `65ad5ce` is the last one that still has all
of the files.

| Removed | Was | Why |
|---|---|---|
| `routes/layers.js` | GET `/map/layers` | No caller. The frontend gets layers from GeoServer via `${api}`. |
| `routes/customer_service.js` | 4 routes under `/service` | No caller |
| `routes/faultplayback.js` | POST `/faults/histogram`, `/faults/hotspots` | No caller |
| `routes/gemini.js` | POST `/ai/chat` | Never mounted; its widget was never rendered |
| `routes/sessionEnforcer.js` | absolute-timeout middleware | Its `require` was commented out, so it never ran |
| 3 of 4 routes in `nce_history.js` | GET `/nce-history`, POST `/nce-history/lop-repeats`, GET `/nce-history/customer/:alias` | No caller |
| `data/sessions.sqlite` | old session store | Sessions moved to Postgres |
| 9 npm packages | `sqlite3`, `better-sqlite3`, `connect-sqlite3`, `express-session-sqlite`, `session-file-store`, `node-cron`, `node-fetch`, `xmldom`, `@google/generative-ai` | Nothing required them. The two SQLite builds are native, so removing them speeds `npm install` noticeably. |

`jobs/cleanupSessions.js` was also unused, but it has been **wired in rather
than deleted** — `server.js` now calls `startSessionCleanupJob()` at boot. It
clears `current_session_id` values pointing at session rows that no longer
exist, which is the state that locks a user out with "you're already logged in
elsewhere" and no session to log out of. Delete the call if you would rather
not have it.

---

## 4. File map

### Entry and infrastructure

| File | Purpose | Required by |
|---|---|---|
| `server.js` | dotenv, CORS allowlist, session middleware, route mounts, listens on 2000 | — |
| `db/db.js` | Two Postgres pools and the `express-session` store — see 5.1 | every route file, `jobs/cleanupSessions.js` |
| `routes/auth.js` | `isAuthenticated` and `isAdmin` middleware. Not a router. | `user_auth`, `admin_routes`, `nce_history` |
| `jobs/cleanupSessions.js` | Clears `current_session_id` values pointing at sessions that no longer exist. Runs at boot and every 15 min. | `server.js` |

`isAuthenticated` does more than check the cookie: it re-reads the user each
request and rejects if `status` is no longer `active`, or if
`current_session_id` no longer matches this session — which is how signing in
elsewhere ejects the older session.

### Routers

| File | Mount | Frontend consumer |
|---|---|---|
| `routes/user_auth.js` | `/user` | `features/auth/AuthContext.jsx`, `features/sidebars/left/ActiveUsers.jsx` |
| `routes/registration.js` | `/user` | `features/auth/AuthContext.jsx` → `RegisterPage.jsx` |
| `routes/password_reset.js` | `/user` | `features/auth/AuthContext.jsx` → `ForgotPasswordPage.jsx`, `ResetPasswordPage.jsx` |
| `routes/admin_routes.js` | `/admin` | `features/admin/AdminPage.jsx` |
| `routes/nce_history.js` | `/nce` | `features/filters/widgets/AlarmAnalyticsFilter.jsx` |

Every router is mounted and every one has a caller. Nothing here is dead.

### Helpers (`utils/`)

| File | Purpose | Used by |
|---|---|---|
| `usernameGenerator.js` | Derives a unique handle from the email local part, falling back to the full name. Duplicates get a two-digit suffix with no separator: `kawish.mehdi`, `kawish.mehdi02`. Reserved names (`admin`, `root`, …) are never handed out. | `admin_routes.js`, `registration.js` |
| `password.js` | bcrypt hashing (cost 10) and the strength policy the register and reset screens mirror | `registration.js`, `password_reset.js` |
| `tokens.js` | Random tokens, SHA-256 storage, timing-safe comparison, expiry check | `registration.js`, `password_reset.js` |
| `rateLimiter.js` | Fixed-window limiter for the unauthenticated endpoints, with `refundRateLimit` so a mistyped password is not charged like a guessed token | `registration.js`, `password_reset.js` |
| `activityLog.js` | `logActivity(req, action, …)` writes one row to `user_logs`; `ACTIONS` lists every action name. Never throws. Also deletes rows past the retention period. | every router, `routes/auth.js`, `server.js` |
| `mailer.js` | The three outgoing emails: invitation, credentials, password reset. Never throws — returns `{ sent, reason }`. | `admin_routes.js`, `password_reset.js` |

---

## 5. Data and sessions

### 5.1 Two databases, two pools

`db/db.js` exports **two** connection pools against different databases. Which
one a route uses tells you what kind of data it touches:

| Pool | Database | User | Holds | Used by |
|---|---|---|---|---|
| `pool` | `postgres` | `postgres` | `dashboard_users`, `roles`, `session` | `user_auth`, `registration`, `password_reset`, `admin_routes`, `auth`, `jobs/cleanupSessions` |
| `webappPool` | `webapp` | `webapp` | GIS/network operational data | `nce_history` |

The session store is on `pool`. Credentials for both are currently **hardcoded
in `db/db.js`** rather than read from `.env`.

### 5.2 Account status

`dashboard_users.status` drives everything (see `schema.txt`):

| Status | Meaning |
|---|---|
| `invited` | Pre-registered by an admin. Has a username, no password. Cannot sign in. |
| `active` | Normal account. |
| `disabled` | Retained but blocked; `isAuthenticated` drops the session on the next request. |

CHECK constraints enforce that an `active` row has both a username and a password
hash, and that an `invited` row has an email. Emails are unique
case-insensitively (`dashboard_users_email_lower_key`); usernames are unique
**case-sensitively**, so `ali.raza` and `Ali.Raza` could both exist if an admin
types one by hand — the generator only ever emits lowercase.

**One live session per account.** Login records `current_session_id`; a second
device is refused with 403. Tabs in one browser share the cookie, so they share
the session and need no second sign-in.

### 5.3 User activity log

Every sign-in (successful or failed), sign-out, registration, password reset,
admin-panel change and alarm-analytics query writes one row to **`user_logs`**
(table in `schema.txt`), through `utils/activityLog.js`.

**Why a table and not a `.log` file:** the point of the log is to ask it
questions later: failed sign-ins per account, who disabled a user, the busiest
hours. In Postgres that is a `WHERE`/`GROUP BY` with indexes, it can be served to
the admin panel (`GET /admin/logs`), and it joins to `dashboard_users`. A text
file would have to be rotated, parsed and grepped for the same answers.
Errors and debug output still go to the console.

| Column | Holds |
|---|---|
| `created_at` | When |
| `user_id`, `username` | Who. `username` is a copy taken at the time, so it survives the account being deleted (`user_id` becomes `NULL`). |
| `action` | `<area>.<event>`, e.g. `auth.login`, `admin.user_delete`. The full list is `ACTIONS` in `utils/activityLog.js`. |
| `status` | `success` or `failure` |
| `ip_address`, `device`, `user_agent` | Where from. `device` is the readable label, e.g. `Chrome on Windows`. |
| `details` | JSON for anything action-specific: the failure `reason`, the `target_user_id` of an admin change, the filters used. Passwords and tokens are never logged. |

To log something new: add a name to `ACTIONS`, then call
`logActivity(req, ACTIONS.YOUR_ACTION, { details: { … } })` where it happens.
Pass `status: 'failure'` for a refusal, and `user` when there is no signed-in
session to take it from.

Logging is fire-and-forget: a failed insert prints `[user-log] could not record …`
and the request carries on, so a broken log never stops anyone signing in.

`schema.txt` ends with example queries for common patterns.

---

## 6. Configuration

`.env` is gitignored — `.env.example` lists every key.

| Key | Purpose |
|---|---|
| `PORT` | Port to listen on. Defaults to 2000. |
| `APP_BASE_URL` | Where the dashboard is served. Emails link to `<this>/register` and `<this>/reset-password`. Defaults to `http://gis.tes.com.pk:5001`. |
| `SMTP_HOST` / `PORT` / `SECURE` / `USER` / `PASS` | Mail server. Leave `SMTP_HOST` blank and invitations still work — the admin panel shows the link to pass on by hand. |
| `MAIL_FROM` | `From:` header |
| `USER_LOG_RETENTION_DAYS` | Days to keep `user_logs` rows; older ones are deleted daily. Default 365, `0` keeps them forever. |

`server.js` also holds a hardcoded CORS allowlist. A new frontend origin has to
be added there or the browser will block it.

---

## 7. Known gaps

1. **No absolute session timeout.** `routes/sessionEnforcer.js` implemented one
   but was never wired in, and has been deleted. Only the rolling 30-minute
   cookie expiry applies, so an active user's session renews indefinitely.
   Recover the file from git history if you want a hard cap.
2. **No self-service password change.** A signed-in user who wants a new
   password has to go through `/forgot-password`. That is why those two routes
   stay reachable while signed in.
3. **`req.ip` behind a proxy.** The rate limiters key on `req.ip`, which is the
   socket address. If this service is ever put behind nginx, set
   `app.set('trust proxy', 1)` or every request will look like one caller and
   the limits will throttle everyone at once.
4. **`.env` was committed** before it was gitignored. The `GEMINI_API_KEY` in
   that history should be treated as exposed and rotated.
5. **Database credentials are hardcoded** in `db/db.js` for both pools, rather
   than read from `.env` like the SMTP settings. Moving them would keep them out
   of the repository.
