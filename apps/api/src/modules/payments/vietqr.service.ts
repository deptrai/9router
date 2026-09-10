import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

export interface VietQROptions {
  bankBin: string;
  accountNo: string;
  amount: number;
  transferContent: string;
}

export interface BankInfo {
  bankName: string;
  bankBin: string;
  accountNumber: string;
}

@Injectable()
export class VietQRService {
  private readonly transferPrefix = '9R_TOPUP_';

  generateTransferContent(): string {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${this.transferPrefix}${suffix}`;
  }

  generateVietQRPayload(opts: VietQROptions): string {
    const { bankBin, accountNo, amount, transferContent } = opts;

    const merchantAccInfo = buildTLV('00', 'A000000727') + buildTLV('01', bankBin) + buildTLV('02', accountNo);

    let payload = '';
    payload += buildTLV('00', '01'); // Payload Format Indicator
    payload += buildTLV('01', '12'); // Point of Initiation Method (dynamic)
    payload += buildTLV('38', merchantAccInfo); // Merchant Account Info (NAPAS)
    payload += buildTLV('53', '704'); // Transaction Currency (VND)
    payload += buildTLV('54', String(Math.floor(amount))); // Transaction Amount
    payload += buildTLV('58', 'VN'); // Country Code
    payload += buildTLV('62', buildTLV('08', transferContent)); // Additional Data — Purpose of Transaction

    // CRC placeholder + compute
    payload += '6304';
    const crc = crc16CCITT(payload);
    payload += crc;

    return payload;
  }

  generateVietQRUrl(opts: VietQROptions): string {
    const { bankBin, accountNo, amount, transferContent } = opts;
    return `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.jpg?amount=${Math.floor(amount)}&addInfo=${encodeURIComponent(transferContent)}`;
  }

  isConfigured(bankBin?: string, accountNo?: string): boolean {
    return !!bankBin && !!accountNo;
  }
}

function buildTLV(id: string, value: string): string {
  const len = String(value.length).padStart(2, '0');
  return id + len + value;
}

function crc16CCITT(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
