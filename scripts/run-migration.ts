import { readFileSync } from 'fs';
import { join } from 'path';
import pool from '../src/config/database';
import logger from '../src/utils/logger';

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting database migration to UUID...');

    // Read the migration SQL file
    const migrationSQL = readFileSync(
      join(__dirname, 'migrate-user-id-to-uuid.sql'),
      'utf-8'
    );

    // Execute the migration
    await client.query(migrationSQL);

    console.log('✅ Migration completed successfully!');
    logger.info('Database migration to UUID completed successfully');
  } catch (error) {
    const err = error as Error;
    console.error('❌ Migration failed:', err.message);
    logger.error('Database migration failed', {
      error: err.message,
      stack: err.stack,
    });
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the migration
runMigration()
  .then(() => {
    console.log('Migration script finished');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration script failed:', error);
    process.exit(1);
  });
