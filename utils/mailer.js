/**
 * Outgoing mail: the invitation notice, the credentials handed out when an
 * admin creates a complete account rather than inviting one, and the password
 * reset link.
 *
 * Sending is deliberately best-effort: an invitation is a row in the database,
 * and that row is what actually grants access. If the mail server is down or
 * misconfigured, the invitation must still stand -- the admin can pass the
 * link on by hand. So nothing in here throws; every function reports what
 * happened and lets the caller decide what to tell the user.
 *
 * Configure through .env (see .env.example):
 *
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 *   MAIL_FROM       the From: header, e.g. "GIS Dashboard <no-reply@tes.com.pk>"
 *   APP_BASE_URL    where the dashboard is served, e.g. http://172.29.100.28:5173
 *
 * With SMTP_HOST unset, mail is skipped rather than attempted, and the admin
 * panel says so instead of pretending an email went out.
 */
const nodemailer = require('nodemailer');

// Where the invited user goes to finish registering. The route is declared in
// the frontend's app/App.jsx.
const REGISTER_PATH = '/register';
const LOGIN_PATH = '/login';

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://gis.tes.com.pk:5001/').replace(/\/+$/, '');

let cachedTransport;

function isMailConfigured() {
    return Boolean(process.env.SMTP_HOST);
}

function getRegistrationUrl() {
    return `${APP_BASE_URL}${REGISTER_PATH}`;
}

function getLoginUrl() {
    return `${APP_BASE_URL}${LOGIN_PATH}`;
}

function getTransport() {
    if (cachedTransport) return cachedTransport;

    cachedTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        // true for implicit TLS on 465; false for 587, which upgrades with
        // STARTTLS after connecting.
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
        // The admin is waiting on this request, so fail fast rather than
        // leaving the panel spinning on an unreachable server.
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000,
    });

    return cachedTransport;
}

/** Values from the database end up inside an HTML document. */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(value) {
    if (!value) return null;
    return new Date(value).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
    });
}

/**
 * The chrome every message shares: a 560px card with the dark TES header.
 *
 * Inline styles and table-based buttons throughout, because email clients
 * strip <style> blocks and Outlook ignores padding on anchors.
 */
function renderShell(subtitle, bodyHtml) {
    return `
<div style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <tr>
      <td style="background:#0f1115;padding:24px 32px;">
        <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.3px;">TES GIS Dashboard</div>
        <div style="color:#94a3b8;font-size:13px;margin-top:4px;">${escapeHtml(subtitle)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;color:#1e293b;font-size:15px;line-height:1.6;">
${bodyHtml}
      </td>
    </tr>
  </table>
</div>`.trim();
}

/** A label/value row inside the highlighted details panel. */
function detailRow(label, value, { mono = true, large = false } = {}) {
    return `<div style="margin-bottom:12px;">
                <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(label)}</div>
                <div style="color:#0f172a;font-size:${large ? '17px' : '15px'};${large ? 'font-weight:700;' : ''}${mono ? 'font-family:Consolas,Menlo,monospace;' : ''}margin-top:3px;word-break:break-all;">${escapeHtml(value)}</div>
              </div>`;
}

/** The grey panel that holds the sign-in details. */
function detailsPanel(rowsHtml) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 26px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
          <tr><td style="padding:18px 20px 6px;">${rowsHtml}</td></tr>
        </table>`;
}

/** The primary call-to-action button. */
function ctaButton(href, label) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
          <tr>
            <td style="background:#2563eb;border-radius:8px;">
              <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${escapeHtml(label)}</a>
            </td>
          </tr>
        </table>`;
}

