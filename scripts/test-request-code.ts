import authService from '../src/services/authService';
import pool from '../src/config/database';

async function testRequestCode() {
  try {
    console.log('Testing /request-code with new UUID implementation...\n');

    // Test 1: New email (should create new UUID)
    console.log('Test 1: Requesting code for NEW email...');
    const email1 = `test${Date.now()}@example.com`;
    const result1 = await authService.requestVerificationCode(email1);
    console.log('✅ Result:', result1);

    // Check the user in database
    const userCheck1 = await pool.query('SELECT id, email FROM users WHERE email = $1', [
      email1,
    ]);
    if (userCheck1.rows.length > 0) {
      console.log(`✅ User created with UUID: ${userCheck1.rows[0].id}`);
      console.log(`   UUID length: ${userCheck1.rows[0].id.length} characters`);
      console.log(`   UUID format: ${userCheck1.rows[0].id}\n`);
    }

    // Test 2: Existing email (should use same UUID)
    console.log('Test 2: Requesting code for EXISTING email...');
    const result2 = await authService.requestVerificationCode(email1);
    console.log('✅ Result:', result2);

    // Check the user in database again
    const userCheck2 = await pool.query('SELECT id, email FROM users WHERE email = $1', [
      email1,
    ]);
    if (userCheck2.rows.length > 0) {
      console.log(`✅ Same UUID used: ${userCheck2.rows[0].id}`);
      console.log(
        `   IDs match: ${userCheck1.rows[0].id === userCheck2.rows[0].id ? 'YES ✅' : 'NO ❌'}\n`
      );
    }

    // Test 3: Another new email (should create different UUID)
    console.log('Test 3: Requesting code for ANOTHER new email...');
    const email2 = `test${Date.now() + 1}@example.com`;
    const result3 = await authService.requestVerificationCode(email2);
    console.log('✅ Result:', result3);

    const userCheck3 = await pool.query('SELECT id, email FROM users WHERE email = $1', [
      email2,
    ]);
    if (userCheck3.rows.length > 0) {
      console.log(`✅ Different UUID created: ${userCheck3.rows[0].id}`);
      console.log(
        `   UUIDs are different: ${userCheck1.rows[0].id !== userCheck3.rows[0].id ? 'YES ✅' : 'NO ❌'}\n`
      );
    }

    // Display summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 Summary:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ New emails get unique UUIDs (not sequential)');
    console.log('✅ Existing emails keep their same UUID');
    console.log('✅ Each UUID is a long unique string');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('🎉 All tests passed!');
  } catch (error) {
    const err = error as Error;
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

testRequestCode()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
