import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createApplication, type ApplicationOptions } from '../src/app.js';
import { createSession, tokenHash } from '../src/auth.js';
import {firebaseOptions,testStore,resetAccounts,rows} from './firebase-fixture.js';

const configuration: ApplicationOptions = {
  port: 4317, host: '127.0.0.1', publicUrl: 'http://localhost:4317', ...firebaseOptions,
  production: false, registrationEnabled: true, demoEnabled: true,
  appleRootDirectory: '/not-needed-for-pairing', apns: null,
};
type RequestOptions = { method?: string; token?: string; cookie?: string; body?: unknown; origin?: string };
type ApiResponse = { status: number; headers: Headers; body: any };
type Challenge = { id: string; token: string; cookie: string; code: string; expiresAt: string; response: ApiResponse };

function setCookie(response: ApiResponse, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}
function cookiePair(response: ApiResponse, name: string): string {
  const cookie = setCookie(response, name);
  assert.ok(cookie, `Expected a ${name} cookie on HTTP ${response.status}.`);
  return cookie.split(';')[0]!;
}
function rejected(response: ApiResponse, explanation: string): void {
  assert.ok(response.status >= 400 && response.status < 500, `${explanation}: got HTTP ${response.status} ${JSON.stringify(response.body)}`);
  assert.equal(setCookie(response, 'iap_session'), undefined, `${explanation}: rejection must not issue an authenticated cookie.`);
  assert.equal(response.body.user, undefined, `${explanation}: rejection must not disclose an account.`);
  assert.equal(response.body.token, undefined, `${explanation}: rejection must not issue a bearer token.`);
}
function changed(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
}

async function fixture(t: TestContext, overrides: Partial<ApplicationOptions> = {}) {
  const options = { ...configuration, ...overrides };
  const store=testStore();await resetAccounts(store,['phone-owner@example.test','another-owner@example.test','manual-registration@example.test']);
  const instance = createApplication({...options,store});
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await instance.worker.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    instance.store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, init: RequestOptions = {}): Promise<ApiResponse> => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...(init.origin !== undefined ? { Origin: init.origin } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  // Use the real session generator and authentication middleware; password
  // creation is unrelated to these pairing security tests.
  const account = async (email: string) => {
    const result=await request('/api/auth/register',{method:'POST',body:{email,password:'Pairing-account-password!',client:'ios'}});
    assert.equal(result.status,201,JSON.stringify(result.body));
    return {user:result.body.user,token:result.body.token};
  };
  const mobile = await account('phone-owner@example.test');
  const other = await account('another-owner@example.test');
  const sessions = async () => (await rows(store,'sessions')).length;
  const start = async (cookie?: string): Promise<Challenge> => {
    const response = await request('/api/pairing/start', { method: 'POST', body: {}, origin: options.publicUrl, cookie });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const pairing = response.body.pairing;
    const url = new URL(pairing.qrUrl);
    const token = url.searchParams.get('token');
    assert.ok(token);
    return { id: pairing.id, token, cookie: cookiePair(response, 'iap_pairing'), code: pairing.code, expiresAt: pairing.expiresAt, response };
  };
  const status = (challenge: Challenge, cookie = challenge.cookie) => request(`/api/pairing/status?id=${challenge.id}`, { cookie });
  const inspect = (challenge: Challenge, token = mobile.token) => request('/api/pairing/inspect', { method: 'POST', token, body: { id: challenge.id, token: challenge.token } });
  const approve = (challenge: Challenge, token = mobile.token) => request('/api/pairing/approve', { method: 'POST', token, body: { id: challenge.id, token: challenge.token } });
  const redeem = (challenge: Challenge, cookie = challenge.cookie) => request('/api/pairing/redeem', { method: 'POST', body: { id: challenge.id }, cookie, origin: options.publicUrl });
  return { ...instance, options, request, mobile, other, sessions, start, status, inspect, approve, redeem };
}

