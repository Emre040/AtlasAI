'use strict';

const mysql = require('mysql2/promise');

const REQUIRED_DATABASE_ENV = [
  'HPA_DB_HOST',
  'HPA_DB_USER',
  'HPA_DB_PASS',
  'HPA_DB_NAME',
  'HPA_DB_CONN'
];
const MAX_TRANSACTION_ATTEMPTS = 3;

function requireDatabaseConfig() {
  const missing = REQUIRED_DATABASE_ENV.filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required database configuration: ${missing.join(', ')}`);
  }

  const connectionLimit = Number.parseInt(process.env.HPA_DB_CONN, 10);
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) {
    throw new Error('HPA_DB_CONN must be a positive integer.');
  }

  return {
    host: process.env.HPA_DB_HOST,
    user: process.env.HPA_DB_USER,
    password: process.env.HPA_DB_PASS,
    database: process.env.HPA_DB_NAME,
    connectionLimit
  };
}

class QueryClient {
  constructor(connection) {
    this.connection = connection;
  }

  query(sql, params) {
    return this.connection.query(sql, params);
  }

  execute(sql, params) {
    return this.connection.execute(sql, params);
  }
}

class DatabaseClient extends QueryClient {
  constructor(pool) {
    super(pool);
    this.pool = pool;
    this.mode = 'mysql';
  }

  async transaction(work) {
    if (typeof work !== 'function') throw new TypeError('transaction requires a callback.');

    const connection = await this.pool.getConnection();
    try {
      for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
        try {
          await connection.beginTransaction();
          const result = await work(new QueryClient(connection));
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          if (error?.code !== 'ER_LOCK_DEADLOCK' || attempt === MAX_TRANSACTION_ATTEMPTS) {
            throw error;
          }
        }
      }
      throw new Error('Transaction retry invariant failed.');
    } finally {
      connection.release();
    }
  }

  end() {
    return this.pool.end();
  }
}

async function createDatabaseClient() {
  const config = requireDatabaseConfig();
  const pool = mysql.createPool({
    host: config.host,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    timezone: 'Z',
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true
  });

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    const suffix = error?.code ? ` (${error.code})` : '';
    throw new Error(`MySQL connection failed${suffix}.`);
  }

  console.log('[DB] Connected to MySQL.');
  return new DatabaseClient(pool);
}

module.exports = { createDatabaseClient, DatabaseClient };
