import { test, expect } from '@playwright/test';

/**
 * E2E Test Suite for Story 3.4: Bàn giao Credential Tức thì & Lịch sử Đơn hàng
 * - AC #1: Hiển thị credential ngay sau khi mua cùng nút "Sao chép" và link "Xem đơn hàng →"
 * - AC #2: Gửi thông báo Telegram Bot (fire-and-forget không gián đoạn checkout)
 * - AC #3: Đơn hàng hiển thị vĩnh viễn trong tab "Đơn hàng của tôi" với đầy đủ thông tin và credential
 */
test.describe('Story 3.4: Orders & Immediate Credential Handover', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');
  });

  test('Bottom navigation toggles between Store and Orders tabs', async ({ page }) => {
    // 1. Verify BottomNav presence
    const storeTab = page.locator('a[href="/"]');
    const ordersTab = page.locator('a[href="/orders"]');

    await expect(storeTab).toBeVisible();
    await expect(ordersTab).toBeVisible();

    // 2. Navigate to Orders tab
    await ordersTab.click();
    await expect(page).toHaveURL('http://localhost:3000/orders');
    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();

    // 3. Return to Store tab
    await storeTab.click();
    await expect(page).toHaveURL('http://localhost:3000/');
  });

  test('Complete purchase flow: one-tap checkout, credential modal, and orders history', async ({ page }) => {
    // 1. Select an in-stock product
    const buyButton = page.locator('button:has-text("Mua ngay")').first();
    await buyButton.click();

    // 2. Checkout modal appears
    await expect(page.getByRole('heading', { name: 'Xác nhận mua hàng' })).toBeVisible();
    const confirmButton = page.locator('button:has-text("Xác nhận")');
    await confirmButton.click();

    // 3. Success modal displays credential and copy button
    await expect(page.getByRole('heading', { name: 'Mua hàng thành công!' })).toBeVisible();
    await expect(page.getByText('Key / Tài khoản của bạn')).toBeVisible();

    const copyBtn = page.locator('button:has-text("Copy key")');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // 4. Navigate to Orders history via link in modal
    const viewOrdersLink = page.locator('a:has-text("Xem đơn hàng →")');
    await expect(viewOrdersLink).toBeVisible();
    await viewOrdersLink.click();

    // 5. Verify order is displayed in history tab
    await expect(page).toHaveURL('http://localhost:3000/orders');
    await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();

    // Status badge and credential box are present
    await expect(page.getByText('FULFILLED')).toBeVisible();
    await expect(page.getByText('Credential')).toBeVisible();
    await expect(page.getByText('Sử dụng key/tài khoản trên để kích hoạt sản phẩm.')).toBeVisible();

    const orderCopyBtn = page.locator('button:has-text("Sao chép")').first();
    await expect(orderCopyBtn).toBeVisible();
    await orderCopyBtn.click();
  });
});
