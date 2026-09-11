/**
2 * Money decimal helpers using BigInt scale-2 (1/100 VND).
3 * Canonical utilities extracted from ledger & orders domain logic.
4 */

export function parseSignedDecimal(value: string): bigint {
  const m = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Invalid decimal format: ${value}`);
  const [, sign, intPart, decPart = ''] = m;
  const dec = decPart.padEnd(2, '0');
  const units = BigInt(intPart + dec) * (sign === '-' ? -1n : 1n);
  return units;
}

export function formatSignedDecimal(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = sign ? (-units).toString() : units.toString();
  const padded = abs.padStart(3, '0');
  return `${sign}${padded.slice(0, -2)}.${padded.slice(-2)}`;
}
