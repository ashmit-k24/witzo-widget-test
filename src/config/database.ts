import { Pool, PoolConfig } from 'pg';
import logger from '../utils/logger';
import { config } from './env';

const poolConfig: PoolConfig = {
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: config.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

const pool = new Pool(poolConfig);

// Handle pool errors
pool.on('error', (err: Error) => {
  logger.error('Unexpected database error', { error: err.message });
});

// Test connection on startup
pool.query('SELECT NOW()')
  .then(() => {
    logger.info('Database connected successfully');
  })
  .catch((err: Error) => {
    logger.error('Database connection failed', { error: err.message });
  });

export default pool;