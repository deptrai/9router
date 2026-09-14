import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';

export interface ParsedCatalogProduct {
  supplierProductId: string;
  name: string;
  title: string;
  description: string | null;
  priceVnd: number;
  priceCredits?: number;
  stock: number | null;
  isActive: boolean;
}

export interface ParseCatalogOptions {
  botUsername?: string;
  vndPerCredit: number;
  parseMode?: 'text' | 'buttons' | string;
}

export const PRICE_RE =
  /(?:(?:💵|💰|Giá:|Price:)\s*([\d.,]+)\s*(vnđ|vnd|đ|k|credits?)(?!\p{L})|(?<=^|\r?\n)\s*([\d.,]+)\s*(vnđ|vnd|đ|k|credits?)(?!\p{L})(?=\s*(?:[·|–—\-~/]|\/|⛔|Hết|Còn|\(|$|\r?\n)))/iu;
export const SOLD_OUT_RE = /⛔|Hết\s*hàng|SOLD\s*OUT/i;
export const NUMBERED_START_RE = /^\d+\.\s/;
export const BUTTON_ID_RE = /\[\s*ID\s+(\d+)\s*\]/i;

export function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\p{Extended_Pictographic}‍️\s]+/u, '').trim();
}

export function parsePriceWithUnit(rawNum: string, unit: string, vndPerCredit: number): number | null {
  const cleanUnit = (unit || '').toLowerCase();
  let num: number;
  if (cleanUnit === 'k') {
    const normalized = rawNum.replace(',', '.');
    num = Number(normalized);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num * 1000);
  } else if (cleanUnit.startsWith('credit')) {
    // Strip all thousand separators (both , and .) — credit amounts are
    // whole numbers, so "1,000" or "1.000" both mean 1000, not 1.
    const normalized = rawNum.replace(/[.,]/g, '');
    num = Number(normalized);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num * vndPerCredit);
  } else {
    // 'đ' or 'vnd' or 'vnđ'
    const cleaned = rawNum.replace(/[.,]/g, '');
    num = Number(cleaned);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num);
  }
}

export function groupProductBlocks(text: string): string[] {
  const fragments = text.split(/(?=(?:^|\n)\d+\.\s)/);
  const blocks: string[] = [];
  let current: string | null = null;

  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (!trimmed) continue;
    const startsNumbered = NUMBERED_START_RE.test(trimmed);

    if (current === null) {
      if (startsNumbered) current = trimmed;
      continue;
    }
    if (PRICE_RE.test(current)) {
      // Current block already has a price — it's complete.
      blocks.push(current);
      if (startsNumbered) {
        // Could be a new product OR a numbered sub-list inside the
        // previous product's description (e.g. "Hướng dẫn:\n1. Tải app").
        // If this fragment contains no price, it can never form a product
        // — append it to the last block rather than orphaning it.
        if (!PRICE_RE.test(trimmed)) {
          blocks[blocks.length - 1] += `\n${trimmed}`;
          current = null;
        } else {
          current = trimmed;
        }
      } else {
        current = null;
      }
      continue;
    }
    current = `${current}\n${trimmed}`;
  }

  if (current !== null && PRICE_RE.test(current)) {
    blocks.push(current);
  }
  return blocks;
}

@Injectable()
export class CatalogParserService {
  stripLeadingEmoji(text: string): string {
    return stripLeadingEmoji(text);
  }

  groupProductBlocks(text: string): string[] {
    return groupProductBlocks(text);
  }

  parseTelegramCatalog(text: string, options: ParseCatalogOptions): ParsedCatalogProduct[] {
    const rate = Number(options.vndPerCredit);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('parseTelegramCatalog: vndPerCredit is required and must be > 0');
    }

    const cleanBot = (options.botUsername || '').trim().replace(/^@+/, '').toLowerCase();
    const products: ParsedCatalogProduct[] = [];

    for (const block of groupProductBlocks(text)) {
      const nameMatch = block.match(/^(\d+)\.[ \t]*(.+?)(?:\r?\n|$)/);
      if (!nameMatch) continue;

      const lines = block.split(/\r?\n/);
      const priceLineIndex = lines.findIndex((line) => PRICE_RE.test(line));
      if (priceLineIndex < 0) continue;

      const priceMatch = lines[priceLineIndex].match(PRICE_RE);
      if (!priceMatch) continue;

      const rawNum = priceMatch[1] ?? priceMatch[3];
      const rawUnit = priceMatch[2] ?? priceMatch[4];
      const priceVnd = parsePriceWithUnit(rawNum, rawUnit, rate);
      if (!priceVnd || priceVnd <= 0) continue;

      const rawName = nameMatch[2];
      const stripped = stripLeadingEmoji(rawName).trim();
      const name = (stripped || rawName.trim()).trim();
      if (!name) continue;

      const statusText = lines.slice(priceLineIndex).join('\n');
      let isActive = true;
      let stock: number | null = null;
      if (SOLD_OUT_RE.test(statusText)) {
        isActive = false;
        stock = 0;
      }

      const descriptionLines = lines
        .slice(1, priceLineIndex)
        .filter((line) => line.trim() && !line.match(/^[-─┄━]+$/));
      const description = descriptionLines.length > 0 ? descriptionLines.join('\n').trim() : null;

      const sanitizedTitle = name.slice(0, 255);
      const sanitizedDescription = description ? description.slice(0, 4000) : null;

      const supplierProductId = crypto
        .createHash('sha256')
        .update(`${cleanBot}:${sanitizedTitle}`)
        .digest('hex');

      products.push({
        supplierProductId,
        name: sanitizedTitle,
        title: sanitizedTitle,
        description: sanitizedDescription,
        priceVnd,
        priceCredits: Math.ceil(priceVnd / rate),
        stock,
        isActive,
      });
    }

