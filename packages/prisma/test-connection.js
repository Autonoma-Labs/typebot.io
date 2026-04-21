const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://neondb_owner:npg_u2ciQjxten4Z@ep-noisy-salad-am2wiov3-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require"
    }
  }
});

async function test() {
  try {
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    console.log('✅ Database connection successful:', result);
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}

test();