test('pairing start creates a two-minute PNG QR challenge, independent secrets, and only hashed secret storage', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  const pairing = challenge.response.body.pairing;
  assert.match(challenge.id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(challenge.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge.code, /^\d{6}$/);
  assert.equal(pairing.pollIntervalMs, 2000);
  assert.equal(pairing.publicUrl, f.options.publicUrl);
  const url = new URL(pairing.qrUrl);
  assert.equal(url.protocol, 'iapnotifications:');
  assert.equal(url.hostname, 'pair');
  assert.equal(url.searchParams.get('v'), '1');
  assert.equal(url.searchParams.get('server'), f.options.publicUrl);
  assert.equal(url.searchParams.get('id'), challenge.id);
  assert.equal(url.searchParams.get('token'), challenge.token);
  assert.match(pairing.qrImageUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(pairing.qrImageUrl.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const cookie = setCookie(challenge.response, 'iap_pairing')!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(cookie, new RegExp(challenge.token));
  assert.equal(setCookie(challenge.response, 'iap_session'), undefined);
  assert.equal(await f.sessions(), 2, 'A QR challenge alone cannot create a login session.');
  const row = (await f.store.get<any>('browser_pairings',challenge.id))!;
  assert.equal(row.state, 'pending');
  assert.equal(row.approved_user_id, null);
  assert.equal(row.approver_session_hash, null);
  assert.equal(row.approval_token_hash, tokenHash(challenge.token));
  assert.match(String(row.browser_secret_hash), /^[a-f0-9]{64}$/);
  const browserSecret = challenge.cookie.slice('iap_pairing='.length);
  assert.notEqual(row.browser_secret_hash, row.approval_token_hash);
  assert.ok(!JSON.stringify(row).includes(challenge.token));
  assert.ok(!JSON.stringify(row).includes(browserSecret));
  assert.equal(Number(row.expires_at) - Date.parse(String(row.created_at)), 120_000);
  assert.equal(Date.parse(challenge.expiresAt), Number(row.expires_at));
  assert.match(challenge.response.headers.get('cache-control') ?? '', /no-store/i);
});

test('HTTPS pairing and redeemed session cookies are secure, HttpOnly, and SameSite Strict', async (t) => {
  const f = await fixture(t, { production: true, publicUrl: 'https://notifications.example.test' });
  const challenge = await f.start();
  assert.match(setCookie(challenge.response, 'iap_pairing')!, /; Secure/i);
  assert.equal((await f.approve(challenge)).status, 200);
  const redeemed = await f.redeem(challenge);
  assert.equal(redeemed.status, 200);
  const cookie = setCookie(redeemed, 'iap_session')!;
  assert.match(cookie, /; Secure/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('matching native approval plus the original browser secret creates exactly one account-bound browser session', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  assert.equal((await f.status(challenge)).body.status, 'pending');
  const inspected = await f.inspect(challenge);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.pairing.id, challenge.id);
  assert.equal(inspected.body.pairing.code, challenge.code);
  assert.equal(inspected.body.pairing.expiresAt, challenge.expiresAt);
  assert.equal(inspected.body.pairing.publicUrl, f.options.publicUrl);
  assert.ok(typeof inspected.body.pairing.browserName === 'string' && inspected.body.pairing.browserName.length > 0);
  rejected(await f.redeem(challenge), 'Redeeming before mobile approval');
  assert.equal(await f.sessions(), 2);
  assert.equal((await f.approve(challenge)).status, 200);
  assert.equal(await f.sessions(), 2, 'Approval alone must not create a bearer or browser session.');
  assert.equal((await f.status(challenge)).body.status, 'approved');
  const redeemed = await f.redeem(challenge);
  assert.equal(redeemed.status, 200);
  assert.deepEqual(redeemed.body.user, f.mobile.user);
  assert.equal(redeemed.body.token, undefined);
  const cookie = cookiePair(redeemed, 'iap_session');
  assert.notEqual(cookie.slice('iap_session='.length), challenge.token);
  assert.equal(await f.sessions(), 3);
  assert.deepEqual((await f.request('/api/auth/me', { cookie })).body.user, f.mobile.user);
  assert.equal((await f.store.get<any>('browser_pairings',challenge.id))!.state, 'consumed');
  rejected(await f.redeem(challenge), 'Replaying a consumed QR');
  rejected(await f.approve(challenge), 'Approving a consumed QR');
  assert.equal(await f.sessions(), 3);
});

test('unauthenticated pairing status reveals no account identity or secret even after approval', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  for (const expected of ['pending', 'approved']) {
    if (expected === 'approved') assert.equal((await f.approve(challenge)).status, 200);
    const result = await f.status(challenge);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, expected);
    assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'status']);
    const serialized = JSON.stringify(result.body);
    for (const secret of [f.mobile.user.id, f.mobile.user.email, challenge.token, f.mobile.token]) assert.ok(!serialized.includes(secret));
    assert.match(result.headers.get('cache-control') ?? '', /no-store/i);
  }
});