    if (products.length === 0) {
      throw new Error('PARSER_ZERO_PRODUCTS');
    }

    return products;
  }

  parseTelegramButtonCatalog(buttons: any[], options: ParseCatalogOptions): ParsedCatalogProduct[] {
    const rate = Number(options.vndPerCredit);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('parseTelegramButtonCatalog: vndPerCredit is required and must be > 0');
    }

    const cleanBot = (options.botUsername || '').trim().replace(/^@+/, '').toLowerCase();
    const products: ParsedCatalogProduct[] = [];

    for (const button of buttons ?? []) {
      const raw = typeof button === 'string' ? button : (button?.text ?? button?.name);
      if (typeof raw !== 'string' || !raw.trim()) continue;

      const text = stripLeadingEmoji(raw.trim());
      if (!text) continue;

      const parts = text.split('|');
      if (parts.length < 2) continue;

      const priceToken = stripLeadingEmoji(parts[0].trim());
      const priceMatch = priceToken.match(PRICE_RE);
      if (!priceMatch) continue;

      const rawNum = priceMatch[1] ?? priceMatch[3];
      const rawUnit = priceMatch[2] ?? priceMatch[4];
      const priceVnd = parsePriceWithUnit(rawNum, rawUnit, rate);
      if (!priceVnd || priceVnd <= 0) continue;

      // 2-part: price | name → parts[1] is the name.
      // 3+-part: price | status | name... → parts[2..] is the name.
      const rawNameParts = parts.length === 2
        ? [parts[1]]
        : parts.slice(2).map((p) => p.trim()).filter(Boolean);
      const secondaryPart = parts.length >= 3 ? stripLeadingEmoji(parts[1].trim()) : '';
      const isSecondaryPriceOrStatus =
        /^[\$\d.,\s]+$/.test(secondaryPart) ||
        secondaryPart.includes('$') ||
        secondaryPart.includes('€') ||
        secondaryPart.includes('¥') ||
        SOLD_OUT_RE.test(secondaryPart) ||
        /^(?:còn|hết|sẵn|tạm|available|in\s*stock|out\s*of\s*stock|ready)/i.test(secondaryPart);

      let combinedName = rawNameParts.join(' | ');
      if (!isSecondaryPriceOrStatus && secondaryPart && !combinedName.toLowerCase().includes(secondaryPart.toLowerCase())) {
        combinedName = `${combinedName} (${secondaryPart})`;
      }
      if (!combinedName) continue;

      const idMatch = combinedName.match(BUTTON_ID_RE);
      const fullName = combinedName.replace(BUTTON_ID_RE, '').replace(/\.\.\.$/, '').trim();
      if (!fullName) continue;

      const name = fullName;
      const description = `${fullName}${idMatch ? ` [ID ${idMatch[1]}]` : ''}`.trim();

      let isActive = true;
      let stock: number | null = null;
      if (SOLD_OUT_RE.test(text)) {
        isActive = false;
        stock = 0;
      }

      const sanitizedTitle = name.slice(0, 255);
      const sanitizedDescription = description ? description.slice(0, 4000) : null;

      const supplierProductId = crypto
        .createHash('sha256')
        .update(`${cleanBot}:${sanitizedTitle}`)
        .digest('hex');

      products.push({
        supplierProductId,
        name: sanitizedTitle,
        title: sanitizedTitle,
        description: sanitizedDescription,
        priceVnd,
        priceCredits: Math.ceil(priceVnd / rate),
        stock,
        isActive,
      });
    }

    if (products.length === 0) {
      throw new Error('PARSER_ZERO_PRODUCTS');
    }

    return products;
  }

  parse(
    data: { messages?: string[]; buttons?: any[] } | string,
    options: ParseCatalogOptions
  ): ParsedCatalogProduct[] {
    if (typeof data === 'string') {
      return this.parseTelegramCatalog(data, options);
    }
    if (
      options.parseMode === 'buttons' ||
      (options.parseMode !== 'text' && Array.isArray(data.buttons) && data.buttons.length > 0)
    ) {
      return this.parseTelegramButtonCatalog(data.buttons ?? [], options);
    }
    const messagesText = Array.isArray(data.messages) ? data.messages.join('\n') : '';
    return this.parseTelegramCatalog(messagesText, options);
  }
}
