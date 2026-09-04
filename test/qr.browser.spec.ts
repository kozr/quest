import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {appleCredential} from './apple-auth-fixture.js';

interface Pairing { id:string; qrUrl:string; qrImageUrl:string; code:string; expiresAt:string }

async function phoneAccount(request:APIRequestContext) {
  const email=`phone-${randomUUID()}@example.test`;
  const result=await request.post('/api/auth/apple',{data:appleCredential(email)});
  expect(result.status()).toBe(200);
  const body=await result.json();
  return {email,token:body.token as string};
}
async function openQR(page:Page):Promise<Pairing> {
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/pairing/start' && response.status()===201);
  await page.goto('/');
  const {pairing}=await (await response).json();
  await expect(page.locator('#pairing-qr')).toBeVisible();
  await expect(page.locator('#pairing-code')).toHaveText(pairing.code);
  return pairing;
}
function approvalBody(pairing:Pairing) {
  return {id:pairing.id,token:new URL(pairing.qrUrl).searchParams.get('token')!};
}

test('signed-in phone approves QR and desktop enters that account without credentials',async({page,context,request},info)=>{
  const phone=await phoneAccount(request);
  const exceptions:string[]=[];
  page.on('pageerror',error=>exceptions.push(error.message));
  const pairing=await openQR(page);
  await expect(page.getByRole('heading',{name:'Sign in with your iPhone',exact:true})).toBeVisible();
  await expect(page.locator('input[type="email"], input[type="password"], #email-fallback')).toHaveCount(0);
  await expect(page.getByText('Open IAP Notifications on your iPhone and sign in with Apple.',{exact:true})).toBeVisible();
  await expect(page.locator('#pairing-qr')).toHaveAttribute('src',/^data:image\/png;base64,/);
  expect(await page.locator('#pairing-qr').evaluate((img:HTMLImageElement)=>img.complete && img.naturalWidth>0)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('qr-sign-in.png'),fullPage:true});
  const headers={Authorization:`Bearer ${phone.token}`};
  const inspected=await request.post('/api/pairing/inspect',{headers,data:approvalBody(pairing)});
  expect(inspected.status()).toBe(200);
  expect((await inspected.json()).pairing.code).toBe(pairing.code);
  await expect(page.locator('#workspace')).toBeHidden(); // Inspection is not approval.
  const approved=await request.post('/api/pairing/approve',{headers,data:approvalBody(pairing)});
  expect(approved.status()).toBe(200);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#session-email')).toHaveText(phone.email);
  await expect(page.locator('#auth-view')).toBeHidden();
  const me=await context.request.get('/api/auth/me');
  expect(me.status()).toBe(200);
  expect((await me.json()).user.email).toBe(phone.email);
  const cookies=await context.cookies();
  expect(cookies.find(cookie=>cookie.name==='iap_session')).toMatchObject({httpOnly:true,sameSite:'Strict'});
  expect(cookies.find(cookie=>cookie.name==='iap_pairing')).toBeUndefined();
  expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);
  await page.reload();
  await expect(page.locator('#session-email')).toHaveText(phone.email);
  await expect(page.locator('#workspace')).toBeVisible();
  expect(exceptions).toEqual([]);
});

test('denied QR stays signed out and an expired or replaced browser cookie can get a fresh QR',async({page,context,request})=>{
  const phone=await phoneAccount(request);
  const first=await openQR(page);
  const denied=await request.post('/api/pairing/deny',{headers:{Authorization:`Bearer ${phone.token}`},data:approvalBody(first)});
  expect(denied.status()).toBe(200);
  await expect(page.locator('#pairing-status')).toContainText('declined');
  await expect(page.locator('#pairing-qr')).toBeHidden();
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);

  // A naturally expired cookie or one replaced in another tab must not trap the
  // browser in a cancel-404 / regenerate-error loop.
  await context.clearCookies({name:'iap_pairing'});
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/pairing/start' && response.status()===201);
  await page.getByRole('button',{name:'Get new QR code',exact:true}).click();
  const second:Pairing=(await (await response).json()).pairing;
  expect(second.id).not.toBe(first.id);
  await expect(page.locator('#pairing-qr')).toBeVisible();
  await expect(page.locator('#pairing-status')).toContainText('Waiting for you');
  const approved=await request.post('/api/pairing/approve',{headers:{Authorization:`Bearer ${phone.token}`},data:approvalBody(second)});
  expect(approved.status()).toBe(200);
  await expect(page.locator('#session-email')).toHaveText(phone.email);
});

test('expired-code presentation stops checking and offers an explicit restart',async({page})=>{
  let statusRequests=0;
  // Deliberately synthetic status response to exercise the UI without a two-
  // minute sleep. The API suite separately verifies real server TTL enforcement.
  await page.route('**/api/pairing/status?*',route=>{
    statusRequests++;
    return route.fulfill({json:{status:'expired',expiresAt:new Date(Date.now()-1000).toISOString()}});
  });
  await openQR(page);
  await expect(page.locator('#pairing-status')).toContainText('expired');
  await expect(page.locator('#pairing-qr')).toBeHidden();
  await expect(page.getByRole('button',{name:'Get new QR code',exact:true})).toBeEnabled();
  await expect(page.locator('#workspace')).toBeHidden();
  await page.waitForTimeout(2200);
  expect(statusRequests).toBe(1);
});
