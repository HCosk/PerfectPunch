const crypto = require("node:crypto");

const { execute, query } = require("./db");
const config = require("./config");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) {
    return false;
  }
  const derived = crypto.scryptSync(password, salt, 64);
  const source = Buffer.from(hash, "hex");
  return source.length === derived.length && crypto.timingSafeEqual(source, derived);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function parseCookies(cookieHeader = "") {
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
  return String(password || "").length >= 8;
}

async function createUser({ username, email, password, jabArm }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const selectedArm = jabArm === "left" ? "left" : "right";

  if (!/^[a-z0-9_-]{3,30}$/.test(normalizedUsername)) {
    throw new Error("Username must be 3-30 characters using letters, numbers, hyphens, or underscores.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }
  if (!validatePasswordStrength(password)) {
    throw new Error("Password must be at least 8 characters long.");
  }

  const existingRows = await query(
    "SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1",
    [normalizedUsername, normalizedEmail]
  );
  if (existingRows.length) {
    throw new Error("That username or email is already in use.");
  }

  const passwordHash = hashPassword(password);
  const result = await execute(
    "INSERT INTO users (username, email, password_hash, jab_arm) VALUES (?, ?, ?, ?)",
    [normalizedUsername, normalizedEmail, passwordHash, selectedArm]
  );

  const rows = await query(
    "SELECT id, username, email, jab_arm, created_at FROM users WHERE id = ? LIMIT 1",
    [result.insertId]
  );
  return rows[0];
}

async function findUserByLogin(login) {
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
  const user = await findUserByLogin(login);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return null;
  }
  return user;
}

async function createAuthSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + config.cookieMaxAgeMs);
  await execute("DELETE FROM auth_sessions WHERE expires_at <= UTC_TIMESTAMP()");
  await execute(
    "INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt]
  );
  return { token, expiresAt };
}

async function destroyAuthSession(rawToken) {
  if (!rawToken) {
    return;
  }
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await execute("DELETE FROM auth_sessions WHERE token_hash = ?", [tokenHash]);
}

async function findUserFromToken(rawToken) {
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
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: config.cookieMaxAgeMs,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/"
  });
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.originalUrl.startsWith("/api/")) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    return res.redirect("/login");
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
