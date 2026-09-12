import { products, type DbOrTx } from '@repo/database';

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
  const baseSlug = slugify(title);

  // Query existing slugs matching baseSlug
  const existingRows = await tx
    .select({ slug: products.slug, id: products.id })
    .from(products);

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

  return `${baseSlug}-${counter}`;
}
