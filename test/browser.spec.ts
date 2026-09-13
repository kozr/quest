import { test, expect, type Page, type TestInfo } from '@playwright/test';

import {appleCredential} from './apple-auth-fixture.js';
import {mkdir} from 'node:fs/promises';

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
  await page.locator('#app-find-help').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  await page.getByRole('button', { name: 'Enter details manually', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill(`Smoke ${project} ${source}`);
  await page.getByLabel('Bundle ID', { exact: true }).fill(`com.example.smoke.${project}.${source}`);
  await page.getByLabel('Numeric Apple ID', { exact: true }).fill('123456789');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Current notification setup', { exact: true }).selectOption(source);
  await page.getByRole('button', { name: 'Add app & show connection steps', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Apple notifications', exact: true })).toBeVisible();
}

test('existing Apple URLs can be saved, corrected, inspected, and disabled independently', async ({ page }, info) => {
  await register(page,info);await addApp(page,info.project.name);
  const forwarding = page.locator('.forwarding-settings');
  await expect(forwarding.getByText('Open settings', {exact:true})).toBeVisible();
  await expect(forwarding.getByText(/Before replacing existing URLs/)).toBeVisible();
  await page.emulateMedia({colorScheme: 'dark'});
  await forwarding.screenshot({path: info.outputPath('forwarding-collapsed-dark.png')});
  await page.emulateMedia({colorScheme: 'light'});
  await forwarding.screenshot({path: info.outputPath('forwarding-collapsed-light.png')});
  await forwarding.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(forwarding.getByText('Close settings', {exact:true})).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(forwarding).not.toHaveAttribute('open', '');
  await page.getByText('Forward to your existing server', {exact:true}).click();
  const production=page.getByLabel('Existing production server URL',{exact:true});
  const sandbox=page.getByLabel('Existing sandbox server URL',{exact:true});
  await production.fill('https://backend.example.com/apple/production?token=example');
  await sandbox.fill('https://sandbox.example.com/apple');
  await page.getByRole('button',{name:'Save forwarding',exact:true}).click();
  await expect(page.getByText(/^Forwarding saved\./)).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Show setup',exact:true}).click();
  await expect(production).toHaveValue('https://backend.example.com/apple/production?token=example');
  await expect(sandbox).toHaveValue('https://sandbox.example.com/apple');
  await production.fill('https://10.0.0.1/apple');
  await page.getByRole('button',{name:'Save forwarding',exact:true}).click();
  await expect(page.getByText('Use a publicly reachable server for forwarding.',{exact:true})).toBeVisible();
  await expect(sandbox).toHaveValue('https://sandbox.example.com/apple');
  await production.fill('https://backend.example.com/apple/production?token=example');
  await page.getByRole('button',{name:'Save forwarding',exact:true}).click();
  await expect(page.getByText(/^Forwarding saved\./)).toBeVisible();
  await page.getByRole('button',{name:'Refresh forwarding deliveries',exact:true}).click();
  await expect(page.getByText(/^No forwarding deliveries yet\./)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await mkdir('.impeccable/review',{recursive:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:`.impeccable/review/forwarding-${info.project.name}.png`,fullPage:true});
  await production.fill('');await page.getByRole('button',{name:'Save forwarding',exact:true}).click();
  await expect(page.getByText(/^Forwarding saved\./)).toBeVisible();
  const result=await page.request.get('/api/apps');const {apps}=await result.json();
  expect(apps[0].forwarding).toEqual({productionUrl:null,sandboxUrl:'https://sandbox.example.com/apple'});
  await sandbox.fill('');await page.getByRole('button',{name:'Save forwarding',exact:true}).click();
  await expect(page.getByText(/^Forwarding is off\./)).toBeVisible();
});

test('account, app setup, real/demo separation, preferences and logout work end to end', async ({ page, context }, info) => {
  const exceptions: string[] = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  const email = await register(page, info);
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === 'Strict')).toBeTruthy();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  await addApp(page, info.project.name);
  const connectLink = page.getByRole('link', { name: 'Open App Store Connect (opens in a new tab)', exact: true });
  await expect(connectLink).toBeVisible();
  await expect(connectLink).toHaveAttribute('href', 'https://appstoreconnect.apple.com/apps/123456789/distribution/info#:~:text=App%20Store%20Server%20Notifications');
  await expect(connectLink).toHaveAttribute('target', '_blank');
  await expect(connectLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath(`${info.project.name}-setup.png`), fullPage: true });
  await expect(page.getByLabel('Production webhook URL', { exact: true })).toHaveValue(/\/production$/);
  await expect(page.getByLabel('Sandbox webhook URL', { exact: true })).toHaveValue(/\/sandbox$/);
  await expect(page.locator('.connection-list p').filter({ hasText: 'Waiting for Apple · No signed event received' })).toHaveCount(2);
  await page.getByText('Try a labelled demo', { exact: true }).click();
  await page.getByRole('button', { name: 'Create demo sale', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.locator('#event-list .tag.demo')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'New sale', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Apps', exact: true }).click();
  await page.getByText('Try a labelled demo', { exact: true }).click();
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
  await expect(page.getByLabel('New purchases', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Refunds issued', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Include sandbox notifications', { exact: true })).not.toBeChecked();
  await page.getByLabel('Free trials started', { exact: true }).check();
  await page.getByLabel('Subscription renewals', { exact: true }).uncheck();
  await page.getByLabel('Hide sale amounts in push notifications', { exact: true }).check();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  await expect(page.getByText(/iPhone push delivery is not configured/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Hide sale amounts in push notifications', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Free trials started', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Subscription renewals', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('New purchases', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Billing issues', { exact: true })).not.toBeChecked();
  await page.screenshot({path: `/tmp/iap-preferences-${info.project.name}.png`, fullPage: true});
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
  await page.getByLabel('Find your app', { exact: true }).fill('https://example.invalid/id123');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#lookup-message')).toContainText('enter details manually');
  await page.getByRole('button', { name: 'Enter details manually', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Send test alert', exact: true })).toBeDisabled();
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

test('optional Apple connection test shows waiting, verifies receipt, clears key and exposes phone setup state',async({page},info)=>{
  await register(page,info);await addApp(page,info.project.name);
  await page.getByRole('heading',{name:'Test iPhone delivery',exact:true}).click();
  await expect(page.getByRole('button',{name:'Send test alert',exact:true})).toBeDisabled();
  await page.getByText('Optional: test your Apple connection',{exact:true}).click();
  await page.getByLabel('Key ID',{exact:true}).fill('ABCDEFGHIJ');
  await page.getByLabel('Issuer ID',{exact:true}).fill('12345678-1234-4123-8123-123456789abc');
  await page.getByLabel('In-App Purchase private key (.p8)',{exact:true}).setInputFiles({name:'test.p8',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic-private-key')});
  await expect(page.getByLabel('Test environment',{exact:true})).toHaveValue('Sandbox');
  let checks=0;
  await page.route('**/api/apps/*/apple-test',async route=>{
    expect(route.request().postDataJSON().privateKey).toBe('synthetic-private-key');
    await route.fulfill({status:202,json:{testNotificationToken:'test-token'}});
  });
  await page.route('**/api/apps/*/apple-test/status',async route=>{
    checks++;
    await route.fulfill({json:{state:checks===1 ? 'waiting' : 'received',appleDelivery:'SUCCESS',receivedAt:checks===1 ? null : new Date().toISOString()}});
  });
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:info.outputPath(`${info.project.name}-optional-tests.png`),fullPage:true});
  await page.getByRole('button',{name:'Test Apple connection',exact:true}).click();
  await expect(page.getByText('Apple accepted the request. Waiting for the signed notification to reach Quest…',{exact:true})).toBeVisible();
  await expect(page.getByLabel('In-App Purchase private key (.p8)',{exact:true})).toHaveValue('');
  await expect(page.getByText(/Sandbox Apple test received and verified/)).toBeVisible({timeout:15000});
  expect(checks).toBe(2);
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
});

test('Apple test cancellation clears file and stops delivery checks; phone test queues for chosen device',async({page},info)=>{
  await page.route('**/api/config',async route=>{
    const response=await route.fetch();await route.fulfill({json:{...await response.json(),apnsConfigured:true}});
  });
  await register(page,info);await addApp(page,info.project.name);
  await page.route('**/api/devices',route=>route.fulfill({json:{devices:[{id:'phone-one',name:'My iPhone',active:true},{id:'phone-two',name:'Second iPhone',active:true}]}}));
  await page.getByRole('heading',{name:'Test iPhone delivery',exact:true}).click();
  let pushed='';
  await page.route('**/api/devices/*/test',async route=>{pushed=route.request().url();await route.fulfill({status:202,json:{queued:true}});});
  await page.getByRole('button',{name:'Send test alert',exact:true}).click();
  await page.getByLabel('iPhone for test alert',{exact:true}).selectOption('phone-two');
  await page.getByRole('button',{name:'Send test alert',exact:true}).click();
  await expect(page.getByText('Test queued · Check iPhone', { exact: true })).toBeVisible();
  await expect(page.locator('.phone-test')).not.toHaveAttribute('open', '');
  await page.getByRole('heading', { name: 'Test iPhone delivery', exact: true }).click();
  await expect(page.getByText(/Test alert queued for “Second iPhone”/)).toBeVisible();
  expect(pushed).toContain('/phone-two/test');
  await page.getByText('Optional: test your Apple connection',{exact:true}).click();
  await page.getByLabel('Key ID',{exact:true}).fill('ABCDEFGHIJ');
  await page.getByLabel('Issuer ID',{exact:true}).fill('12345678-1234-4123-8123-123456789abc');
  await page.getByLabel('In-App Purchase private key (.p8)',{exact:true}).setInputFiles({name:'test.p8',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic-private-key')});
  await page.route('**/api/apps/*/apple-test',route=>route.fulfill({status:202,json:{testNotificationToken:'test-token'}}));
  let checks=0;
  await page.route('**/api/apps/*/apple-test/status',async route=>{checks++;await route.fulfill({json:{state:'waiting'}});});
  await page.getByRole('button',{name:'Test Apple connection',exact:true}).click();
  await expect(page.getByText(/Apple accepted the request/)).toBeVisible();
  await page.getByRole('button',{name:'Cancel test',exact:true}).click();
  await expect(page.getByText(/Test check cancelled/)).toBeVisible();
  await expect(page.getByLabel('In-App Purchase private key (.p8)',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Test Apple connection',exact:true})).toBeEnabled();
  expect(checks).toBe(0);
});


test('completed setup substeps collapse, reopen and survive app refresh', async ({ page }, info) => {
  await register(page, info);
  await addApp(page, info.project.name);
  const connection = page.locator('.setup-step').filter({ has: page.getByRole('heading', { name: 'Connect Apple notifications', exact: true }) });
  await expect(page.getByRole('button', { name: 'Send test alert', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Create demo sale', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'URLs saved', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.phone-test > summary')).toBeFocused();
  await expect(page.locator('.phone-test')).toHaveAttribute('open', '');
  await expect(page.locator('.setup-progress')).toHaveText('URLs saved. Next, test delivery to your iPhone.');
  await expect(connection).not.toHaveAttribute('open', '');
  await expect(connection.locator(':scope > summary')).toContainText('URLs saved');
  await expect(page.getByLabel('Production webhook URL', { exact: true })).toBeHidden();
  await page.locator('#refresh-apps').click();
  await expect(connection.locator(':scope > summary')).toContainText('URLs saved');
  await expect(connection).not.toHaveAttribute('open', '');
  await connection.locator(':scope > summary').click();
  await expect(page.getByLabel('Production webhook URL', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-list p').filter({ hasText: 'Waiting for Apple · No signed event received' })).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('setup-reopened.png'), fullPage: true });
  await page.getByRole('button', { name: 'URLs saved', exact: true }).click();
  await page.screenshot({ path: info.outputPath('setup-collapsed.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath('setup-dark.png'), fullPage: true });
});

test('individual alert preferences persist without enabling neighboring categories', async ({page},info)=>{
  await register(page,info);
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await expect(page.getByLabel('New purchases',{exact:true})).toBeChecked();
  await expect(page.getByLabel('Subscription renewals',{exact:true})).toBeChecked();
  await page.getByLabel('Free trials started',{exact:true}).check();
  await page.getByLabel('Subscription renewals',{exact:true}).uncheck();
  await page.getByLabel('Refunds reversed',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Save preferences',exact:true}).click();
  await expect(page.getByText('Preferences saved.',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Free trials started',{exact:true})).toBeChecked();
  await expect(page.getByLabel('New purchases',{exact:true})).toBeChecked();
  await expect(page.getByLabel('Subscription renewals',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('Refunds issued',{exact:true})).toBeChecked();
  await expect(page.getByLabel('Refunds reversed',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('Billing issues',{exact:true})).not.toBeChecked();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:`/tmp/iap-preferences-${info.project.name}.png`,fullPage:true});
});

test('maximum history import paginates without date controls and clears credentials',async({page},info)=>{
  await register(page,info);await addApp(page,info.project.name);
  await page.getByRole('heading',{name:'Import past notifications',exact:true}).click();
  await expect(page.getByLabel('Import environment',{exact:true})).toHaveValue('Production');
  await expect(page.locator('input[type="date"], input[type="datetime-local"]')).toHaveCount(0);
  await page.getByLabel('Import Key ID',{exact:true}).fill('ABCDEFGHIJ');
  await page.getByLabel('Import Issuer ID',{exact:true}).fill('12345678-1234-4123-8123-123456789abc');
  await page.getByLabel('Import private key (.p8)',{exact:true}).setInputFiles({name:'test.p8',mimeType:'application/octet-stream',buffer:Buffer.from('history-key')});
  let pages=0;
  await page.route('**/api/apps/*/import-history',async route=>{
    const data=route.request().postDataJSON();
    expect(data.privateKey).toBe('history-key');expect(data.environment).toBe('Production');
    expect(data.startDate).toBeUndefined();expect(data.endDate).toBeUndefined();
    expect(data.cursor).toBe(pages?'next':undefined);pages++;
    await route.fulfill({json:pages===1?{imported:2,duplicates:1,skipped:0,cursor:'next'}:{imported:1,duplicates:0,skipped:1,cursor:null}});
  });
  await page.getByRole('button',{name:'Import past notifications',exact:true}).click();
  await expect(page.getByText('Import complete. Added 3 notifications; skipped 1 duplicates and 1 connection tests. View them in Activity. No phone alerts were sent.',{exact:true})).toBeVisible();
  expect(pages).toBe(2);
  await expect(page.getByLabel('Import private key (.p8)',{exact:true})).toHaveValue('');
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:`/tmp/iap-history-${info.project.name}.png`,fullPage:true});
});

test('history import reports empty results and can stop with safe retry guidance',async({page},info)=>{
  await register(page,info);await addApp(page,info.project.name);
  await page.getByRole('heading',{name:'Import past notifications',exact:true}).click();
  await page.getByLabel('Import Key ID',{exact:true}).fill('ABCDEFGHIJ');
  await page.getByLabel('Import Issuer ID',{exact:true}).fill('12345678-1234-4123-8123-123456789abc');
  const file={name:'test.p8',mimeType:'application/octet-stream',buffer:Buffer.from('history-key')};
  await page.getByLabel('Import private key (.p8)',{exact:true}).setInputFiles(file);
  await page.route('**/api/apps/*/import-history',route=>route.fulfill({json:{imported:0,duplicates:0,skipped:0,cursor:null}}));
  await page.getByRole('button',{name:'Import past notifications',exact:true}).click();
  await expect(page.getByText('No past notifications are available from Apple for this environment.',{exact:true})).toBeVisible();
  await page.unroute('**/api/apps/*/import-history');
  await page.route('**/api/apps/*/import-history',async route=>{
    await new Promise(resolve=>setTimeout(resolve,1000));
    await route.fulfill({json:{imported:1,duplicates:0,skipped:0,cursor:'more'}}).catch(()=>{});
  });
  await page.getByLabel('Import private key (.p8)',{exact:true}).setInputFiles(file);
  await page.getByRole('button',{name:'Import past notifications',exact:true}).click();
  await page.getByRole('button',{name:'Stop import',exact:true}).click();
  await expect(page.getByText(/Import stopped.*Choose your .p8 file again.*Retry import/)).toBeVisible();
  await expect(page.getByLabel('Import private key (.p8)',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Retry import',exact:true})).toBeEnabled();
});

test('production verification minimizes connection instructions while sandbox remains separate', async ({page},info)=>{
  await register(page,info);
  await addApp(page,info.project.name);
  const connection=page.locator('.setup-section > [data-step="urls"]');
  let production:string|null=null;
  let sandbox:string|null='2026-09-08T19:00:00Z';
  const data=await (await page.request.get('/api/apps')).json();
  await page.route('**/api/apps',async route=>{
    await route.fulfill({json:{...data,apps:data.apps.map((app:any)=>({...app,lastProductionEventAt:production,lastSandboxEventAt:sandbox}))}});
  });
  await page.locator('#refresh-apps').click();
  await expect(page.locator('#refresh-apps')).toBeEnabled();
  await expect(page.getByLabel('Production webhook URL',{exact:true})).toBeVisible();
  production='2026-09-08T20:00:00Z';sandbox=null;
  await page.locator('#refresh-apps').click();
  await expect(page.locator('#refresh-apps')).toBeEnabled();
  await expect(connection).not.toHaveAttribute('open','');
  await expect(connection.locator(':scope > summary')).toContainText('Production verified');
  await expect(page.getByLabel('Production webhook URL',{exact:true})).toBeHidden();
  await expect(page.locator('.connection-list p').filter({hasText:'Waiting for Apple · No signed event received'})).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:info.outputPath('verified-connection-collapsed.png'),fullPage:true});
  await page.getByText('Show connection details',{exact:true}).click();
  await expect(page.getByLabel('Sandbox webhook URL',{exact:true})).toBeVisible();
  await page.locator('#refresh-apps').click();
  await expect(page.locator('#refresh-apps')).toBeEnabled();
  await expect(page.getByLabel('Production webhook URL',{exact:true})).toBeVisible();
  await page.getByText('Hide connection details',{exact:true}).click();
  await page.locator('#refresh-apps').click();
  await expect(page.locator('#refresh-apps')).toBeEnabled();
  await expect(page.getByLabel('Production webhook URL',{exact:true})).toBeHidden();
});


test('history timeout gives one recovery step and lets the user retry with a fresh key',async({page},info)=>{
  await register(page,info);await addApp(page,info.project.name);
  await page.getByRole('heading',{name:'Import past notifications',exact:true}).click();
  await page.getByLabel('Import Key ID',{exact:true}).fill('ABCDEFGHIJ');
  await page.getByLabel('Import Issuer ID',{exact:true}).fill('12345678-1234-4123-8123-123456789abc');
  const key=page.getByLabel('Import private key (.p8)',{exact:true});
  const file={name:'test.p8',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic-history-key')};
  await key.setInputFiles(file);
  let requests=0;
  await page.route('**/api/apps/*/import-history',async route=>{
    requests++;
    expect(route.request().postDataJSON().privateKey).toBe('synthetic-history-key');
    await route.fulfill(requests===1
      ? {status:504,json:{error:'Apple took too long to return notification history.'}}
      : {json:{imported:1,duplicates:0,skipped:0,cursor:null}});
  });
  await page.getByRole('button',{name:'Import past notifications',exact:true}).click();
  const status=page.locator('[data-step="apple-history"] .form-message');
  await expect(status).toContainText('Apple took too long');
  await expect(status).toContainText('Choose your .p8 file again');
  expect((await status.textContent())?.match(/duplicates/gi)?.length).toBe(1);
  await expect(key).toHaveValue('');
  await expect(page.getByRole('button',{name:'Retry import',exact:true})).toBeEnabled();
  await page.emulateMedia({colorScheme:'dark'});
  await page.locator('[data-step="apple-history"]').screenshot({path:info.outputPath('history-retry.png')});
  await key.setInputFiles(file);
  await page.getByRole('button',{name:'Retry import',exact:true}).click();
  await expect(status).toContainText('Import complete. Added 1 notifications');
  await expect(key).toHaveValue('');
  expect(requests).toBe(2);
});

test('iPhone quick links open signed-in add and app setup without QR pairing', async ({ page }, info) => {
  const response = await page.request.post('/api/auth/apple', { data: appleCredential(`quick-links-${info.project.name}-${Date.now()}@example.test`) });
  expect(response.status()).toBe(200);
  const { token } = await response.json();
  await page.context().addCookies([{ name: 'iap_session', value: token, url: 'http://127.0.0.1:4318', httpOnly: true, sameSite: 'Strict' }]);
  await page.addInitScript(() => {
    (window as any).webkit = { messageHandlers: { questline: { postMessage: (message: string) => { (window as any).nativeMessage = message; } } } };
  });
  const pairingRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/pairing')) pairingRequests.push(request.url()); });
  await page.goto('/?client=ios#apps?add=1');
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#add-app-section')).toBeVisible();
  await expect(page.locator('#auth-view')).toBeHidden();
  await expect(page.locator('#logout-button')).toBeHidden();
  expect(await page.evaluate(() => document.cookie)).not.toContain(token);
  expect(page.url()).not.toContain(token);
  await expect(page.getByLabel('App name', { exact: true })).toBeHidden();
  await page.getByText('Can’t find your app?', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open App Store (opens externally)', exact: true })).toHaveAttribute('href', 'https://apps.apple.com/');
  await expect(page.getByRole('link', { name: 'Open App Store Connect (opens externally)', exact: true })).toHaveAttribute('href', 'https://appstoreconnect.apple.com/apps');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  // Clipboard and public Apple metadata are synthetic; app creation still uses the emulator API.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: async () => 'https://apps.apple.com/ca/app/id123456789',
  } }));
  await page.route('**/api/apps/lookup', async route => {
    expect(route.request().postDataJSON()).toEqual({ url: 'https://apps.apple.com/ca/app/id123456789' });
    await route.fulfill({ json: { name: 'Quick Links App', bundleId: `com.example.quicklinks.${info.project.name}`, appleId: '123456789', iconUrl: null } });
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `.impeccable/review/add-app-shortcuts-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Paste copied link', exact: true }).click();
  await expect(page.getByLabel('App name', { exact: true })).toHaveValue('Quick Links App');
  await expect(page.getByLabel('Bundle ID', { exact: true })).toHaveValue(`com.example.quicklinks.${info.project.name}`);
  await expect(page.getByLabel('Numeric Apple ID', { exact: true })).toHaveValue('123456789');
  await expect(page.locator('#app-identity-fields')).toBeHidden();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const added = page.waitForResponse(response => new URL(response.url()).pathname === '/api/apps' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add app & show connection steps', exact: true }).click();
  const { app } = await (await added).json();
  await page.goto(`/?client=ios#apps?app=${encodeURIComponent(app.id)}`);
  await expect(page.locator(`#setup-${app.id}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect Apple notifications', exact: true })).toBeVisible();
  await expect(page.locator('#add-app-section')).toBeHidden();
  await page.screenshot({ path: info.outputPath('signed-in-quick-link.png'), fullPage: true });
  expect(pairingRequests).toEqual([]);
  await page.goto('/?client=ios#apps?app=not-in-this-account');
  await expect(page.locator('#global-message')).toContainText('no longer available in your account');
});

test('expired iPhone dashboard session returns to app instead of starting QR sign-in', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).webkit = { messageHandlers: { questline: { postMessage: (message: string) => { (window as any).nativeMessage = message; } } } };
  });
  const pairingRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/pairing')) pairingRequests.push(request.url()); });
  await page.goto('/?client=ios#apps?add=1');
  await expect(page.getByRole('heading', { name: 'Return to Questline' })).toBeVisible();
  await expect(page.locator('#pairing-panel')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).nativeMessage)).toBe('authenticationRequired');
  expect(pairingRequests).toEqual([]);
});


test('browser setup link survives QR sign-in and clipboard denial offers direct paste', async ({ page }, info) => {
  await page.goto('/?client=ios#apps?add=1');
  await signInViaPhone(page, `browser-choice-${info.project.name}-${Date.now()}@example.test`);
  await expect(page.locator('#add-app-section')).toBeVisible();
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#app-details')).toBeHidden();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
  } }));
  await page.getByText('Can’t find your app?', { exact: true }).click();
  await page.getByRole('button', { name: 'Paste copied link', exact: true }).click();
  await expect(page.locator('#lookup-message')).toContainText('Paste your link into the search field');
  await expect(page.locator('#lookup-url')).toBeFocused();
  await page.locator('#app-find-help').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  await page.getByRole('button', { name: 'Enter details manually', exact: true }).click();
  await expect(page.getByLabel('App name', { exact: true })).toBeEditable();
  await expect(page.locator('#lookup-url')).toBeEmpty();
});

test('link lookup opens confirmation and editing retains changes through back navigation', async ({ page }, info) => {
  await register(page, info);
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  const requests: string[] = [];
  await page.route('**/api/apps/lookup', async route => {
    requests.push(route.request().postDataJSON().url);
    await route.fulfill({ json: { name: 'Automatic App', bundleId: 'com.example.automatic', appleId: '123456789', iconUrl: null } });
  });
  const input = page.locator('#lookup-url');
  await input.fill('https://apps.apple.com/ca/app/');
  await page.waitForTimeout(800);
  expect(requests).toEqual([]);
  await input.fill('https://apps.apple.com/ca/app/id123456789');
  await expect(page.locator('#app-details-title')).toBeFocused();
  await expect(page.locator('#app-identity')).toContainText('Automatic App');
  await expect(page.locator('#app-find-step')).toBeHidden();
  await expect(page.locator('#app-identity-fields')).toBeHidden();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill('My app name');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#app-step-connect')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#app-identity')).toContainText('My app name');
  await page.getByRole('button', { name: 'Back to app details', exact: true }).click();
  await expect(page.getByLabel('App name', { exact: true })).toHaveValue('My app name');
  await page.getByLabel('Bundle ID', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Bundle ID', { exact: true })).toBeFocused();
  await expect(page.locator('#app-step-confirm')).toHaveAttribute('aria-current', 'step');
  expect(requests).toHaveLength(1);
});

test('lookup ignores superseded responses and cancelling cannot advance the closed flow', async ({ page }, info) => {
  await register(page, info);
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  const pending: Array<() => Promise<void>> = [];
  await page.route('**/api/apps/lookup', async route => {
    const appleId = route.request().postDataJSON().url;
    pending.push(() => route.fulfill({ json: { name: `App ${appleId}`, bundleId: `com.example.app${appleId}`, appleId, iconUrl: null } }));
  });
  await page.locator('#lookup-url').fill('111111111');
  await expect.poll(() => pending.length).toBe(1);
  await page.locator('#lookup-url').fill('222222222');
  await expect.poll(() => pending.length).toBe(2);
  await pending[1]();
  await expect(page.locator('#app-identity')).toContainText('App 222222222');
  await pending[0]();
  await expect(page.locator('#app-apple-id')).toHaveValue('222222222');
  await page.getByRole('button', { name: 'Back to search', exact: true }).click();
  await page.locator('#lookup-url').fill('333333333');
  await expect.poll(() => pending.length).toBe(3);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await pending[2]();
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  await expect(page.locator('#app-find-step')).toBeVisible();
  await expect(page.locator('#app-details')).toBeHidden();
  await expect(page.locator('#lookup-button')).toBeEnabled();
});

test('lookup failure stays on search and offers retry or manual entry', async ({ page }, info) => {
  await register(page, info);
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  let requests = 0;
  await page.route('**/api/apps/lookup', async route => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 503, json: { error: 'Apple lookup is unavailable.' } });
    else await route.fulfill({ json: { name: 'Retry App', bundleId: 'com.example.retry', appleId: '123456789', iconUrl: null } });
  });
  await page.locator('#lookup-url').fill('123456789');
  await expect(page.locator('#lookup-message')).toContainText('enter details manually');
  await expect(page.locator('#app-find-help')).toHaveAttribute('open', '');
  await expect(page.locator('#app-details')).toBeHidden();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#app-identity')).toContainText('Retry App');
});

test('title search shows developer matches and fills only the selected app',async({page},info)=>{
  await register(page,info);
  await page.getByRole('button',{name:'Add app',exact:true}).click();
  const terms:string[]=[];
  await page.route('**/api/apps/search',async route=>{
    terms.push(route.request().postDataJSON().term);
    await route.fulfill({json:{apps:[
      {name:'Weather Watch',developer:'First Developer',bundleId:'com.first.weather',appleId:'111',iconUrl:null,appStoreUrl:'https://apps.apple.com/us/app/id111'},
      {name:'Weather Watch',developer:'Second Developer',bundleId:'com.second.weather',appleId:'222',iconUrl:null,appStoreUrl:'https://apps.apple.com/us/app/id222'},
    ]}});
  });
  const input=page.getByLabel('Find your app',{exact:true});
  await input.fill('W');
  await page.waitForTimeout(800);
  expect(terms).toEqual([]);
  await input.fill('Wea');
  await input.fill('Weather Watch');
  await expect(page.locator('#lookup-results li')).toHaveCount(2);
  expect(terms).toEqual(['Weather Watch']);
  await expect(page.locator('#app-details')).toBeHidden();
  await expect(input).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.locator('#add-app-section').screenshot({path:info.outputPath('title-search.png')});
  const selected=page.locator('#lookup-results button').filter({hasText:'Second Developer'});
  await selected.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#app-name')).toHaveValue('Weather Watch');
  await expect(page.locator('#app-bundle-id')).toHaveValue('com.second.weather');
  await expect(page.locator('#app-apple-id')).toHaveValue('222');
  await expect(page.locator('#app-details-title')).toBeFocused();
  await expect(page.locator('#lookup-results')).toBeHidden();
  await page.locator('#add-app-section').screenshot({path: info.outputPath('confirm-app.png')});
  await page.getByRole('button', {name:'Continue', exact:true}).click();
  await page.locator('#add-app-section').screenshot({path: info.outputPath('connect-app.png')});
  await page.emulateMedia({colorScheme:'dark'});
  await page.locator('#add-app-section').screenshot({path: info.outputPath('connect-app-dark.png')});
});

test('title search handles no matches, retry, and a late response after switching to an Apple ID',async({page},info)=>{
  await register(page,info);
  await page.getByRole('button',{name:'Add app',exact:true}).click();
  let requests=0;
  let finish:(()=>Promise<void>)|undefined;
  await page.route('**/api/apps/search',async route=>{
    requests++;
    if(requests===1) await route.fulfill({json:{apps:[]}});
    else if(requests===2) await route.fulfill({status:422,json:{error:'App Store search is unavailable.'}});
    else finish=()=>route.fulfill({json:{apps:[{name:'Late result',developer:'Old Developer',bundleId:'com.old.app',appleId:'111',appStoreUrl:'https://apps.apple.com/us/app/id111'}]}});
  });
  await page.route('**/api/apps/lookup',route=>route.fulfill({json:{name:'Exact App',bundleId:'com.exact.app',appleId:'333',iconUrl:null}}));
  await page.getByLabel('Find your app',{exact:true}).fill('Missing title');
  await expect(page.locator('#lookup-message')).toContainText('No matching apps');
  await expect(page.getByRole('button',{name:'Enter details manually',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.locator('#lookup-message')).toContainText('unavailable');
  await expect(page.locator('#app-details')).toBeHidden();
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect.poll(()=>requests).toBe(3);
  await page.getByLabel('Find your app',{exact:true}).fill('333');
  await expect(page.locator('#app-name')).toHaveValue('Exact App');
  await finish!();
  await expect(page.locator('#lookup-results')).toBeHidden();
  await expect(page.locator('#app-identity')).toContainText('Exact App');
});
