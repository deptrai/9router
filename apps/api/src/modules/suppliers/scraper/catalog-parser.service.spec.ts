import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { CatalogParserService, stripLeadingEmoji, groupProductBlocks } from './catalog-parser.service';

test('[P0] stripLeadingEmoji strips leading symbols and whitespace cleanly', () => {
  assert.strictEqual(stripLeadingEmoji('👑 Netflix Premium 4K'), 'Netflix Premium 4K');
  assert.strictEqual(stripLeadingEmoji('📦 🔥 YouTube Premium 1 Năm'), 'YouTube Premium 1 Năm');
  assert.strictEqual(stripLeadingEmoji('Plain Product Name'), 'Plain Product Name');
  assert.strictEqual(stripLeadingEmoji('   Spotify Family   '), 'Spotify Family');
});

test('[P0] groupProductBlocks skips preamble and preserves ordered lists in descriptions', () => {
  const text = `
THÔNG BÁO TỪ BOT:
Chào mừng bạn đến với shop!

1. Netflix Premium 1 tháng
Hướng dẫn sử dụng:
1. Đăng nhập qua email
2. Đổi mật khẩu
💵 50.000đ · Còn hàng

2. Spotify Premium 1 năm
Gói tài khoản chính chủ
💵 250k
`;

  const blocks = groupProductBlocks(text);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[0].includes('Netflix Premium 1 tháng'));
  assert.ok(blocks[0].includes('1. Đăng nhập qua email'));
  assert.ok(blocks[0].includes('2. Đổi mật khẩu'));
  assert.ok(blocks[0].includes('50.000đ'));

  assert.ok(blocks[1].includes('Spotify Premium 1 năm'));
  assert.ok(blocks[1].includes('250k'));
});

