import { test } from 'node:test';
import assert from 'node:assert';
import { VietQRService } from './vietqr.service';

const vietQR = new VietQRService();
const bankBin = '970436';
const accountNo = '1234567890';
const transferContent = '9R_TOPUP_7F3A';

test('VietQRService.generateTransferContent returns 9R_TOPUP_<6-hex-code>', () => {
  const code = vietQR.generateTransferContent();
  assert.match(code, /^9R_TOPUP_[0-9A-F]{6}$/);
});

test('VietQRService.generateVietQRPayload builds EMVCo QR string with valid CRC', () => {
  const payload = vietQR.generateVietQRPayload({
    bankBin,
    accountNo,
    amount: 200000,
    transferContent,
  });

  assert.ok(payload.startsWith('000201010212'), 'starts with payload format + initiation method');
  assert.ok(payload.includes('38'), 'has merchant account info tag');
  assert.ok(payload.includes('A000000727'), 'has NAPAS GUID');
  assert.ok(payload.includes(bankBin), 'has bank BIN');
  assert.ok(payload.includes(accountNo), 'has account number');
  assert.ok(payload.includes('5303704'), 'has transaction currency VND');
  assert.ok(payload.includes('54'), 'has transaction amount tag');
  assert.ok(payload.includes('5802VN'), 'has country code VN');
  assert.ok(payload.includes('62'), 'has additional data tag');
  assert.ok(payload.includes(transferContent), 'has transfer content');

  // Verify CRC is 4-char uppercase hex and validates
  const crcIndex = payload.indexOf('6304');
  assert.ok(crcIndex > 0, 'has CRC tag');
  const crcValue = payload.slice(crcIndex + 4);
  assert.match(crcValue, /^[0-9A-F]{4}$/, 'CRC is 4 hex chars');

  // Verify CRC calculation is correct by re-computing
  const payloadWithoutCrc = payload.slice(0, crcIndex + 4);
  const expectedCrc = crc16CCITT(payloadWithoutCrc);
  assert.strictEqual(crcValue, expectedCrc, 'CRC matches computed value');
});

test('VietQRService.generateVietQRUrl returns img.vietqr.io URL', () => {
  const url = vietQR.generateVietQRUrl({
    bankBin,
    accountNo,
    amount: 200000,
    transferContent,
  });

  assert.strictEqual(
    url,
    `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.jpg?amount=200000&addInfo=9R_TOPUP_7F3A`,
    'URL has correct format',
  );
});

test('VietQRService.generateVietQRUrl URL-encodes transferContent', () => {
  const url = vietQR.generateVietQRUrl({
    bankBin,
    accountNo,
    amount: 50000,
    transferContent: '9R_TOPUP_XX Y',
  });

  assert.ok(url.includes('addInfo=9R_TOPUP_XX%20Y'), 'transfer content is URL encoded');
});

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
