import { PoolClient } from "pg";
import pool from "../config/database";
import logger from "../utils/logger";

const createUpdateTimestampFunction = async (
	client: PoolClient,
): Promise<void> => {
	await client.query(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

const createUpdatedAtTrigger = async (
	client: PoolClient,
	tableName: string,
	triggerName: string,
): Promise<void> => {
	await client.query(`
    DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName};
    CREATE TRIGGER ${triggerName}
    BEFORE UPDATE ON ${tableName}
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

const ensurePlanTypeConstraintOnUsers = async (
	client: PoolClient,
): Promise<void> => {
	await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'plan_type_check'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
        ADD CONSTRAINT plan_type_check CHECK (plan_type IN ('free', 'basic'));
      END IF;
    END $$;
  `);
};

const validateUsersIdType = async (
	client: PoolClient,
): Promise<void> => {
	const result = await client.query<{
		data_type: string;
		udt_name: string;
	}>(`
    SELECT data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'id';
  `);

	if (result.rows.length === 0) return;

	const idColumn = result.rows[0];
	if (
		idColumn.data_type !== "uuid" &&
		idColumn.udt_name !== "uuid"
	) {
		throw new Error(
			`Incompatible users.id type detected (${idColumn.data_type}). This app requires UUID user IDs.`,
		);
	}
};

/**
 * Single migration entrypoint:
 * creates all required tables/indexes/triggers for auth, subscriptions, and widgets.
 */
const createTables = async (): Promise<void> => {
	const client: PoolClient = await pool.connect();

	try {
		await client.query("BEGIN");

		await client.query(
			'CREATE EXTENSION IF NOT EXISTS "pgcrypto";',
		);
		await createUpdateTimestampFunction(client);

		await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        is_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        plan_type VARCHAR(20) NOT NULL DEFAULT 'free',
        conversations_used INTEGER NOT NULL DEFAULT 0,
        conversations_limit INTEGER NOT NULL DEFAULT 100,
        plan_reset_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        plan_expires_at TIMESTAMP,
        stripe_customer_id VARCHAR(255),
        subscription_id VARCHAR(255),
        subscription_status VARCHAR(50),
        CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$')
      );
    `);

		await ensurePlanTypeConstraintOnUsers(client);

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_plan_type ON users(plan_type);
      CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
    `);

		await client.query(`
      CREATE TABLE IF NOT EXISTS verification_codes (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code VARCHAR(6) NOT NULL,
        attempts INTEGER DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        is_used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT code_length CHECK (LENGTH(code) = 6)
      );
    `);

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_user_id ON verification_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_verification_expires ON verification_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_verification_is_used ON verification_codes(is_used);
    `);

		await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_access_token ON sessions(access_token);
      CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
      CREATE INDEX IF NOT EXISTS idx_sessions_refresh_expires ON sessions(refresh_token_expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_is_revoked ON sessions(is_revoked);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, is_revoked) WHERE is_revoked = FALSE;
    `);

		await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    `);

		await client.query(`
      CREATE TABLE IF NOT EXISTS payment_history (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_payment_id VARCHAR(255) NOT NULL,
        amount INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'usd',
        status VARCHAR(50) NOT NULL,
        plan_type VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_history_user_id ON payment_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_payment_history_stripe_payment ON payment_history(stripe_payment_id);
    `);

		await client.query(`
      CREATE TABLE IF NOT EXISTS widget_keys (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        widget_key VARCHAR(255) UNIQUE NOT NULL,
        widget_name VARCHAR(255) DEFAULT 'My Chat Widget',
        is_active BOOLEAN DEFAULT TRUE,
        allowed_domains TEXT[],
        widget_config JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        usage_count INTEGER DEFAULT 0
      );
    `);

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_widget_keys_user_id ON widget_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_widget_keys_key ON widget_keys(widget_key);
      CREATE INDEX IF NOT EXISTS idx_widget_keys_active ON widget_keys(is_active);
    `);

		await client.query(`
      CREATE TABLE IF NOT EXISTS widget_analytics (
        id SERIAL PRIMARY KEY,
        widget_key_id INTEGER NOT NULL REFERENCES widget_keys(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        event_data JSONB DEFAULT '{}'::jsonb,
        ip_address VARCHAR(45),
        user_agent TEXT,
        referer_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

		await client.query(`
      CREATE INDEX IF NOT EXISTS idx_widget_analytics_key_id ON widget_analytics(widget_key_id);
      CREATE INDEX IF NOT EXISTS idx_widget_analytics_event_type ON widget_analytics(event_type);
      CREATE INDEX IF NOT EXISTS idx_widget_analytics_created_at ON widget_analytics(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_widget_analytics_key_created ON widget_analytics(widget_key_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_widget_analytics_event_created ON widget_analytics(event_type, created_at DESC);
    `);

		await createUpdatedAtTrigger(
			client,
			"users",
			"update_users_updated_at",
		);
		await createUpdatedAtTrigger(
			client,
			"sessions",
			"update_sessions_updated_at",
		);
		await createUpdatedAtTrigger(
			client,
			"subscriptions",
			"update_subscriptions_updated_at",
		);
		await createUpdatedAtTrigger(
			client,
			"widget_keys",
			"update_widget_keys_updated_at",
		);

		await validateUsersIdType(client);

		await client.query("COMMIT");
		logger.info(
			"Database tables, indexes, and triggers ensured successfully",
		);
	} catch (error) {
		await client.query("ROLLBACK");
		const err = error as Error;
		logger.error(
			"Error creating database schema",
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

const addPricingFieldsToUsers =
	async (): Promise<void> => {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

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

			await ensurePlanTypeConstraintOnUsers(client);

			await client.query(`
        ALTER TABLE users
        ALTER COLUMN conversations_limit SET DEFAULT 100;
      `);

			await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_plan_type ON users(plan_type);
        CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
      `);

			await client.query("COMMIT");
			logger.info(
				"Users pricing fields ensured successfully",
			);
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error(
				"Error ensuring users pricing fields",
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

const migrateSessionsTable =
	async (): Promise<void> => {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			const legacySessionColumn =
				await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'session_token';
        `);

			if (legacySessionColumn.rows.length > 0) {
				logger.info(
					"Migrating legacy sessions table schema...",
				);

				await client.query(
					"DROP TABLE IF EXISTS sessions CASCADE;",
				);

				await client.query(`
          CREATE TABLE sessions (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

				await client.query(`
          CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
          CREATE INDEX IF NOT EXISTS idx_sessions_access_token ON sessions(access_token);
          CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
          CREATE INDEX IF NOT EXISTS idx_sessions_refresh_expires ON sessions(refresh_token_expires_at);
          CREATE INDEX IF NOT EXISTS idx_sessions_is_revoked ON sessions(is_revoked);
          CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, is_revoked) WHERE is_revoked = FALSE;
        `);

				await createUpdateTimestampFunction(
					client,
				);
				await createUpdatedAtTrigger(
					client,
					"sessions",
					"update_sessions_updated_at",
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

if (require.main === module) {
	(async () => {
		try {
			await createTables();
			await migrateSessionsTable();
			await addPricingFieldsToUsers();
			console.log(
				"Migration completed successfully",
			);
			process.exit(0);
		} catch (error) {
			const err = error as Error;
			console.error("Migration failed:", err.message);
			process.exit(1);
		}
	})();
}

export {
	addPricingFieldsToUsers,
	createTables,
	migrateSessionsTable,
};
