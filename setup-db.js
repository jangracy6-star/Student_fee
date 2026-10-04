/**
 * Supabase Table Setup via REST API
 * Uses the service_role key to create tables
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testConnection() {
  console.log('🔍 Testing Supabase connection...\n');
  console.log(`   URL: ${process.env.SUPABASE_URL}`);
  console.log(`   Key: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 20)}...`);

  // Try to access the students table
  const { data, error } = await supabase.from('students').select('count', { count: 'exact', head: true });

  if (error) {
    if (error.message.includes('does not exist') || error.code === '42P01' || error.message.includes('relation')) {
      console.log('\n   ❌ Tables do NOT exist yet.');
      console.log('\n   📋 You need to create them manually:');
      console.log('   ────────────────────────────────────────────────');
      console.log(`   1. Open: ${process.env.SUPABASE_URL.replace('.supabase.co', '.supabase.co').replace('https://', 'https://supabase.com/dashboard/project/').replace('.supabase.co', '')}/sql/new`);
      console.log('      OR go to: https://supabase.com/dashboard → Your Project → SQL Editor');
      console.log('   2. Copy & paste the contents of setup-database.sql');
      console.log('   3. Click "Run"');
      console.log('   4. Then run: npm start');
      console.log('   ────────────────────────────────────────────────');
    } else {
      console.log(`\n   ⚠️  Error: ${error.message}`);
      console.log(`   Code: ${error.code}`);
    }
  } else {
    console.log('\n   ✅ Students table exists and is accessible!');

    // Test fee_records table
    const { error: feeErr } = await supabase.from('fee_records').select('count', { count: 'exact', head: true });
    if (feeErr) {
      console.log('   ❌ fee_records table is missing');
    } else {
      console.log('   ✅ fee_records table exists!');
    }

    // Test activity_log table
    const { error: logErr } = await supabase.from('activity_log').select('count', { count: 'exact', head: true });
    if (logErr) {
      console.log('   ❌ activity_log table is missing');
    } else {
      console.log('   ✅ activity_log table exists!');
    }

    console.log('\n   🎉 Database is ready! Run: npm start');
  }
}

testConnection().catch(err => {
  console.error('Fatal error:', err.message);
});
