import { randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash,createHmac } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const HASH_OPTIONS = { N: 32768,r: 8,p: 3,maxmem: 64*1024*1024 };
const DUMMY_HASH = `scrypt$32768$8$3$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;
export const SESSION_MS = 8*60*60000;
const hash = value => createHash('sha256').update(value).digest('hex');
const denied = () => Object.assign(new Error('Invalid username or password'),{ status: 401 });
export function normalizeUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) throw new Error('Username must be 3–64 letters, numbers, dots, underscores or hyphens');
  return username;
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || Buffer.byteLength(password)>512) throw new Error('Use a password of 12–128 characters');
  const salt = randomBytes(16); const derived = await scrypt(password,salt,32,HASH_OPTIONS);
  return `scrypt$32768$8$3$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
export async function verifyPassword(password,encoded) {
  if (typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password)>512) return false;
  const parts = String(encoded).split('$');
  if (parts.length !== 6 || parts.slice(0,4).join('$') !== 'scrypt$32768$8$3') return false;
  const salt = Buffer.from(parts[4],'base64url'); const expected = Buffer.from(parts[5],'base64url');
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = await scrypt(password,salt,32,HASH_OPTIONS); return timingSafeEqual(actual,expected);
}

export function createAuth(store,{ now = Date.now,publicOrigin,secureCookies = false } = {}) {
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid INCIDENTLAB_PUBLIC_ORIGIN');
    if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for non-loopback public origins');
    publicOrigin = url.origin; secureCookies ||= url.protocol === 'https:';
  }
  const cookieName = secureCookies ? '__Host-incidentlab_session' : 'incidentlab_session';
  const cookie = (token,clear = false) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS/1000}${secureCookies ? '; Secure' : ''}`;
  const csrf = token => createHmac('sha256',token).update('incidentlab-csrf-v1').digest('base64url');
  function tokenFrom(req) {
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(cookieName.length+1); return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  let hashing = 0;
  return {
    requestOrigin(req) { return publicOrigin || `${secureCookies ? 'https' : 'http'}://${req.headers.host}`; },
    async session(req) {
      const token = tokenFrom(req); if (!token) return null;
      const user = await store.sessionUser(hash(token),now());
      return user ? { user,tokenHash: hash(token),csrfToken: csrf(token) } : null;
    },
    async liveSession(tokenHash) { return store.sessionUser(tokenHash,now(),false); },
    checkCSRF(req,session) {
      const supplied = req.headers['x-csrf-token'];
      if (typeof supplied !== 'string') return false;
      const actual = Buffer.from(supplied); const expected = Buffer.from(session.csrfToken);
      return actual.length === expected.length && timingSafeEqual(actual,expected);
    },
    async login(input,ip) {
      if (hashing >= 2) throw Object.assign(new Error('Sign-in is busy. Try again shortly.'),{ status: 429,retryAfter: 2 });
      hashing++;
      try {
        const raw = typeof input?.username === 'string' ? input.username.trim().toLowerCase().slice(0,128) : '';
        const limits = [{ key: `ip:${hash(ip)}`,max: 10 },{ key: `account:${hash(raw)}`,max: 5 },{ key: 'global',max: 100 }];
        await store.recordLoginAttempt(limits,now());
        let username; try { username = normalizeUsername(raw); } catch { username = ''; }
        const user = username ? await store.ownerByName(username) : null;
        const valid = await verifyPassword(input?.password,user?.password_hash || DUMMY_HASH);
        if (!user || !valid) throw denied();
        const token = randomBytes(32).toString('base64url');
        await store.createSession(user.id,hash(token),now(),now()+SESSION_MS,user.password_hash);
        await store.clearLoginLimits(limits.map(limit => limit.key));
        return { cookie: cookie(token),user: { id: user.id,username: user.username,role: user.role },csrfToken: csrf(token) };
      } finally { hashing--; }
    },
    async logout(session) { if (session) await store.deleteSession(session.tokenHash); return cookie('',true); }
  };
}
