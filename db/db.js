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

const user_session = session({
    store: new pgSession({
      pool: pool,             
      tableName: 'session',   
      createTableIfMissing: false 
    }),
    secret: '123$@8&',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { 
        maxAge: 30 * 60 * 1000, // 30 minutes 
        httpOnly: true, // Set to true so the 30-min timer resets on activity
        secure: false, 
        sameSite: 'lax'
    } 
});

module.exports = {pool, webappPool, user_session}