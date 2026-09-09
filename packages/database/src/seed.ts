import { db } from './index';
import { users, wallets } from './schema';
import { eq } from 'drizzle-orm';

async function seed() {
  console.log('Seeding initial test user and wallet...');

  const testTelegramId = 123456789;
  const existingUser = await db.select().from(users).where(eq(users.telegramId, testTelegramId)).limit(1);

  let userId: string;
  if (existingUser.length > 0) {
    userId = existingUser[0].id;
    console.log(`User already exists with ID: ${userId}`);
  } else {
    const [newUser] = await db
      .insert(users)
      .values({
        telegramId: testTelegramId,
        username: 'testuser',
        firstName: 'Test',
        lastName: 'User',
        role: 'customer',
      })
      .returning();
    userId = newUser.id;
    console.log(`Created user with ID: ${userId}`);
  }

  const existingWallet = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (existingWallet.length === 0) {
    const [newWallet] = await db
      .insert(wallets)
      .values({
        userId,
        balance: 100000, // 100,000 VND
        currency: 'VND',
      })
      .returning();
    console.log(`Created wallet with ID: ${newWallet.id}, balance: ${newWallet.balance}`);
  } else {
    console.log(`Wallet already exists with ID: ${existingWallet[0].id}, balance: ${existingWallet[0].balance}`);
  }

  console.log('Seed completed successfully!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
