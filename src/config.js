const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const rootDir = path.resolve(__dirname, "..");

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value === "true";
}

module.exports = {
  rootDir,
  port: readInteger(process.env.PORT, 3000),
  publicDir: path.join(rootDir, "public"),
  storageDir: path.join(rootDir, "storage"),
  uploadDir: path.join(rootDir, "storage", "uploads"),
  pythonBin: process.env.PYTHON_BIN || "python3",
  pythonCliPath: path.join(rootDir, "app", "cli.py"),
  cookieName: process.env.SESSION_COOKIE_NAME || "perfectpunch_session",
  cookieSecure: readBoolean(process.env.SESSION_COOKIE_SECURE, false),
  cookieMaxAgeMs: readInteger(process.env.SESSION_DAYS, 30) * 24 * 60 * 60 * 1000,
  uploadPayloadLimitMb: readInteger(process.env.UPLOAD_PAYLOAD_LIMIT_MB, 80),
  mysql: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: readInteger(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "perfectpunch",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "perfectpunch",
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true,
    multipleStatements: true,
    timezone: "Z"
  }
};
