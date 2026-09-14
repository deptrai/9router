import { products, eq, or, sql, type DbOrTx } from '@repo/database';

/**
 * Normalizes a string (with full Vietnamese diacritics support) into a kebab-case slug.
 */
export function slugify(input: string): string {
  if (!input || typeof input !== 'string') {
    return 'product';
  }

  const normalized = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.length > 0 ? normalized : 'product';
}

/**
 * Ensures uniqueness of a slug in the products table by appending an incremental number if colliding.
 */
export async function generateUniqueSlug(
  title: string,
  tx: DbOrTx,
  currentProductId?: string,
): Promise<string> {
  // Truncate to 250 chars to leave room for collision counter suffix (-N).
  const baseSlug = slugify(title).slice(0, 250);

  // Query existing slugs matching baseSlug or prefixed variants only
  const existingRows = await tx
    .select({ slug: products.slug, id: products.id })
    .from(products)
    .where(
      or(
        eq(products.slug, baseSlug),
        sql`${products.slug} LIKE ${baseSlug + '-%'}`,
      ),
    );

  const matching = existingRows.filter(
    (row) =>
      row.slug === baseSlug || row.slug.startsWith(`${baseSlug}-`),
  );

  // If baseSlug already belongs to current product, reuse it
  const exactMatch = matching.find((row) => row.slug === baseSlug);
  if (!exactMatch || (currentProductId && exactMatch.id === currentProductId)) {
    return baseSlug;
  }

  // Find max suffix number
  const existingSlugs = new Set(
    matching
      .filter((row) => !currentProductId || row.id !== currentProductId)
      .map((row) => row.slug),
  );

  let counter = 2;
  while (existingSlugs.has(`${baseSlug}-${counter}`)) {
    counter++;
  }

  // Truncate baseSlug so that `${baseSlug}-${counter}` fits varchar(255).
  const maxBase = 255 - String(counter).length - 1; // -1 for the '-'
  const truncatedBase = baseSlug.length > maxBase ? baseSlug.slice(0, maxBase) : baseSlug;
  return `${truncatedBase}-${counter}`;
}