function buildInvitationBody({ email, username, fullName, role, expiresAt }) {
    const url = getRegistrationUrl();
    const greeting = fullName ? `Hello ${fullName},` : 'Hello,';
    const expiry = formatDate(expiresAt);

    const steps = [
        `Open ${url}`,
        `Enter your email address: ${email}`,
        'Choose a password. That is the only thing left to set.',
    ];

    const text = [
        greeting,
        '',
        'An account has been created for you on the TES GIS Dashboard.',
        '',
        'Your sign-in details:',
        '',
        username ? `  Username: ${username}` : null,
        `  Email:    ${email}`,
        '',
        'Set your password to activate the account:',
        '',
        ...steps.map((step, i) => `  ${i + 1}. ${step}`),
        '',
        expiry ? `This invitation is valid until ${expiry}.` : null,
        '',
        'If you were not expecting this email, please contact your GIS Admin.',
        '',
        '— TES GIS Dashboard',
    ].filter((line) => line !== null).join('\n');

    const html = renderShell('Account invitation', `
        <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;">An account has been created for you on the TES GIS Dashboard. Your sign-in details are below &mdash; all that is left is to set a password.</p>

        ${detailsPanel(
            (username ? detailRow('Username', username, { large: true }) : '')
            + detailRow('Email', email)
        )}

        ${ctaButton(url, 'Set your password')}

        <ol style="margin:0 0 24px;padding-left:20px;color:#334155;">
          <li style="margin-bottom:8px;">Open <a href="${escapeHtml(url)}" style="color:#2563eb;">${escapeHtml(url)}</a></li>
          <li style="margin-bottom:8px;">Enter your email address: <strong style="color:#0f172a;">${escapeHtml(email)}</strong></li>
          <li>Choose a password. That is the only thing left to set.</li>
        </ol>
        ${expiry ? `<p style="margin:0 0 24px;color:#475569;font-size:14px;">This invitation is valid until <strong style="color:#0f172a;">${escapeHtml(expiry)}</strong>.</p>` : ''}

        <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:13px;">
          If you were not expecting this email, please contact your GIS Admin.
        </p>`);

    return { text, html };
}

/**
 * The message for an account an admin created outright, password and all.
 *
 * This one carries a live password, which is why the invitation flow is the
 * better default: there, nothing secret ever goes through the mail. Use this
 * only when handing someone a ready-made account is genuinely what is wanted,
 * and tell them plainly that the password is now sitting in their inbox.
 */
function buildCredentialsBody({ email, username, password, fullName, role }) {
    const url = getLoginUrl();
    const greeting = fullName ? `Hello ${fullName},` : 'Hello,';

    const text = [
        greeting,
        '',
        'An account has been created for you on the TES GIS Dashboard.',
        '',
        'Your sign-in details:',
        '',
        `  Username: ${username}`,
        `  Password: ${password}`,
        `  Email:    ${email}`,
        '',
        `Sign in at ${url}`,
        '',
        `Use the username above (${username}) to sign in, not your email address.`,
        '',
        role ? `Your access level: ${role}` : null,
        '',
        'For your security: this password was sent by email, so treat it as',
        'temporary and ask your GIS Admin to change it once you have signed in.',
        'Delete this message afterwards.',
        '',
        'If you were not expecting this email, please contact your GIS Admin.',
        '',
        '— TES GIS Dashboard',
    ].filter((line) => line !== null).join('\n');

    const html = renderShell('Your account details', `
        <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;">An account has been created for you on the TES GIS Dashboard. You can sign in straight away with the details below.</p>

        ${detailsPanel(
            detailRow('Username', username, { large: true })
            + detailRow('Password', password, { large: true })
            + detailRow('Email', email)
        )}

        ${ctaButton(url, 'Sign in to the dashboard')}

        <p style="margin:0 0 8px;color:#475569;font-size:14px;">Sign in with <strong style="color:#0f172a;">${escapeHtml(username)}</strong>, not with your email address.</p>
        ${role ? `<p style="margin:0 0 8px;color:#475569;font-size:14px;">Your access level: <strong style="color:#0f172a;">${escapeHtml(role)}</strong></p>` : ''}

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
          <tr>
            <td style="padding:14px 16px;color:#92400e;font-size:13px;line-height:1.55;">
              <strong>Keep this safe.</strong> This password arrived by email, so treat it as temporary &mdash; ask your GIS Admin to change it once you have signed in, then delete this message.
            </td>
          </tr>
        </table>

        <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:13px;">
          If you were not expecting this email, please contact your GIS Admin.
        </p>`);

    return { text, html };
}

/**
 * The password reset message.
 *
 * The link carries a one-time token, so this is the one place a reset can be
 * started from -- which is also why the username is repeated here: someone who
 * has forgotten their password has usually forgotten a generated username too.
 */
