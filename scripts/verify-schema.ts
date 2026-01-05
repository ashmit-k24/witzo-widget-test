import pool from '../src/config/database';

async function verifySchema() {
  const client = await pool.connect();

  try {
    console.log('Verifying database schema...\n');

    // Check users table structure
    const usersSchema = await client.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position;
    `);

    console.log('📋 Users table columns:');
    usersSchema.rows.forEach((row) => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    // Check verification_codes table structure
    const codesSchema = await client.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'verification_codes'
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 Verification_codes table columns:');
    codesSchema.rows.forEach((row) => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    // Check sessions table structure
    const sessionsSchema = await client.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'sessions'
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 Sessions table columns:');
    sessionsSchema.rows.forEach((row) => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    // Check for existing data
    const userCount = await client.query('SELECT COUNT(*) as count FROM users');
    console.log(`\n📊 Total users: ${userCount.rows[0].count}`);

    if (parseInt(userCount.rows[0].count) > 0) {
      const sampleUser = await client.query('SELECT id, email FROM users LIMIT 1');
      console.log('\n📄 Sample user:');
      console.log(`  ID: ${sampleUser.rows[0].id} (type: ${typeof sampleUser.rows[0].id})`);
      console.log(`  Email: ${sampleUser.rows[0].email}`);
    }

    console.log('\n✅ Schema verification complete!');
  } catch (error) {
    const err = error as Error;
    console.error('❌ Verification failed:', err.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

verifySchema()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
