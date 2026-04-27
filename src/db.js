// MySQL pool and helpers
const fs = require("node:fs/promises");
const path = require("node:path");

const mysql = require("mysql2/promise");

const config = require("./config");

// Lazily initialised connection pool
let pool;

async function ensureColumn(activePool, tableName, columnName, definitionSql) {
  // Add column if it does not exist
  const [rows] = await activePool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
  if (rows.length) {
    return;
  }
  await activePool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definitionSql}`);
}

async function ensureSchemaUpgrades(activePool) {
  // Apply any post-create migrations
  await ensureColumn(
    activePool,
    "recorded_sessions",
    "is_favorite",
    "`is_favorite` TINYINT(1) NOT NULL DEFAULT 0 AFTER `notes`"
  );
}

async function getPool() {
  // Build pool on first request
  if (!pool) {
    pool = mysql.createPool(config.mysql);
  }
  return pool;
}

async function initializeDatabase() {
  // Run schema and upgrade scripts
  const activePool = await getPool();
  const schemaPath = path.join(config.rootDir, "database", "schema.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf8");
  await activePool.query(schemaSql);
  await ensureSchemaUpgrades(activePool);
  return activePool;
}

async function query(sql, params = []) {
  // Run a parameterised query
  const activePool = await getPool();
  const [rows] = await activePool.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  // Run a prepared statement
  const activePool = await getPool();
  const [result] = await activePool.execute(sql, params);
  return result;
}

async function withTransaction(callback) {
  // Run callback in a transaction
  const activePool = await getPool();
  const connection = await activePool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    // Roll back on any failure
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
  // Tear down pool on shutdown
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  closePool,
  execute,
  getPool,
  initializeDatabase,
  query,
  withTransaction
};
