const fs = require("node:fs/promises");
const path = require("node:path");

const mysql = require("mysql2/promise");

const config = require("./config");

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool(config.mysql);
  }
  return pool;
}

async function initializeDatabase() {
  const activePool = await getPool();
  const schemaPath = path.join(config.rootDir, "database", "schema.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf8");
  await activePool.query(schemaSql);
  return activePool;
}

async function query(sql, params = []) {
  const activePool = await getPool();
  const [rows] = await activePool.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const activePool = await getPool();
  const [result] = await activePool.execute(sql, params);
  return result;
}

async function withTransaction(callback) {
  const activePool = await getPool();
  const connection = await activePool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
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