test('[P0] CatalogParserService.parseTelegramCatalog parses text catalog with unit variations and SHA256 ID', () => {
  const parser = new CatalogParserService();
  const text = `
1. 👑 Netflix Ultra HD
Tài khoản 1 tháng xem 4K
💵 50.000đ · Còn hàng

2. Spotify Individual
1 năm nghe nhạc chất lượng cao
💵 50k

3. ChatGPT Plus 1 tháng
Sử dụng mô hình GPT-4o
💰 10 credits

4. Claude Pro 1 tháng
Tài khoản chính chủ Anthropic
Giá: 50000 vnd
`;

  const products = parser.parseTelegramCatalog(text, {
    botUsername: '@supplier_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(products.length, 4);

  // Product 1: 50.000đ
  assert.strictEqual(products[0].name, 'Netflix Ultra HD');
  assert.strictEqual(products[0].title, 'Netflix Ultra HD');
  assert.strictEqual(products[0].description, 'Tài khoản 1 tháng xem 4K');
  assert.strictEqual(products[0].priceVnd, 50000);
  assert.strictEqual(products[0].stock, null);
  assert.strictEqual(products[0].isActive, true);
  const expectedHash0 = crypto.createHash('sha256').update('supplier_bot:Netflix Ultra HD').digest('hex');
  assert.strictEqual(products[0].supplierProductId, expectedHash0);
  assert.strictEqual(products[0].supplierProductId.length, 64);

  // Product 2: 50k
  assert.strictEqual(products[1].name, 'Spotify Individual');
  assert.strictEqual(products[1].priceVnd, 50000);
  const expectedHash1 = crypto.createHash('sha256').update('supplier_bot:Spotify Individual').digest('hex');
  assert.strictEqual(products[1].supplierProductId, expectedHash1);

  // Product 3: 10 credits with 1000 vndPerCredit -> 10,000 VND
  assert.strictEqual(products[2].name, 'ChatGPT Plus 1 tháng');
  assert.strictEqual(products[2].priceVnd, 10000);
  assert.strictEqual(products[2].priceCredits, 10);
  const expectedHash2 = crypto.createHash('sha256').update('supplier_bot:ChatGPT Plus 1 tháng').digest('hex');
  assert.strictEqual(products[2].supplierProductId, expectedHash2);

  // Product 4: 50000 vnd
  assert.strictEqual(products[3].name, 'Claude Pro 1 tháng');
  assert.strictEqual(products[3].priceVnd, 50000);
  const expectedHash3 = crypto.createHash('sha256').update('supplier_bot:Claude Pro 1 tháng').digest('hex');
  assert.strictEqual(products[3].supplierProductId, expectedHash3);
});

test('[P0] CatalogParserService.parseTelegramButtonCatalog parses button array with SHA256 ID', () => {
  const parser = new CatalogParserService();
  const buttons = [
    { text: '50k | 🟢 Còn hàng | Netflix Premium [ID 101]' },
    { text: '💰 10 credits | Sẵn sàng | Claude Pro [ID 202]' },
    { text: '50.000đ | ⛔ Hết hàng | Spotify Family [ID 303]' },
    { text: 'Quay lại menu chính' }, // ignored because < 3 parts
  ];

  const products = parser.parseTelegramButtonCatalog(buttons, {
    botUsername: 'button_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(products.length, 3);

  // Button 1: not sold out
  assert.strictEqual(products[0].name, 'Netflix Premium');
  assert.strictEqual(products[0].title, 'Netflix Premium');
  assert.strictEqual(products[0].priceVnd, 50000);
  assert.strictEqual(products[0].stock, null);
  assert.strictEqual(products[0].isActive, true);
  const expectedHash0 = crypto.createHash('sha256').update('button_bot:Netflix Premium').digest('hex');
  assert.strictEqual(products[0].supplierProductId, expectedHash0);

  // Button 2: 10 credits
  assert.strictEqual(products[1].name, 'Claude Pro');
  assert.strictEqual(products[1].priceVnd, 10000);
  assert.strictEqual(products[1].stock, null);
  assert.strictEqual(products[1].isActive, true);

  // Button 3: sold out
  assert.strictEqual(products[2].name, 'Spotify Family');
  assert.strictEqual(products[2].priceVnd, 50000);
  assert.strictEqual(products[2].stock, 0);
  assert.strictEqual(products[2].isActive, false);
  const expectedHash2 = crypto.createHash('sha256').update('button_bot:Spotify Family').digest('hex');
  assert.strictEqual(products[2].supplierProductId, expectedHash2);
});

test('[P1] CatalogParserService marks sold-out products with stock=0 and isActive=false', () => {
  const parser = new CatalogParserService();
  const text = `
1. Product A
💵 50k · ⛔ Tạm hết hàng

2. Product B
💵 50k · SOLD OUT

3. Product C
💵 50k · Hết hàng
`;

  const products = parser.parseTelegramCatalog(text, {
    botUsername: 'test_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(products.length, 3);
  for (const product of products) {
    assert.strictEqual(product.stock, 0);
    assert.strictEqual(product.isActive, false);
  }
});

test('[P1] CatalogParserService skips items with invalid prices or empty names', () => {
  const parser = new CatalogParserService();
  const text = `
1. Invalid Free Item
💵 0đ

2. Valid Item
💵 100k

3.
💵 50k
`;

  const products = parser.parseTelegramCatalog(text, {
    botUsername: 'test_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(products.length, 1);
  assert.strictEqual(products[0].name, 'Valid Item');
  assert.strictEqual(products[0].priceVnd, 100000);
});

test('[P1] CatalogParserService throws PARSER_ZERO_PRODUCTS when 0 products parsed', () => {
  const parser = new CatalogParserService();

  assert.throws(
    () => parser.parseTelegramCatalog('Nothing here', { botUsername: 'bot', vndPerCredit: 1000 }),
    (err: any) => err.message === 'PARSER_ZERO_PRODUCTS'
  );

  assert.throws(
    () => parser.parseTelegramButtonCatalog([], { botUsername: 'bot', vndPerCredit: 1000 }),
    (err: any) => err.message === 'PARSER_ZERO_PRODUCTS'
  );
});

test('[P1] CatalogParserService truncates long titles to 255 and descriptions to 4000', () => {
  const parser = new CatalogParserService();
  const longName = 'A'.repeat(300);
  const longDesc = 'B'.repeat(5000);
  const text = `
1. ${longName}
${longDesc}
💵 50k
`;

  const [product] = parser.parseTelegramCatalog(text, {
    botUsername: 'test_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(product.name.length, 255);
  assert.strictEqual(product.title.length, 255);
  assert.strictEqual(product.description?.length, 4000);
});

test('[P1] CatalogParserService handles vnđ / VNĐ correctly without false positive on line-start words', () => {
  const parser = new CatalogParserService();
  const text = `
1. Gói xem phim
Màn hình 4K Ultra HD sắc nét
Giá: 70.000 vnđ

2. Gói nghe nhạc
Hỗ trợ 8k thiết bị
Giá: 120.000 VNĐ
`;

  const products = parser.parseTelegramCatalog(text, {
    botUsername: 'media_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(products.length, 2);
  assert.strictEqual(products[0].priceVnd, 70000);
  assert.ok(products[0].description?.includes('4K Ultra HD'));
  assert.strictEqual(products[1].priceVnd, 120000);
  assert.ok(products[1].description?.includes('8k thiết bị'));
});

test('[P1] CatalogParserService includes plan duration in button titles to prevent SHA256 collisions', () => {
  const parser = new CatalogParserService();
  const buttons = [
    { text: '50k | 1 tháng | Netflix Premium [ID 101]' },
    { text: '120k | 3 tháng | Netflix Premium [ID 102]' },
  ];

  const products = parser.parseTelegramButtonCatalog(buttons, {
    botUsername: 'streaming_bot',
    vndPerCredit: 1000,
  });

  assert.strictEqual(products.length, 2);
  assert.notStrictEqual(products[0].supplierProductId, products[1].supplierProductId);
  assert.ok(products[0].name.includes('1 tháng'));
  assert.ok(products[1].name.includes('3 tháng'));
});

test('[P1] CatalogParserService.parse dispatches to text and button modes properly', () => {
  const parser = new CatalogParserService();

  // Parse string data directly
  const fromString = parser.parse('1. Test Product\n💵 50k', {
    botUsername: 'bot',
    vndPerCredit: 1000,
  });
  assert.strictEqual(fromString.length, 1);
  assert.strictEqual(fromString[0].name, 'Test Product');

  // Parse object with messages
  const fromMessages = parser.parse(
    { messages: ['1. Message Product\n💵 60k'] },
    { botUsername: 'bot', vndPerCredit: 1000 }
  );
  assert.strictEqual(fromMessages.length, 1);
  assert.strictEqual(fromMessages[0].name, 'Message Product');

  // Parse object with buttons
  const fromButtons = parser.parse(
    { buttons: [{ text: '50k | 1 month | Button Product' }] },
    { botUsername: 'bot', vndPerCredit: 1000 }
  );
  assert.strictEqual(fromButtons.length, 1);
  assert.ok(fromButtons[0].name.includes('Button Product'));

  // parseMode='text' forces text parsing even if leftover buttons exist
  const forcedText = parser.parse(
    {
      messages: ['1. Forced Text Product\n💵 75k'],
      buttons: [{ text: '50k | 1 month | Ignored Button' }],
    },
    {
      botUsername: 'bot',
      vndPerCredit: 1000,
      parseMode: 'text',
    }
  );
  assert.strictEqual(forcedText.length, 1);
  assert.strictEqual(forcedText[0].name, 'Forced Text Product');
});
