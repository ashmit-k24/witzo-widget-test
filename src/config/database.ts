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
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Increased from 2s to 10s - wait 10 seconds before timing out
  keepAlive: true, // Keep TCP connection alive
  keepAliveInitialDelayMillis: 10000, // Initial delay before sending keep-alive probes
  statement_timeout: 30000, // Abort statements that take longer than 30 seconds
  query_timeout: 30000, // Query timeout in milliseconds
  application_name: 'witzo-ai-automation-chatbot',
};

const pool = new Pool(poolConfig);

// Handle pool errors
pool.on('error', (err: Error) => {
  logger.error('Unexpected database pool error', {
    error: err.message,
    stack: err.stack,
  });
  // Don't exit the process - let the pool handle reconnection
});

// Handle client errors
pool.on('connect', (client) => {
  client.on('error', (err: Error) => {
    logger.error('Database client error', { error: err.message });
  });
});

// Test connection on startup with retry
const testConnection = async (retries = 3): Promise<void> => {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT NOW()');
      logger.info('Database connected successfully', {
        host: config.DB_HOST,
        database: config.DB_NAME,
        maxConnections: config.DB_MAX_CONNECTIONS,
      });
      return;
    } catch (err) {
      const error = err as Error;
      logger.error(`Database connection attempt ${i + 1}/${retries} failed`, {
        error: error.message,
        host: config.DB_HOST,
        database: config.DB_NAME,
      });

      if (i < retries - 1) {
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        logger.error('Database connection failed after all retries');
        // Don't throw - let the app start anyway
      }
    }
  }
};

// Test connection on startup
testConnection();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing database pool...');
  await pool.end();
  logger.info('Database pool closed');
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing database pool...');
  await pool.end();
  logger.info('Database pool closed');
  process.exit(0);
});

export default pool;