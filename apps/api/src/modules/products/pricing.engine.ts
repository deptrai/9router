import { parseSignedDecimal, formatSignedDecimal } from '@repo/shared-types';

/**
 * 1,000 VND in scale-2 units (1 VND = 100 units -> 1,000 VND = 100,000 units).
 */
const THOUSAND_VND_UNITS = 100_000n;
const HALF_THOUSAND_VND_UNITS = 50_000n;

/**
 * Calculate raw retail price in scale-2 units before rounding.
 * Formula: Cost * (1 + X/100) + Fixed
 *
 * @param costUnits Wholesale cost in scale-2 units (C * 100)
 * @param markupPctBp Markup percentage in basis points (X% * 100, e.g. 20.00% = 2000n)
 * @param fixedUnits Fixed markup in scale-2 units (Y * 100)
 */
export function computeRetailPriceUnits(
  costUnits: bigint,
  markupPctBp: bigint,
  fixedUnits: bigint,
): bigint {
  // Exact rational: (costUnits * (10_000 + bp) + fixedUnits * 10_000) / 10_000.
  // Single truncation point — rounding the percentage step first caused a
  // double-rounding bug at the 1,000đ boundary (e.g. 999.99 * 1.5 + 0.01 = 1499.995
  // must round down to 1,000, not up to 2,000).
  return (costUnits * (10_000n + markupPctBp) + fixedUnits * 10_000n) / 10_000n;
}

/**
 * Round price in scale-2 units to the nearest 1,000 VND.
 * Floors to at least 1,000 VND (100,000 units) so retail price is never 0 VND.
 */
export function roundToThousandVnd(units: bigint): bigint {
  const rounded = ((units + HALF_THOUSAND_VND_UNITS) / THOUSAND_VND_UNITS) * THOUSAND_VND_UNITS;
  if (rounded < THOUSAND_VND_UNITS) {
    return THOUSAND_VND_UNITS;
  }
  return rounded;
}

/**
 * Recalculate retail price from wholesale cost and markup rules.
 * Returns decimal string formatted to scale 2 (e.g. '130000.00').
 *
 * @param upstreamCost Decimal string of wholesale cost
 * @param markupPct Decimal string of markup percentage (e.g. '20.00')
 * @param markupFixedVnd Decimal string of fixed markup VND (e.g. '10000.00')
 */
export function computeRetailPrice(
  upstreamCost: string,
  markupPct: string,
  markupFixedVnd: string,
): string {
  const costUnits = parseSignedDecimal(upstreamCost);
  const markupPctBp = parseSignedDecimal(markupPct);
  const fixedUnits = parseSignedDecimal(markupFixedVnd);

  const rawUnits = computeRetailPriceUnits(costUnits, markupPctBp, fixedUnits);
  const finalUnits = roundToThousandVnd(rawUnits);

  return formatSignedDecimal(finalUnits);
}

/**
 * Check if upstream cost strictly exceeds the maximum allowed threshold.
 *
 * @param upstreamCost Decimal string of current upstream cost
 * @param maxUpstreamCost Nullable decimal string of maximum threshold
 */
export function exceedsMaxCost(
  upstreamCost: string,
  maxUpstreamCost: string | null | undefined,
): boolean {
  if (!maxUpstreamCost || maxUpstreamCost.trim() === '') {
    return false;
  }
  const cost = parseSignedDecimal(upstreamCost);
  const max = parseSignedDecimal(maxUpstreamCost);
  return cost > max;
}
