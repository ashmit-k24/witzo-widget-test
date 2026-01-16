import { PoolClient } from "pg";
import pool from "../config/database";
import logger from "../utils/logger";

/**
 * Database migration script
 * Creates tables and indexes for the authentication system
 */
const createTables = async (): Promise<void> => {
	const client: PoolClient = await pool.connect();

	try {
		await client.query("BEGIN");

		// Create users table (basic structure)
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

		// Create index on users for faster lookups
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

		// Create subscriptions table
		await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
        stripe_customer_id VARCHAR(255) NOT NULL,
        plan_type VARCHAR(20) NOT NULL,
        status VARCHAR(50) NOT NULL,
        current_period_start TIMESTAMP NOT NULL,
        current_period_end TIMESTAMP NOT NULL,
        cancel_at_period_end BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT sub_plan_type_check CHECK (plan_type IN ('free', 'basic'))
      );
    `);

		// Create indexes on subscriptions
		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    `);

		// Create trigger for subscriptions table
		await client.query(`
      DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
      CREATE TRIGGER update_subscriptions_updated_at
      BEFORE UPDATE ON subscriptions
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
    `);

		// Create payment_history table
		await client.query(`
      CREATE TABLE IF NOT EXISTS payment_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_payment_id VARCHAR(255) NOT NULL,
        amount INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'usd',
        status VARCHAR(50) NOT NULL,
        plan_type VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Create indexes on payment_history
		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_history_user_id ON payment_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_payment_history_stripe_payment ON payment_history(stripe_payment_id);
    `);

		await client.query("COMMIT");
		logger.info(
			"Database tables created successfully",
		);
	} catch (error) {
		await client.query("ROLLBACK");
		const err = error as Error;
		logger.error("Error creating tables", {
			error: err.message,
			stack: err.stack,
		});
		throw error;
	} finally {
		client.release();
	}
};

/**
 * Migration function to add pricing fields to existing users table
 * This is for existing databases that need to be updated
 */
const addPricingFieldsToUsers =
	async (): Promise<void> => {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			// Check if plan_type column exists
			const columnCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'plan_type';
    `);

			if (columnCheck.rows.length === 0) {
				logger.info(
					"Adding pricing fields to users table...",
				);

				// Add new columns
				await client.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'free',
        ADD COLUMN IF NOT EXISTS conversations_used INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS conversations_limit INTEGER DEFAULT 100,
        ADD COLUMN IF NOT EXISTS plan_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50);
      `);

				// Add check constraint
				await client.query(`
        ALTER TABLE users
        ADD CONSTRAINT plan_type_check CHECK (plan_type IN ('free', 'basic'));
      `);

				// Create indexes
				await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_plan_type ON users(plan_type);
        CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
      `);

				logger.info(
					"Pricing fields added to users table successfully",
				);
			} else {
				logger.info(
					"Pricing fields already exist in users table",
				);

				// Ensure the default is set to 100 (in case it was 20 before)
				await client.query(`
        ALTER TABLE users ALTER COLUMN conversations_limit SET DEFAULT 100;
      `);
				logger.info(
					"Updated conversations_limit default to 100",
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error(
				"Error adding pricing fields to users",
				{
					error: err.message,
					stack: err.stack,
				},
			);
			throw error;
		} finally {
			client.release();
		}
	};

/**
 * Migration function to update existing sessions table
 * This is for existing databases that need to be updated
 */
const migrateSessionsTable =
	async (): Promise<void> => {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			// Check if sessions table exists and has old schema
			const tableCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'session_token';
    `);

			if (tableCheck.rows.length > 0) {
				logger.info(
					"Migrating sessions table to new schema...",
				);

				// Drop old sessions table (data will be lost, users need to re-login)
				await client.query(
					"DROP TABLE IF EXISTS sessions CASCADE;",
				);

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

				logger.info(
					"Sessions table migration completed",
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error(
				"Error migrating sessions table",
				{
					error: err.message,
					stack: err.stack,
				},
			);
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
			await addPricingFieldsToUsers();
			console.log(
				"✅ Migration completed successfully",
			);
			process.exit(0);
		} catch (error) {
			const err = error as Error;
			console.error(
				"❌ Migration failed:",
				err.message,
			);
			process.exit(1);
		}
	})();
}

export {
	addPricingFieldsToUsers,
	createTables,
	migrateSessionsTable,
};
