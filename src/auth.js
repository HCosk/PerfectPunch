// User auth and session helpers
const path = require("node:path");
const crypto = require("node:crypto");

const { execute, query } = require("./db");
const config = require("./config");

function getAppRedirectTarget(req, targetPath) {
  // Build a proxy-safe redirect target
  const normalizedTarget = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  if (config.basePath) {
    return config.withBasePath(normalizedTarget);
  }
  // Fall back to relative redirect
  const sourceDir = path.posix.dirname(req.path || "/");
  const relativeTarget = path.posix.relative(sourceDir, normalizedTarget);
  return relativeTarget || ".";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  // Salted scrypt password hash
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  // Constant-time scrypt verification
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) {
    return false;
  }
  const derived = crypto.scryptSync(password, salt, 64);
  const source = Buffer.from(hash, "hex");
  return source.length === derived.length && crypto.timingSafeEqual(source, derived);
}

function normalizeEmail(email) {
  // Lowercase and trim email
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  // Lowercase and trim username
  return String(username || "").trim().toLowerCase();
}

function parseCookies(cookieHeader = "") {
  // Parse the Cookie header
  return String(cookieHeader)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }
      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function validatePasswordStrength(password) {
  // Minimum allowed password length
  return String(password || "").length >= 8;
}

async function createUser({ username, email, password, jabArm }) {
  // Register a brand-new user account
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const selectedArm = jabArm === "left" ? "left" : "right";

  // Validate user-supplied fields
  if (!/^[a-z0-9_-]{3,30}$/.test(normalizedUsername)) {
    throw new Error("Username must be 3-30 characters using letters, numbers, hyphens, or underscores.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }
  if (!validatePasswordStrength(password)) {
    throw new Error("Password must be at least 8 characters long.");
  }

  // Reject duplicate username or email
  const existingRows = await query(
    "SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1",
    [normalizedUsername, normalizedEmail]
  );
  if (existingRows.length) {
    throw new Error("That username or email is already in use.");
  }

  // Insert new user record
  const passwordHash = hashPassword(password);
  const result = await execute(
    "INSERT INTO users (username, email, password_hash, jab_arm) VALUES (?, ?, ?, ?)",
    [normalizedUsername, normalizedEmail, passwordHash, selectedArm]
  );

  // Return the inserted row
  const rows = await query(
    "SELECT id, username, email, jab_arm, created_at FROM users WHERE id = ? LIMIT 1",
    [result.insertId]
  );
  return rows[0];
}

async function findUserByLogin(login) {
  // Look up by username or email
  const value = String(login || "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  const rows = await query(
    "SELECT id, username, email, password_hash, jab_arm, created_at FROM users WHERE username = ? OR email = ? LIMIT 1",
    [value, value]
  );
  return rows[0] || null;
}

async function authenticateUser(login, password) {
  // Verify credentials and return user
  const user = await findUserByLogin(login);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return null;
  }
  return user;
}

async function createAuthSession(userId) {
  // Issue a fresh session token
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + config.cookieMaxAgeMs);
  // Sweep out expired sessions
  await execute("DELETE FROM auth_sessions WHERE expires_at <= UTC_TIMESTAMP()");
  await execute(
    "INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt]
  );
  return { token, expiresAt };
}

async function destroyAuthSession(rawToken) {
  // Revoke a single session token
  if (!rawToken) {
    return;
  }
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await execute("DELETE FROM auth_sessions WHERE token_hash = ?", [tokenHash]);
}

async function findUserFromToken(rawToken) {
  // Resolve the user behind a token
  if (!rawToken) {
    return null;
  }
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const rows = await query(
    `SELECT
        users.id,
        users.username,
        users.email,
        users.jab_arm,
        auth_sessions.id AS auth_session_id
      FROM auth_sessions
      INNER JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ?
        AND auth_sessions.expires_at > UTC_TIMESTAMP()
      LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function attachCurrentUser(req, res, next) {
  // Middleware to populate req.user
  try {
    const cookies = parseCookies(req.headers.cookie);
    const rawToken = cookies[config.cookieName];
    req.authToken = rawToken || null;
    req.user = rawToken ? await findUserFromToken(rawToken) : null;
    res.locals.currentUser = req.user;
    next();
  } catch (error) {
    next(error);
  }
}

function persistSessionCookie(res, token) {
  // Send the session cookie back
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: config.cookieMaxAgeMs,
    path: config.basePath || "/"
  });
}

function clearSessionCookie(res) {
  // Wipe the session cookie out
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: config.basePath || "/"
  });
}

function requireAuth(req, res, next) {
  // Gate route on authenticated user
  if (!req.user) {
    // API requests get JSON 401
    const isApiRequest = req.originalUrl.startsWith("/api/") || req.originalUrl.startsWith(config.withBasePath("/api/"));
    if (isApiRequest) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    // Browsers get a redirect
    return res.redirect(getAppRedirectTarget(req, "/login"));
  }
  return next();
}

module.exports = {
  attachCurrentUser,
  authenticateUser,
  clearSessionCookie,
  createAuthSession,
  createUser,
  destroyAuthSession,
  persistSessionCookie,
  requireAuth
};
