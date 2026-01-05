import { PoolClient } from 'pg';
import pool from '../config/database';
import logger from '../utils/logger';

/**
 * Database migration script
 * Creates tables and indexes for the authentication system
 */
const createTables = async (): Promise<void> => {
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        is_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$')
      );
    `);

    // Create index on email for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    // Create verification_codes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS verification_codes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code VARCHAR(6) NOT NULL,
        attempts INTEGER DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        is_used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT code_length CHECK (LENGTH(code) = 6)
      );
    `);

    // Create indexes on verification_codes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_user_id ON verification_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_verification_expires ON verification_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_verification_is_used ON verification_codes(is_used);
    `);

    // Create sessions table with new schema for JWT tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access_token TEXT NOT NULL,
        refresh_token VARCHAR(64) NOT NULL,
        access_token_expires_at TIMESTAMP NOT NULL,
        refresh_token_expires_at TIMESTAMP NOT NULL,
        is_revoked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(45),
        user_agent TEXT
      );
    `);

    // Create indexes on sessions for optimal query performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_access_token ON sessions(access_token);
      CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
      CREATE INDEX IF NOT EXISTS idx_sessions_refresh_expires ON sessions(refresh_token_expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_is_revoked ON sessions(is_revoked);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, is_revoked) WHERE is_revoked = FALSE;
    `);

    // Create function to update updated_at timestamp
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create trigger for users table
    await client.query(`
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
    `);

    // Create trigger for sessions table
    await client.query(`
      DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
      CREATE TRIGGER update_sessions_updated_at
      BEFORE UPDATE ON sessions
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
    `);

    await client.query('COMMIT');
    logger.info('Database tables created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    const err = error as Error;
    logger.error('Error creating tables', {
      error: err.message,
      stack: err.stack,
    });
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Migration function to update existing sessions table
 * This is for existing databases that need to be updated
 */
const migrateSessionsTable = async (): Promise<void> => {
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if sessions table exists and has old schema
    const tableCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'session_token';
    `);

    if (tableCheck.rows.length > 0) {
      logger.info('Migrating sessions table to new schema...');

      // Drop old sessions table (data will be lost, users need to re-login)
      await client.query('DROP TABLE IF EXISTS sessions CASCADE;');

      // Create new sessions table
      await client.query(`
        CREATE TABLE sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access_token TEXT NOT NULL,
          refresh_token VARCHAR(64) NOT NULL,
          access_token_expires_at TIMESTAMP NOT NULL,
          refresh_token_expires_at TIMESTAMP NOT NULL,
          is_revoked BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ip_address VARCHAR(45),
          user_agent TEXT
        );
      `);

      // Create indexes
      await client.query(`
        CREATE INDEX idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX idx_sessions_access_token ON sessions(access_token);
        CREATE INDEX idx_sessions_refresh_token ON sessions(refresh_token);
        CREATE INDEX idx_sessions_refresh_expires ON sessions(refresh_token_expires_at);
        CREATE INDEX idx_sessions_is_revoked ON sessions(is_revoked);
        CREATE INDEX idx_sessions_user_active ON sessions(user_id, is_revoked) WHERE is_revoked = FALSE;
      `);

      // Create trigger
      await client.query(`
        DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
        CREATE TRIGGER update_sessions_updated_at
        BEFORE UPDATE ON sessions
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
      `);

      logger.info('Sessions table migration completed');
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const err = error as Error;
    logger.error('Error migrating sessions table', {
      error: err.message,
      stack: err.stack,
    });
    throw error;
  } finally {
    client.release();
  }
};

// Run migrations
if (require.main === module) {
  (async () => {
    try {
      await createTables();
      await migrateSessionsTable();
      console.log('✅ Migration completed successfully');
      process.exit(0);
    } catch (error) {
      const err = error as Error;
      console.error('❌ Migration failed:', err.message);
      process.exit(1);
    }
  })();
}

export { createTables, migrateSessionsTable };
