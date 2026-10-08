import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const lifetime = 7 * 24 * 60 * 60;
const challengeLifetime = 10 * 60;
const digest = value => createHash('sha256').update(value).digest();
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(digest(left), digest(right));
const entries = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(x => x.trim()).filter(Boolean);
const failure = (message, status = 401) => Object.assign(new Error(message), {status});

// This is one private shared workspace, so Google identity must also be allowed.
export function createAuth({clientId, allowedEmails, allowedSubjects, secret, secure = true, verifyIdToken, now = Date.now}) {
  const emails = new Set(entries(allowedEmails).map(x => x.toLowerCase()));
  const subjects = new Set(entries(allowedSubjects));
  if (!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId || '') || (!emails.size && !subjects.size) || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Hosted login requires TRACKER_GOOGLE_CLIENT_ID, TRACKER_GOOGLE_ALLOWED_EMAILS or TRACKER_GOOGLE_ALLOWED_SUBJECTS, and TRACKER_SESSION_SECRET (32+ characters).');
  }
  const client = new OAuth2Client();
  const verify = verifyIdToken || (async credential => (await client.verifyIdToken({idToken: credential, audience: clientId})).getPayload());
  const sessionName = secure ? '__Host-tracker_session' : 'tracker_session';
  const challengeName = secure ? '__Host-tracker_login' : 'tracker_login';
  const sign = (kind, body) => createHmac('sha256', secret).update(`google-v1:${clientId}:${kind}:${body}`).digest('base64url');
  const encode = (kind, value) => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${sign(kind, body)}`;
  };
  const read = (req, name, kind, maxAge) => {
    const cookies = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
    if (cookies.length !== 1) return null;
    const encoded = cookies[0].slice(name.length + 1);
    if (encoded.length > 4096) return null;
    const [body, signature, ...extra] = encoded.split('.');
    if (extra.length || !body || !signature || !equal(sign(kind, body), signature)) return null;
    try {
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return /^[\w-]{32}$/.test(value.nonce || '') && Number.isFinite(value.expiresAt) && value.expiresAt > now() && value.expiresAt <= now() + maxAge * 1000 ? value : null;
    } catch { return null; }
  };
  const allowed = identity => subjects.has(identity.sub) || emails.has(identity.email);
  const session = req => {
    const value = read(req, sessionName, 'session', lifetime);
    return value && typeof value.sub === 'string' && typeof value.email === 'string' && allowed(value) ? value : null;
  };
  const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? seconds : 0}${secure ? '; Secure' : ''}`;
  return {
    authenticated: req => Boolean(session(req)),
    csrf: req => { const value = session(req); return value ? sign('csrf', value.nonce) : null; },
    challenge: (req, res) => {
      const value = read(req, challengeName, 'challenge', challengeLifetime) || {nonce: randomBytes(24).toString('base64url'), expiresAt: now() + challengeLifetime * 1000};
      res.append('Set-Cookie', cookie(challengeName, encode('challenge', value), Math.ceil((value.expiresAt - now()) / 1000)));
      return {clientId, nonce: value.nonce};
    },
    login: async (req, res) => {
      const challenge = read(req, challengeName, 'challenge', challengeLifetime);
      if (!challenge || !equal(challenge.nonce, req.get('X-Tracker-Login'))) throw failure('Your sign-in session expired. Try Google sign-in again.', 403);
      const credential = req.body?.credential;
      if (typeof credential !== 'string' || !credential || credential.length > 16384) throw failure('Sign in with Google to open your tracker.');
      let claims;
      try { claims = await verify(credential); } catch { throw failure('Google sign-in could not be verified. Try again.'); }
      if (!claims || claims.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now() || !equal(claims.nonce, challenge.nonce) || typeof claims.sub !== 'string' || !/^\d{1,255}$/.test(claims.sub) || claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 320) {
        throw failure('Google sign-in could not be verified. Try again.');
      }
      const identity = {sub: claims.sub, email: claims.email.toLowerCase()};
      // Third-party email ownership can change: require a pinned subject for it.
      const authoritativeEmail = identity.email.endsWith('@gmail.com') || typeof claims.hd === 'string' && claims.hd.length > 0;
      if (!subjects.has(identity.sub) && !(authoritativeEmail && emails.has(identity.email))) throw failure('This Google account does not have access to this tracker. Choose an invited account.', 403);
      const value = {...identity, nonce: randomBytes(24).toString('base64url'), expiresAt: now() + lifetime * 1000};
      res.append('Set-Cookie', cookie(sessionName, encode('session', value), lifetime));
      res.append('Set-Cookie', cookie(challengeName, '', 0));
      if (secure) res.append('Set-Cookie', cookie('tracker_session', '', 0));
    },
    logout: res => {
      res.append('Set-Cookie', cookie(sessionName, '', 0));
      res.append('Set-Cookie', cookie(challengeName, '', 0));
    },
  };
}
