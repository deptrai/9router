import { db, closeDb, encryptCredential } from './index';
import { users, wallets, supplierSources, products, productInventory } from './schema';
import { eq } from 'drizzle-orm';

async function seed() {
  console.log('Seeding initial test user and wallet...');

  await db.transaction(async (tx) => {
    const testTelegramId = 123456789;
    const existingUser = await tx.select().from(users).where(eq(users.telegramId, testTelegramId)).limit(1);

    let userId: string;
    if (existingUser.length > 0) {
      userId = existingUser[0].id;
      console.log(`User already exists with ID: ${userId}`);
    } else {
      const [newUser] = await tx
        .insert(users)
        .values({
          telegramId: testTelegramId,
          username: 'testuser',
          firstName: 'Test',
          lastName: 'User',
          role: 'CUSTOMER',
        })
        .returning();
      userId = newUser.id;
      console.log(`Created user with ID: ${userId}`);
    }

    const existingWallet = await tx.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
    if (existingWallet.length === 0) {
      const [newWallet] = await tx
        .insert(wallets)
        .values({
          userId,
          balance: '100000.00',
          heldBalance: '0.00',
          currency: 'VND',
        })
        .returning();
      console.log(`Created wallet with ID: ${newWallet.id}, balance: ${newWallet.balance}`);
    } else {
      console.log(`Wallet already exists with ID: ${existingWallet[0].id}, balance: ${existingWallet[0].balance}`);
    }

    await seedCatalog(tx);
  });

  console.log('Seed completed successfully!');
  await closeDb();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('Seed error:', err);
  await closeDb();
  process.exit(1);
});

// --- Story 3.1: seed sample products / supplier / inventory for manual verify ---

async function seedCatalog(tx: any = db) {
  console.log('Seeding catalog (Story 3.1)...');

  // Supplier source (external fallback) — idempotent by name.
  let supId: string;
  const [existingSup] = await tx.select().from(supplierSources).where(eq(supplierSources.name, 'Partner Shop A')).limit(1);
  if (existingSup) {
    supId = existingSup.id;
    await tx.update(supplierSources).set({
      markupFixedVnd: '10000.00',
      configCredentials: { priceMap: { 'office-365': '80000.00', 'spotify-1m': '40000.00' } },
    }).where(eq(supplierSources.id, supId));
  } else {
    const [s] = await tx.insert(supplierSources).values({
      name: 'Partner Shop A', type: 'API', targetUrl: 'https://partner.example.com',
      markupPercentage: '20.00',
      markupFixedVnd: '10000.00',
      configCredentials: { priceMap: { 'office-365': '80000.00', 'spotify-1m': '40000.00' } },
      isActive: true,
    }).returning();
    supId = s.id;
    console.log(`Created supplier source ${supId}`);
  }

  const catalog = [
    { title: 'Key Kiro Pro', slug: 'kiro-pro', category: 'AI Tools', price: '120000.00', sourcingMode: 'IN_HOUSE', imageUrl: null, desc: 'AI coding assistant license' },
    { title: 'Tài khoản ChatGPT Plus', slug: 'chatgpt-plus', category: 'AI Tools', price: '250000.00', sourcingMode: 'IN_HOUSE', imageUrl: null, desc: 'ChatGPT Plus 1 tháng' },
    { title: 'JetBrains All Products', slug: 'jetbrains-all', category: 'Dev Tools', price: '450000.00', sourcingMode: 'IN_HOUSE', imageUrl: null, desc: 'IDE pack license' },
    {
      title: 'Office 365 Key', slug: 'office-365', category: 'Office', price: '99000.00', sourcingMode: 'EXTERNAL', supplierSourceId: supId, imageUrl: null,
      desc: 'Office 365 key — auto-source when in-house empty',
      maxUpstreamCost: '90000.00', autoPricing: true, supplierProductUrl: 'https://partner.example.com/item/office-365',
    },
    { title: 'Cursor Pro (Hết hàng)', slug: 'cursor-pro', category: 'Dev Tools', price: '480000.00', sourcingMode: 'IN_HOUSE', imageUrl: null, desc: 'Cursor Pro account — tạm hết hàng' },
    { title: 'Netflix Premium 1M', slug: 'netflix-1m', category: 'Giải trí', price: '75000.00', sourcingMode: 'IN_HOUSE', imageUrl: null, desc: 'Netflix premium account' },
    {
      title: 'Spotify Premium 1M', slug: 'spotify-1m', category: 'Giải trí', price: '55000.00', sourcingMode: 'EXTERNAL', supplierSourceId: supId, imageUrl: null,
      desc: 'Spotify premium — external source',
      maxUpstreamCost: '50000.00', autoPricing: true, supplierProductUrl: 'https://partner.example.com/item/spotify-1m',
    },
  ];

  for (const p of catalog as any[]) {
    const [existing] = await tx.select().from(products).where(eq(products.slug, p.slug)).limit(1);
    let prodId: string;
    if (existing) {
      prodId = existing.id;
      if (p.sourcingMode === 'EXTERNAL') {
        await tx.update(products).set({
          maxUpstreamCost: p.maxUpstreamCost ?? null,
          autoPricing: p.autoPricing ?? true,
          supplierProductUrl: p.supplierProductUrl ?? null,
          supplierSourceId: p.supplierSourceId ?? null,
        }).where(eq(products.id, prodId));
      }
    } else {
      const [np] = await tx.insert(products).values({
        title: p.title, slug: p.slug, category: p.category, price: p.price,
        sourcingMode: p.sourcingMode, supplierSourceId: p.supplierSourceId ?? null,
        supplierProductUrl: p.supplierProductUrl ?? null,
        maxUpstreamCost: p.maxUpstreamCost ?? null,
        autoPricing: p.autoPricing ?? true,
        imageUrl: p.imageUrl, description: p.desc, isActive: true,
      }).returning();
      prodId = np.id;
      console.log(`Created product ${p.slug} (${prodId})`);
    }

    // Give IN_HOUSE products some inventory, except out-of-stock demo products.
    if (p.sourcingMode === 'IN_HOUSE' && p.slug !== 'cursor-pro') {
      const existingInv = await tx.select().from(productInventory).where(eq(productInventory.productId, prodId)).limit(1);
      if (existingInv.length === 0) {
        const items = Array.from({ length: 3 }, (_, i) => ({
          productId: prodId,
          credentialData: encryptCredential(`KEY-${p.slug.toUpperCase()}-XXXX-${i}`),
          status: 'AVAILABLE',
        }));
        await tx.insert(productInventory).values(items);
        console.log(`  +3 encrypted inventory for ${p.slug}`);
      }
    }
  }
  console.log('Catalog seed done.');
}
