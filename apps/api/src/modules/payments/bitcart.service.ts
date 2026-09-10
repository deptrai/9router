import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

export interface BitcartConfig {
  baseUrl: string;
  apiKey: string;
  storeId: string;
}

export interface BitcartCreateInvoiceResult {
  gatewayId: string;
  paymentUrl: string | null;
  payAddress: string | null;
  amountExpected: number;
  cryptoAmount: string | null;
  cryptoCurrency: string | null;
  expiresAt: string | null;
}

const STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  paid: 'confirming',
  unconfirmed: 'confirming',
  confirmed: 'confirming',
  complete: 'settled',
  expired: 'expired',
  invalid: 'failed',
  refunded: 'failed',
};

const NETWORK_CURRENCY: Record<string, string> = {
  tron: 'trx',
  bsc: 'bnb',
  binance: 'bnb',
  ethereum: 'eth',
  polygon: 'matic',
  solana: 'sol',
};

const TOKEN_CONTRACTS: Record<string, string> = {
  'usdt:trx': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  'usdt:bnb': '0x55d398326f99059ff775485246999027b3197955',
  'usdc:trx': 'TEkxiTehnzwnq8R2fmj5tSNTx8bxiuYDA',
  'usdc:bnb': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
};

const WALLET_CACHE_TTL_MS = 60_000;
const CREATE_INVOICE_TIMEOUT_MS = 15_000;
const GET_INVOICE_TIMEOUT_MS = 10_000;
const FETCH_WALLETS_TIMEOUT_MS = 10_000;

let walletCache: { data: any[]; fetchedAt: number } | null = null;

function normalizeContract(contract: string): string {
  const raw = typeof contract === 'string' ? contract.trim().toLowerCase() : '';
  if (/^[0-9a-f]{40}$/.test(raw)) {
    return `0x${raw}`;
  }
  return raw;
}

@Injectable()
export class BitcartService {
  getConfig(): BitcartConfig {
    const baseUrl = process.env.BITCART_BASE_URL?.trim();
    const apiKey = process.env.BITCART_API_KEY?.trim();
    const storeId = process.env.BITCART_STORE_ID?.trim();
    if (!baseUrl || !apiKey || !storeId) {
      throw new Error(
        'Bitcart not configured: BITCART_BASE_URL, BITCART_API_KEY, and BITCART_STORE_ID are required',
      );
    }
    return { baseUrl, apiKey, storeId };
  }

  isConfigured(): boolean {
    try {
      this.getConfig();
      return true;
    } catch {
      return false;
    }
  }

  validateCoinNetwork(coin: string, network: string): void {
    const networkLower = (network || '').toLowerCase();
    const desiredCurrency = NETWORK_CURRENCY[networkLower];
    if (!desiredCurrency) {
      throw new Error(`Bitcart does not support network: ${network}`);
    }
    const coinLower = (coin || '').toLowerCase();
    const isNative = coinLower === desiredCurrency;
    const desiredContract = isNative
      ? ''
      : normalizeContract(TOKEN_CONTRACTS[`${coinLower}:${desiredCurrency}`] || '');
    if (!isNative && !desiredContract) {
      throw new Error(`Bitcart does not support ${coin} on ${network}`);
    }
  }

  parseStatus(status: string): string | null {
    return STATUS_MAP[(status || '').toLowerCase()] || null;
  }