test('approval token, six-digit code, and ID do not substitute for the initiating browser cookie', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  assert.equal((await f.approve(challenge)).status, 200);
  rejected(await f.request(`/api/pairing/status?id=${challenge.id}`), 'Status without browser secret');
  for (const cookie of [undefined, `iap_pairing=${challenge.token}`, `iap_pairing=${challenge.code}`, `iap_pairing=${challenge.id}`]) {
    rejected(await f.request('/api/pairing/redeem', { method: 'POST', token: challenge.token, cookie, origin: f.options.publicUrl, body: { id: challenge.id } }), 'QR token without original browser secret');
  }
  assert.equal(await f.sessions(), 2);
  assert.equal((await f.redeem(challenge)).status, 200, 'Failed attacks must not consume the rightful browser challenge.');
});

test('pairing cookies and approval tokens cannot be exchanged across two browser challenges', async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start();
  assert.notEqual(first.cookie, second.cookie);
  assert.notEqual(first.token, second.token);
  rejected(await f.status(first, second.cookie), 'Cross-browser status');
  rejected(await f.request('/api/pairing/approve', { method: 'POST', token: f.mobile.token, body: { id: second.id, token: first.token } }), 'Approval token for a different challenge');
  assert.equal((await f.approve(first)).status, 200);
  rejected(await f.redeem(first, second.cookie), 'Cross-browser redemption');
  rejected(await f.request('/api/pairing/cancel', { method: 'POST', origin: f.options.publicUrl, cookie: second.cookie, body: { id: first.id } }), 'Cross-browser cancellation');
  assert.equal((await f.status(first)).body.status, 'approved');
  assert.equal((await f.redeem(first)).status, 200);
  assert.equal((await f.status(second)).body.status, 'pending');
});

test('native inspect, approve, and deny require a real bearer session, not the browser cookie', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  for (const action of ['inspect', 'approve', 'deny']) {
    const path = `/api/pairing/${action}`;
    const body = { id: challenge.id, token: challenge.token };
    rejected(await f.request(path, { method: 'POST', body }), `${action} without authentication`);
    rejected(await f.request(path, { method: 'POST', token: challenge.token, body }), `${action} using the QR token as a session`);
    rejected(await f.request(path, { method: 'POST', cookie: `iap_session=${f.mobile.token}`, origin: f.options.publicUrl, body }), `${action} using only browser-cookie authentication`);
  }
  assert.equal((await f.status(challenge)).body.status, 'pending');
});

test('wrong approval token and six-digit display code cannot inspect, approve, or deny a challenge', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  for (const action of ['inspect', 'approve', 'deny']) {
    for (const token of [changed(challenge.token), challenge.code]) {
      rejected(await f.request(`/api/pairing/${action}`, { method: 'POST', token: f.mobile.token, body: { id: challenge.id, token } }), `${action} with an invalid approval token`);
    }
  }
  assert.equal((await f.status(challenge)).body.status, 'pending');
  assert.equal((await f.inspect(challenge)).status, 200);
});

test('browser start, redeem, and cancel reject missing, opaque, and foreign origins', async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'https://attacker.example']) {
    const response = await f.request('/api/pairing/start', { method: 'POST', body: {}, origin });
    assert.equal(response.status, 403);
    assert.equal(setCookie(response, 'iap_pairing'), undefined);
  }
  const challenge = await f.start();
  assert.equal((await f.approve(challenge)).status, 200);
  for (const action of ['redeem', 'cancel']) {
    for (const origin of [undefined, 'null', 'https://attacker.example']) {
      const response = await f.request(`/api/pairing/${action}`, { method: 'POST', body: { id: challenge.id }, cookie: challenge.cookie, origin });
      assert.equal(response.status, 403);
      rejected(response, `${action} from a nonmatching origin`);
    }
  }
  assert.equal((await f.status(challenge)).body.status, 'approved');
  assert.equal((await f.redeem(challenge)).status, 200);
});

test('explicit denial is terminal and cannot be changed into an approval or browser session', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  const denied = await f.request('/api/pairing/deny', { method: 'POST', token: f.mobile.token, body: { id: challenge.id, token: challenge.token } });
  assert.equal(denied.status, 200);
  assert.equal((await f.status(challenge)).body.status, 'denied');
  rejected(await f.approve(challenge), 'Approval after denial');
  rejected(await f.redeem(challenge), 'Redemption after denial');
  assert.equal(await f.sessions(), 2);
});