function buildPasswordResetBody({ email, username, fullName, resetUrl, expiresAt }) {
    const greeting = fullName ? `Hello ${fullName},` : 'Hello,';
    const expiry = formatDate(expiresAt);
    const expiryTime = expiresAt
        ? new Date(expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : null;
    const validUntil = expiry && expiryTime ? `${expiryTime} on ${expiry}` : null;

    const text = [
        greeting,
        '',
        'Someone asked to reset the password on your TES GIS Dashboard account.',
        '',
        username ? `Your username is: ${username}` : null,
        username ? '' : null,
        'Open this link to choose a new password:',
        '',
        `  ${resetUrl}`,
        '',
        validUntil ? `The link stops working at ${validUntil}, and can only be used once.` : null,
        '',
        'If you did not ask for this, you can ignore this email — your password',
        'has not changed. Tell your GIS Admin if you keep receiving these.',
        '',
        '— TES GIS Dashboard',
    ].filter((line) => line !== null).join('\n');

    const html = renderShell('Password reset', `
        <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;">Someone asked to reset the password on your TES GIS Dashboard account. Choose a new one using the link below.</p>

        ${username ? detailsPanel(detailRow('Your username', username, { large: true })) : ''}

        ${ctaButton(resetUrl, 'Choose a new password')}

        <p style="margin:0 0 8px;color:#475569;font-size:13px;">Or paste this into your browser:</p>
        <p style="margin:0 0 20px;font-size:13px;word-break:break-all;"><a href="${escapeHtml(resetUrl)}" style="color:#2563eb;">${escapeHtml(resetUrl)}</a></p>

        ${validUntil ? `<p style="margin:0 0 8px;color:#475569;font-size:14px;">The link stops working at <strong style="color:#0f172a;">${escapeHtml(validUntil)}</strong>, and can only be used once.</p>` : ''}

        <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:13px;">
          If you did not ask for this, you can ignore this email &mdash; your password has not changed.
          Tell your GIS Admin if you keep receiving these.
        </p>`);

    return { text, html };
}

/**
 * Send the invitation notice.
 *
 * Resolves with { sent, reason } and never rejects -- the caller is in the
 * middle of an admin request that has already succeeded.
 *
 * @param {{email: string, username?: string, fullName?: string, role?: string,
 *          expiresAt?: Date|string}} invitation
 */
async function sendInvitationEmail(invitation) {
    if (!isMailConfigured()) {
        return { sent: false, reason: 'SMTP is not configured on the server.' };
    }

    const { text, html } = buildInvitationBody(invitation);

    try {
        await getTransport().sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to: invitation.email,
            // Plain ASCII: an em dash here forces the whole header into RFC 2047
            // encoded-word form, which is correct but needlessly opaque in a
            // mailbox list and in logs.
            subject: 'Set your password for the TES GIS Dashboard',
            text,
            html,
        });

        console.log(`Invitation email sent to ${invitation.email}`);
        return { sent: true };
    } catch (err) {
        // Logged in full here; the caller only passes the short reason on, so
        // SMTP internals do not reach the browser.
        console.error(`Invitation email to ${invitation.email} failed:`, err);
        return { sent: false, reason: 'The mail server rejected the message or could not be reached.' };
    }
}

/**
 * Send the credentials for an account created directly by an admin.
 *
 * Same contract as sendInvitationEmail: resolves with { sent, reason }, never
 * rejects, and never logs the password.
 *
 * @param {{email: string, username: string, password: string, fullName?: string,
 *          role?: string}} account
 */
async function sendCredentialsEmail(account) {
    if (!account.email) {
        return { sent: false, reason: 'No email address was set for this user.' };
    }
    if (!isMailConfigured()) {
        return { sent: false, reason: 'SMTP is not configured on the server.' };
    }

    const { text, html } = buildCredentialsBody(account);

    try {
        await getTransport().sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to: account.email,
            subject: 'Your TES GIS Dashboard account details',
            text,
            html,
        });

        // Deliberately logs the recipient only. The password must not reach a
        // log file, and nodemailer errors below are logged without the body.
        console.log(`Account details emailed to ${account.email}`);
        return { sent: true };
    } catch (err) {
        console.error(`Account details email to ${account.email} failed:`, err.message);
        return { sent: false, reason: 'The mail server rejected the message or could not be reached.' };
    }
}

/**
 * Send the password reset link.
 *
 * Same contract as the others: resolves with { sent, reason }, never rejects.
 *
 * @param {{email: string, username?: string, fullName?: string, resetUrl: string,
 *          expiresAt?: Date|string}} request
 */
async function sendPasswordResetEmail(request) {
    if (!isMailConfigured()) {
        return { sent: false, reason: 'SMTP is not configured on the server.' };
    }

    const { text, html } = buildPasswordResetBody(request);

    try {
        await getTransport().sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to: request.email,
            subject: 'Reset your TES GIS Dashboard password',
            text,
            html,
        });

        console.log(`Password reset email sent to ${request.email}`);
        return { sent: true };
    } catch (err) {
        // err.message only: the body carries the reset link, and a link in a
        // log file is as good as the password itself.
        console.error(`Password reset email to ${request.email} failed:`, err.message);
        return { sent: false, reason: 'The mail server rejected the message or could not be reached.' };
    }
}

module.exports = {
    sendInvitationEmail,
    sendCredentialsEmail,
    sendPasswordResetEmail,
    isMailConfigured,
    getRegistrationUrl,
    getLoginUrl,
};