  async fetchWallets(signal?: AbortSignal): Promise<any[]> {
    const { baseUrl, apiKey } = this.getConfig();
    const now = Date.now();
    if (walletCache && now - walletCache.fetchedAt < WALLET_CACHE_TTL_MS) {
      return walletCache.data;
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_WALLETS_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl}/wallets`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ?? ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bitcart fetchWallets error ${res.status}: ${text}`);
    }
    const body = await res.json();
    const wallets = Array.isArray(body) ? body : body?.result || [];
    walletCache = { data: wallets, fetchedAt: now };
    return wallets;
  }

  selectWalletId(wallets: any[], coin: string, network: string): string {
    const networkLower = (network || '').toLowerCase();
    const desiredCurrency = NETWORK_CURRENCY[networkLower];
    if (!desiredCurrency) {
      throw new Error(`Bitcart does not support network: ${network}`);
    }
    const coinLower = (coin || '').toLowerCase();
    const isNative = coinLower === desiredCurrency;
    const desiredContract = isNative
      ? ''
      : normalizeContract(TOKEN_CONTRACTS[`${coinLower}:${desiredCurrency}`] || '');
    if (!isNative && !desiredContract) {
      throw new Error(`Bitcart does not support ${coin} on ${network}`);
    }

    const wallet = wallets.find((w) => {
      const wc = (w.currency || '').toLowerCase();
      const wContract = normalizeContract(w.contract);
      return wc === desiredCurrency && wContract === desiredContract;
    });
    if (!wallet) {
      throw new Error(`Bitcart wallet not found for ${coin} on ${network}`);
    }
    return wallet.id;
  }

  async createInvoice(opts: {
    amount: number;
    coin: string;
    network: string;
    orderId: string;
    currency?: string;
    signal?: AbortSignal;
  }): Promise<BitcartCreateInvoiceResult> {
    const { baseUrl, apiKey, storeId } = this.getConfig();
    const secret = process.env.BITCART_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new Error(
        'Bitcart not configured: BITCART_WEBHOOK_SECRET is required',
      );
    }

    const base = process.env.BASE_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim();
    if (!base) {
      throw new Error(
        'Bitcart not configured: BASE_URL or NEXT_PUBLIC_BASE_URL is required',
      );
    }
    const notificationUrl = `${base}/api/payments/bitcart/webhook?token=${encodeURIComponent(secret)}`;

    const ctrl = new AbortController();
    const timeout = setTimeout(
      () => ctrl.abort(new Error('bitcart createInvoice timeout')),
      CREATE_INVOICE_TIMEOUT_MS,
    );
    let fetchSignal = ctrl.signal;
    if (opts.signal) {
      fetchSignal =
        typeof (AbortSignal as any).any === 'function'
          ? (AbortSignal as any).any([ctrl.signal, opts.signal])
          : opts.signal;
    }

    let walletId: string;
    try {
      const wallets = await this.fetchWallets(fetchSignal);
      walletId = this.selectWalletId(wallets, opts.coin, opts.network);
    } catch (err: any) {
      clearTimeout(timeout);
      throw new Error(`Bitcart wallet selection failed: ${err.message}`);
    }

    let res;
    try {
      res = await fetch(`${baseUrl}/invoices`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          store_id: storeId,
          price: opts.amount,
          currency: opts.currency || process.env.BITCART_CURRENCY || 'USD',
          order_id: opts.orderId,
          notification_url: notificationUrl,
          payment_methods: [walletId],
        }),
        signal: fetchSignal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bitcart createInvoice error ${res.status}: ${text}`);
    }
    const inv = await res.json();
    if (!inv.id) {
      throw new Error('Bitcart createInvoice returned no invoice id');
    }
    const pm = (inv.payments || [])[0] || {};
    return {
      gatewayId: String(inv.id),
      paymentUrl: pm.payment_url || null,
      payAddress: pm.payment_address || null,
      amountExpected: opts.amount,
      cryptoAmount: pm.amount ?? null,
      cryptoCurrency: pm.currency ?? null,
      expiresAt: inv.expiration || inv.time_left || null,
    };
  }

  async getInvoice(gatewayId: string): Promise<any> {
    const { baseUrl, apiKey } = this.getConfig();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), GET_INVOICE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl}/invoices/${gatewayId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bitcart API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  verifyAuth(token: string): boolean {
    const secret = process.env.BITCART_WEBHOOK_SECRET?.trim();
    if (!secret || !token) {
      return false;
    }
    const a = Buffer.from(secret, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }
}