test('the initiating browser can cancel pending or approved pairing without creating a session', async (t) => {
  const f = await fixture(t);
  for (const approveFirst of [false, true]) {
    const challenge = await f.start();
    if (approveFirst) assert.equal((await f.approve(challenge)).status, 200);
    const cancelled = await f.request('/api/pairing/cancel', { method: 'POST', origin: f.options.publicUrl, cookie: challenge.cookie, body: { id: challenge.id } });
    assert.equal(cancelled.status, 200);
    assert.equal((await f.status(challenge)).body.status, 'cancelled');
    rejected(await f.approve(challenge), 'Approval after cancellation');
    rejected(await f.redeem(challenge), 'Redemption after cancellation');
  }
  assert.equal(await f.sessions(), 2);
});

test('expiry blocks inspection, approval, and redemption, including an approval made before expiry', async (t) => {
  const f = await fixture(t);
  for (const approveFirst of [false, true]) {
    const challenge = await f.start();
    if (approveFirst) assert.equal((await f.approve(challenge)).status, 200);
    await f.store.set('browser_pairings',challenge.id,{expires_at:Date.now()-1},true);
    assert.equal((await f.status(challenge)).body.status, 'expired');
    rejected(await f.inspect(challenge), 'Inspection after expiry');
    rejected(await f.approve(challenge), 'Approval after expiry');
    rejected(await f.redeem(challenge), 'Redemption after expiry');
  }
  assert.equal(await f.sessions(), 2);
});

test('logging out the approving phone before redemption invalidates its approval', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  assert.equal((await f.approve(challenge)).status, 200);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', token: f.mobile.token })).status, 200);
  assert.equal((await f.request('/api/auth/me', { token: f.mobile.token })).status, 401);
  rejected(await f.redeem(challenge), 'Redeeming after approver logout');
  assert.equal(await f.sessions(), 1);
});

test('expiry of the approving phone session also invalidates an otherwise unexpired challenge', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  assert.equal((await f.approve(challenge)).status, 200);
  await f.store.set('sessions',tokenHash(f.mobile.token),{expires_at:new Date(Date.now()-1).toISOString()},true);
  rejected(await f.redeem(challenge), 'Redeeming after approver session expiry');
  assert.equal(await f.sessions(), 2);
});

test('concurrent different-account approvals select exactly one immutable approver', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  const results = await Promise.all([f.approve(challenge, f.mobile.token), f.approve(challenge, f.other.token)]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  const rejectedApproval = results.find((result) => result.status !== 200)!;
  rejected(rejectedApproval, 'Losing concurrent approval');
  const winner = results[0]!.status === 200 ? f.mobile : f.other;
  const row = (await f.store.get<any>('browser_pairings',challenge.id))!;
  assert.equal(row.approved_user_id, winner.user.id);
  assert.equal(row.approver_session_hash, tokenHash(winner.token));
  const redeemed = await f.redeem(challenge);
  assert.equal(redeemed.status, 200);
  assert.deepEqual(redeemed.body.user, winner.user);
});

