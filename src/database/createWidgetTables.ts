import { PoolClient } from "pg";
import pool from "../config/database";
import logger from "../utils/logger";

/**
 * Creates widget_keys table for embeddable chat widgets
 * Each user can have one widget key for embedding chat on their website
 */
export const createWidgetTables =
	async (): Promise<void> => {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			logger.info(
				"Creating widget_keys table...",
			);

			// Create widget_keys table
			await client.query(`
               CREATE TABLE IF NOT EXISTS widget_keys (
                    id SERIAL PRIMARY KEY,
                    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    widget_key VARCHAR(255) UNIQUE NOT NULL,
                    widget_name VARCHAR(255) DEFAULT 'My Chat Widget',
                    is_active BOOLEAN DEFAULT TRUE,
                    allowed_domains TEXT[], -- Array of domains allowed to use this widget
                    widget_config JSONB DEFAULT '{}'::jsonb, -- Custom widget configuration
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_used_at TIMESTAMP,
                    usage_count INTEGER DEFAULT 0
               );
          `);

			// Create index for faster lookups
			await client.query(`
               CREATE INDEX IF NOT EXISTS idx_widget_keys_user_id ON widget_keys(user_id);
               CREATE INDEX IF NOT EXISTS idx_widget_keys_key ON widget_keys(widget_key);
               CREATE INDEX IF NOT EXISTS idx_widget_keys_active ON widget_keys(is_active);
          `);

			// Create widget_analytics table for tracking widget usage
			await client.query(`
               CREATE TABLE IF NOT EXISTS widget_analytics (
                    id SERIAL PRIMARY KEY,
                    widget_key_id INTEGER NOT NULL REFERENCES widget_keys(id) ON DELETE CASCADE,
                    event_type VARCHAR(50) NOT NULL, -- 'message_sent', 'widget_loaded', 'error', etc.
                    event_data JSONB DEFAULT '{}'::jsonb,
                    ip_address VARCHAR(45),
                    user_agent TEXT,
                    referer_url TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
               );
          `);

			// Create indexes for analytics (optimized for high-traffic queries)
			await client.query(`
               CREATE INDEX IF NOT EXISTS idx_widget_analytics_key_id ON widget_analytics(widget_key_id);
               CREATE INDEX IF NOT EXISTS idx_widget_analytics_event_type ON widget_analytics(event_type);
               CREATE INDEX IF NOT EXISTS idx_widget_analytics_created_at ON widget_analytics(created_at DESC);
               -- Composite index for common query pattern (widget + time range)
               CREATE INDEX IF NOT EXISTS idx_widget_analytics_key_created ON widget_analytics(widget_key_id, created_at DESC);
               -- Composite index for analytics by event type and time
               CREATE INDEX IF NOT EXISTS idx_widget_analytics_event_created ON widget_analytics(event_type, created_at DESC);
          `);

			await client.query("COMMIT");
			logger.info(
				"Widget tables created successfully",
			);
		} catch (error) {
			await client.query("ROLLBACK");
			logger.error(
				"Error creating widget tables",
				{ error },
			);
			throw error;
		} finally {
			client.release();
		}
	};

// Run migration if this file is executed directly
if (require.main === module) {
	createWidgetTables()
		.then(() => {
			logger.info(
				"Widget tables migration completed",
			);
			process.exit(0);
		})
		.catch((error) => {
			logger.error(
				"Widget tables migration failed",
				{ error },
			);
			process.exit(1);
		});
}
