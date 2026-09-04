import { test, expect, type Page, type TestInfo } from '@playwright/test';

import {appleCredential} from './apple-auth-fixture.js';

async function signInViaPhone(page:Page,email:string) {
  const phone=await page.request.post('/api/auth/apple',{data:appleCredential(email)});
  expect(phone.status()).toBe(200);
  const {token}=await phone.json();
  const nextQR=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/pairing/start' && response.status()===201);
  if(page.url().startsWith('http')) await page.reload();
  else await page.goto('/');
  const {pairing}=await (await nextQR).json();
  const approval=await page.request.post('/api/pairing/approve',{headers:{Authorization:`Bearer ${token}`},data:{id:pairing.id,token:new URL(pairing.qrUrl).searchParams.get('token')}});
  expect(approval.status()).toBe(200);
  await expect(page.locator('#workspace')).toBeVisible();
}

async function register(page: Page, info: TestInfo) {
  const email = `mvp-smoke-${info.project.name}-${Date.now()}-${info.workerIndex}@example.test`;
  await signInViaPhone(page,email);
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
  return email;
}

async function addApp(page: Page, project: string, source: 'apple' | 'revenuecat' = 'apple') {
  await page.getByRole('link', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill(`Smoke ${project} ${source}`);
  await page.getByLabel('Bundle ID', { exact: true }).fill(`com.example.smoke.${project}.${source}`);
  await page.getByLabel('Numeric Apple ID', { exact: true }).fill('123456789');
  await page.getByLabel('Current notification setup', { exact: true }).selectOption(source);
  await page.getByRole('button', { name: 'Add app and show setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Apple notifications', exact: true })).toBeVisible();
}

test('account, app setup, real/demo separation, preferences and logout work end to end', async ({ page, context }, info) => {
  const exceptions: string[] = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  const email = await register(page, info);
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === 'Strict')).toBeTruthy();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  await addApp(page, info.project.name);
  await expect(page.getByLabel('Production webhook URL', { exact: true })).toHaveValue(/\/production$/);
  await expect(page.getByLabel('Sandbox webhook URL', { exact: true })).toHaveValue(/\/sandbox$/);
  await expect(page.locator('.connection-list p').filter({ hasText: 'Waiting for Apple · No signed event received' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Create demo sale', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.locator('#event-list .tag.demo')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'New sale', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Create demo refund', exact: true }).click();
  await expect(page.locator('#event-list .tag.demo')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Refund issued', exact: true })).toBeVisible();

  await page.getByLabel('Environment', { exact: true }).selectOption('Production');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No activity yet', exact: true })).toBeVisible();
  await page.getByLabel('Environment', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('#event-list .event-item')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Load older activity', exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath(`${info.project.name}-activity.png`), fullPage: true });

  await addApp(page, info.project.name, 'revenuecat');
  await expect(page.getByText('Keep RevenueCat’s existing Apple production and sandbox URLs in App Store Connect. Do not replace them with this service’s URLs.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('RevenueCat Apple forwarding URL', { exact: true })).toHaveValue(/\/forward$/);
  await expect(page.getByLabel('Production webhook URL', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.locator('.connection-list p').filter({ hasText: 'Waiting for Apple · No signed event received' })).toHaveCount(4);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Purchases and renewals', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Refunds and refund reversals', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Include sandbox notifications', { exact: true })).not.toBeChecked();
  await page.getByLabel('Trials, auto-renew changes, billing issues, and expiry', { exact: true }).check();
  await page.getByLabel('Hide sale amounts in push notifications', { exact: true }).check();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  await expect(page.getByText(/iPhone push delivery is not configured/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Hide sale amounts in push notifications', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Trials, auto-renew changes, billing issues, and expiry', { exact: true })).toBeChecked();
  await expect(page.getByText(/No iPhones registered/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in with your iPhone', exact: true })).toBeVisible();
  await signInViaPhone(page,email);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Apps', exact: true }).click();
  await expect(page.locator('#app-list .app-item')).toHaveCount(2);
  await expect(page.locator('.connection-list p').filter({ hasText: 'Waiting for Apple · No signed event received' })).toHaveCount(4);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(exceptions).toEqual([]);
});

test('lookup failure preserves manual entry; delivery errors and pagination remain readable', async ({ page }, info) => {
  await register(page, info);
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  await page.getByLabel('App Store URL or numeric Apple ID', { exact: false }).fill('not-an-apple-url');
  await page.getByRole('button', { name: 'Look up app', exact: true }).click();
  await expect(page.getByText(/You can still enter the details manually below/)).toBeVisible();
  await expect(page.getByLabel('App name', { exact: true })).toBeEditable();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Explicitly synthetic response fixtures exercise states that require real APNs
  // credentials or more than the demo rate limit; they never fake Apple verification.
  await page.route('**/api/devices', (route) => route.fulfill({ json: { devices: [{
    id: 'fixture-device', name: 'Synthetic delivery-test phone', environment: 'sandbox', active: true,
    createdAt: '2026-09-03T12:00:00Z', lastSeenAt: '2026-09-03T12:00:00Z',
  }] } }));
  await page.route('**/api/deliveries?*', (route) => route.fulfill({ json: { deliveries: [{
    id: 'fixture-delivery', eventId: null, deviceId: 'fixture-device', deviceName: 'Synthetic delivery-test phone',
    state: 'failed', attempts: 8, lastError: 'Synthetic APNs rejection for browser testing.',
    createdAt: '2026-09-03T12:00:00Z', updatedAt: '2026-09-03T12:01:00Z',
  }] } }));
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send test push', exact: true })).toBeDisabled();
  await expect(page.getByText('Synthetic APNs rejection for browser testing.', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();

  const fixtureEvent = (id: string) => ({
    id, appId: 'fixture-app', appName: 'Synthetic pagination fixture', kind: 'sale', title: `Synthetic event ${id}`,
    detail: 'Demo only: a browser pagination fixture.', amountMilliunits: 4990, currency: 'USD',
    productId: 'fixture.product', transactionId: null, environment: 'Demo', isMonetary: false,
    occurredAt: '2026-09-03T12:00:00Z', receivedAt: '2026-09-03T12:00:00Z', notificationType: 'DEMO', subtype: null,
  });
  const requests: string[] = [];
  await page.route('**/api/events?*', (route) => {
    requests.push(route.request().url());
    const older = new URL(route.request().url()).searchParams.has('before');
    return route.fulfill({ json: { events: [fixtureEvent(older ? 'older' : 'newest')], nextCursor: older ? null : 'newest' } });
  });
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByLabel('Environment', { exact: true }).selectOption('Demo');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic event newest', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load older activity', exact: true }).click();
  await expect(page.locator('#event-list .event-item')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Load older activity', exact: true })).toBeHidden();
  expect(requests.some((url) => url.includes('environment=Demo') && url.includes('before=newest'))).toBeTruthy();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
});
