// Must run before anything reads process.env -- db/db.js and utils/mailer.js
// both do, at require time.
require('dotenv').config();

const express = require('express');
const path = require("path");
const cors = require('cors');
const { user_session } = require('./db/db');
const userRoutes = require('./routes/user_auth');
const registrationRoutes = require('./routes/registration');
const passwordResetRoutes = require('./routes/password_reset');
const adminRoutes = require('./routes/admin_routes');
const nce = require('./routes/nce_history');
const { startSessionCleanupJob } = require('./jobs/cleanupSessions');
const { startLogRetentionJob } = require('./utils/activityLog');

const allowedOrigins = [
  'http://localhost:5173',
  'http://172.29.100.28:5173', // Add your network IP here
  'http://172.29.100.28:5000' ,
  'http://gis.tes.com.pk:5001',
  'http://172.29.100.28:4173',

];

const app = express();

app.use(express.json());

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true, // Required for sessions
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static(path.join(__dirname, "public")));

// 1. Session Middleware
app.use(user_session);

// The whole auth surface lives under /user: sign-in and session
// (user_auth), invitation sign-up (registration), and password reset.
// Three routers, one prefix, no overlapping paths.
app.use('/user', registrationRoutes);
app.use('/user', passwordResetRoutes);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);
app.use('/nce', nce);

// Clears current_session_id values pointing at session rows that no longer
// exist. Without it those dangling pointers leave a user locked out by
// "you're already logged in elsewhere" with no session left to log out of.
startSessionCleanupJob();

// Deletes user_logs rows older than USER_LOG_RETENTION_DAYS (default 365).
startLogRetentionJob();

const PORT = Number(process.env.PORT) || 2000;
app.listen(PORT, () => {
    console.log(`🚀 Server is flying on http://localhost:${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Try killing the process or using another port.`);
    } else {
        console.error('❌ Server error:', err);
    }
})