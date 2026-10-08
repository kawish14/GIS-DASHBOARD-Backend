const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'Gis@123',
  port: 5432,
});

const webappPool = new Pool({
  user: 'webapp',
  host: 'localhost',
  database: 'webapp', // Pointing to the new database
  password: 'Gis@110',
  port: 5432,
});

// Signed out after this long with no requests. jobs/cleanupSessions.js uses it
// to work out when an expired session was last active.
const SESSION_IDLE_MS = 30 * 60 * 1000;

const user_session = session({
    store: new pgSession({
      pool: pool,             
      tableName: 'session',   
      createTableIfMissing: false,
      // Expired sessions are removed by jobs/cleanupSessions.js instead, which
      // logs each one as auth.session_timeout on the way out.
      pruneSessionInterval: false
    }),
    secret: '123$@8&',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { 
        maxAge: SESSION_IDLE_MS,
        httpOnly: true, // Set to true so the 30-min timer resets on activity
        secure: false, 
        sameSite: 'lax'
    } 
});

module.exports = {pool, webappPool, user_session, SESSION_IDLE_MS}