test('concurrent browser redemptions consume the challenge once and create only one session', async (t) => {
  const f = await fixture(t);
  const challenge = await f.start();
  assert.equal((await f.approve(challenge)).status, 200);
  const results = await Promise.all([f.redeem(challenge), f.redeem(challenge)]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  rejected(results.find((result) => result.status !== 200)!, 'Losing concurrent redemption');
  assert.equal(await f.sessions(), 3);
  assert.equal((await f.store.get<any>('browser_pairings',challenge.id))!.state, 'consumed');
});

test('an already signed-in browser cannot start pairing or silently switch accounts on redemption', async (t) => {
  const f = await fixture(t);
  const existingCookie = `iap_session=${f.other.token}`;
  const start = await f.request('/api/pairing/start', { method: 'POST', body: {}, cookie: existingCookie, origin: f.options.publicUrl });
  assert.equal(start.status, 409);
  assert.equal(setCookie(start, 'iap_pairing'), undefined);
  const challenge = await f.start();
  assert.equal((await f.approve(challenge)).status, 200);
  const response = await f.redeem(challenge, `${challenge.cookie}; ${existingCookie}`);
  assert.equal(response.status, 409);
  rejected(response, 'Redemption into an already authenticated browser');
  assert.deepEqual((await f.request('/api/auth/me', { cookie: existingCookie })).body.user, f.other.user);
  assert.equal(await f.sessions(), 2);
});

test('a stale browser session cookie does not prevent legitimate fresh QR login', async (t) => {
  const f = await fixture(t);
  const expiredBrowser = await createSession(f.store, f.other.user.id,Math.floor(Date.now()/1000));
  await f.store.set('sessions',tokenHash(expiredBrowser),{expires_at:new Date(Date.now()-1).toISOString()},true);
  const challenge = await f.start(`iap_session=${expiredBrowser}`);
  assert.equal((await f.approve(challenge)).status, 200);
  const result = await f.redeem(challenge, `${challenge.cookie}; iap_session=${expiredBrowser}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.user, f.mobile.user);
});

test('regenerating a browser QR cancels its previous pending or approved challenge', async (t) => {
  const f = await fixture(t);
  for (const approveFirst of [false, true]) {
    const original = await f.start();
    if (approveFirst) assert.equal((await f.approve(original)).status, 200);
    const replacement = await f.start(original.cookie);
    assert.notEqual(replacement.cookie, original.cookie);
    assert.notEqual(replacement.id, original.id);
    assert.equal((await f.status(original)).body.status, 'cancelled');
    rejected(await f.approve(original), 'Approving a superseded QR');
    rejected(await f.redeem(original), 'Redeeming a superseded QR');
    assert.equal((await f.status(replacement)).body.status, 'pending');
    assert.equal((await f.inspect(replacement)).status, 200);
  }
  assert.equal(await f.sessions(), 2);
});

test('manual browser login or registration invalidates an outstanding approved QR before issuing that account session', async (t) => {
  const f = await fixture(t);
  const password = 'Pairing-manual-login-password!';
  await f.store.identity.auth.updateUser(f.other.user.id,{password});
  for (const action of ['login', 'register']) {
    const challenge = await f.start();
    assert.equal((await f.approve(challenge)).status, 200);
    const email = action === 'login' ? f.other.user.email : 'manual-registration@example.test';
    const manual = await f.request(`/api/auth/${action}`, {
      method: 'POST', body: { email, password }, cookie: challenge.cookie, origin: f.options.publicUrl,
    });
    assert.equal(manual.status, action === 'login' ? 200 : 201, JSON.stringify(manual.body));
    assert.equal(manual.body.user.email, email);
    assert.equal(manual.body.token, undefined);
    assert.match(setCookie(manual, 'iap_pairing')!, /^iap_pairing=;/);
    const session = cookiePair(manual, 'iap_session');
    assert.equal((await f.request('/api/auth/me', { cookie: session })).body.user.email, email);
    assert.equal((await f.status(challenge)).body.status, 'cancelled');
    rejected(await f.redeem(challenge), 'Redeeming a QR after manual authentication');
    rejected(await f.approve(challenge), 'Approving a QR after manual authentication');
  }
});

test('browser logout explicitly cancels an outstanding QR even while its approving phone remains signed in', async (t) => {
  const f = await fixture(t);
  for (const approveFirst of [false, true]) {
    const challenge = await f.start();
    if (approveFirst) assert.equal((await f.approve(challenge)).status, 200);
    const browserToken = await createSession(f.store, f.other.user.id,Math.floor(Date.now()/1000));
    const logout = await f.request('/api/auth/logout', {
      method: 'POST', cookie: `${challenge.cookie}; iap_session=${browserToken}`, origin: f.options.publicUrl,
    });
    assert.equal(logout.status, 200);
    assert.equal((await f.request('/api/auth/me', { token: browserToken })).status, 401);
    assert.equal((await f.request('/api/auth/me', { token: f.mobile.token })).status, 200);
    assert.equal((await f.status(challenge)).body.status, 'cancelled');
    rejected(await f.redeem(challenge), 'Redeeming a QR after browser logout');
    rejected(await f.approve(challenge), 'Approving a QR after browser logout');
  }
});

test('expiry is enforced before asynchronous Firestore TTL cleanup, without revoking a redeemed session', async (t) => {
  const f = await fixture(t);
  const pending = await f.start();
  const approved = await f.start();
  assert.equal((await f.approve(approved)).status, 200);
  const consumed = await f.start();
  assert.equal((await f.approve(consumed)).status, 200);
  const redeemed = await f.redeem(consumed);
  assert.equal(redeemed.status, 200);
  const browserSession = cookiePair(redeemed, 'iap_session');
  for(const old of [pending,approved,consumed]) await f.store.set('browser_pairings',old.id,{expires_at:Date.now()-1},true);
  const fresh = await f.start();
  assert.equal((await f.status(fresh)).body.status,'pending');
  for (const old of [pending, approved, consumed]) {
    assert.equal((await f.status(old)).body.status,'expired');
    rejected(await f.redeem(old), 'Redemption for an expired and removed QR');
  }
  assert.deepEqual((await f.request('/api/auth/me', { cookie: browserSession })).body.user, f.mobile.user);
});
