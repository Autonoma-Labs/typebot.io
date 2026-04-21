const { Client } = require('pg');

const client = new Client({
  connectionString: "postgresql://neondb_owner:npg_u2ciQjxten4Z@ep-noisy-salad-am2wiov3-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require"
});

async function migrate() {
  try {
    await client.connect();
    console.log('Connected to database');

    await client.query('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "hashedPassword" TEXT');
    console.log('✅ Migration successful: Added hashedPassword column');

    await client.end();
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

migrate();
