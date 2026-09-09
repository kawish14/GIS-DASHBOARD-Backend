/**
 * Auto-generation of dashboard usernames for invitation-based signups.
 *
 * An invited user has no username until they complete registration -- at that
 * point we derive one for them, because asking a user to invent a unique
 * handle is the step most signup flows lose people on.
 *
 * The shape we aim for is "firstname.lastname" (derived from the email local
 * part, falling back to the full name), with a two-digit number appended only
 * when that handle is already taken -- kawish.mehdi, then kawish.mehdi02. Callers must still be prepared for a unique
 * violation on insert: generation and insert are two steps, so a concurrent
 * signup can claim the same handle in between. See routes/registration.js for
 * the retry loop.
 */

// The username column is varchar(50). We reserve room for a suffix so an
// appended ".12" or ".k4f9" can never overflow it.
const MAX_USERNAME_LENGTH = 50;
const MAX_BASE_LENGTH = 40;
const MIN_BASE_LENGTH = 3;

// Handles nobody should be able to claim through self-registration, either
// because they are privileged, or because they read as system accounts.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'superuser', 'system', 'sysadmin',
  'postgres', 'operator', 'security', 'support', 'help', 'helpdesk',
  'gis', 'gisadmin', 'webmaster', 'noreply', 'no-reply', 'test',
  'guest', 'anonymous', 'user', 'api', 'null', 'undefined', 'me',
]);

/**
 * Strip an arbitrary string down to something usable as a handle:
 * accents folded to ASCII, lowercased, and every run of non-alphanumerics
 * collapsed into a single dot.
 */
function normalizeToHandle(raw) {
  if (!raw) return '';

  return String(raw)
    .normalize('NFKD')              // "José" -> "Jose" + combining accent
    .replace(/[\u0300-\u036f]/g, '')  // drop the combining accents it split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')     // any separator becomes a dot
    .replace(/\.{2,}/g, '.')         // collapse runs of dots
    .replace(/^\.+|\.+$/g, '')       // no leading/trailing dots
    .slice(0, MAX_BASE_LENGTH)
    .replace(/\.+$/, '');            // slicing may have left a trailing dot
}

/**
 * Pick the base handle for a user: the email local part when it is usable,
 * otherwise their full name, otherwise a generic stem.
 *
 * Email prefixes such as "info+gis" or "j.doe" normalize cleanly; purely
 * numeric or very short ones ("hr", "12345") do not read as a person, so we
 * prefer the full name in that case.
 */
function deriveBaseHandle({ email, fullName }) {
  const localPart = typeof email === 'string' ? email.split('@')[0] : '';
  const fromEmail = normalizeToHandle(localPart);
  const fromName = normalizeToHandle(fullName);

  const emailIsUsable =
    fromEmail.length >= MIN_BASE_LENGTH && /[a-z]/.test(fromEmail) && !/^\d+$/.test(fromEmail);

  if (emailIsUsable) return fromEmail;
  if (fromName.length >= MIN_BASE_LENGTH) return fromName;
  if (fromEmail.length > 0) return fromEmail.padEnd(MIN_BASE_LENGTH, '0');

  return 'user';
}

/**
 * Generate a username that is free at the time of the call.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db  pool, or the client
 *        of the surrounding transaction
 * @param {{email?: string, fullName?: string}} identity
 * @returns {Promise<string>}
 */
async function generateUniqueUsername(db, { email, fullName } = {}) {
  const base = deriveBaseHandle({ email, fullName });

  // One round trip for every handle that could collide with ours, rather than
  // a query per candidate. LIKE is escaped because dots are literal here but
  // '%' and '_' in a derived handle would not be.
  const likePattern = `${base.replace(/([\\%_])/g, '\\$1')}%`;
  const { rows } = await db.query(
    `SELECT lower(username) AS username
       FROM dashboard_users
      WHERE username IS NOT NULL
        AND lower(username) LIKE $1 ESCAPE '\\'`,
    [likePattern]
  );

  const taken = new Set(rows.map((r) => r.username));
  const isFree = (candidate) =>
    !taken.has(candidate) &&
    !RESERVED_USERNAMES.has(candidate) &&
    candidate.length <= MAX_USERNAME_LENGTH;

  if (isFree(base)) return base;

  // kawish.mehdi -> kawish.mehdi02 -> kawish.mehdi03 ...
  //
  // The number runs straight on with no separator: a second dot before it
  // ("kawish.mehdi.2") reads like part of the name rather than a disambiguator.
  // Two digits are padded so the handles line up; past 99 the number simply
  // grows, which still fits varchar(50) against a 40-character base.
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}${String(suffix).padStart(2, '0')}`;
    if (isFree(candidate)) return candidate;
  }

  // A thousand people sharing one base handle is not a real scenario, but the
  // caller must always get a name back rather than an exception. Base 36 of a
  // millisecond timestamp is unique by construction and still digit-and-letter
  // only, so it cannot be mistaken for part of the name either.
  return `${base}${Date.now().toString(36)}`;
}

module.exports = {
  generateUniqueUsername,
  deriveBaseHandle,
  normalizeToHandle,
  RESERVED_USERNAMES,
};
