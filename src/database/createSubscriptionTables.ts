import { PoolClient } from "pg";
import pool from "../config/database";
import logger from "../utils/logger";

/**
 * Create subscription-related tables
 */
const createSubscriptionTables =
	async (): Promise<void> => {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			// Create subscriptions table
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
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
				"Subscription tables created successfully",
			);
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error(
				"Error creating subscription tables",
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

// Run migration
if (require.main === module) {
	(async () => {
		try {
			await createSubscriptionTables();
			console.log(
				"✅ Subscription tables created successfully",
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

export { createSubscriptionTables };
