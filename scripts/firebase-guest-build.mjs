// Applied only to the generated Netlify server, not to local server.mjs.
const GUEST_LIMIT_PER_MINUTE = 6;

export function addFirebaseGuestAuth(source) {
  const guard = 'if (!authorized(req)) {';
  const originCheck = 'req.headers.origin !== origin';
  const limitCheck = 'if (recentCalls.length >= 12 || activeCalls >= 3) {';
  if (source.split(guard).length !== 2 || !source.includes(originCheck) ||
      source.split(limitCheck).length !== 2) {
    throw new Error('Unexpected authorization structure; guest build stopped.');
  }
  const runtime = `
import { initializeApp as nialInitializeApp } from 'firebase-admin/app';
import { getAuth as nialGetAuth } from 'firebase-admin/auth';
const nialGuestAuth = nialGetAuth(nialInitializeApp({ projectId: 'nial-ai' }, 'nial-guest-auth'));
// Per-guest limit kept in process memory: it is not shared between serverless instances.
const nialGuestCalls = new Map();
function nialGuestLimited(uid) {
  const now = Date.now();
  const recent = (nialGuestCalls.get(uid) || []).filter(t => t > now - 60000);
  if (recent.length >= ${GUEST_LIMIT_PER_MINUTE}) {
    nialGuestCalls.set(uid, recent);
    return true;
  }
  recent.push(now);
  nialGuestCalls.set(uid, recent);
  if (nialGuestCalls.size > 1000) {
    for (const [key, times] of nialGuestCalls) {
      if (!times.length || times[times.length - 1] <= now - 60000) nialGuestCalls.delete(key);
    }
  }
  return false;
}
async function nialAuthorizeRequest(req) {
  // Preserve the existing browser authentication without changing its scope.
  if (authorized(req)) return true;
  // Guest tokens authorize chat only, never the page or image endpoints.
  if (req.method !== 'POST' || req.url !== '/chat') return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.length > 16384) return false;
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header);
  if (!match) return false;
  try {
    const decoded = await nialGuestAuth.verifyIdToken(match[1]);
    if (decoded.firebase?.sign_in_provider !== 'anonymous') return false;
    if (typeof decoded.uid !== 'string' || !decoded.uid) return false;
    req.nialFirebaseUid = decoded.uid;
    req.nialGuestLimited = nialGuestLimited(decoded.uid);
    return true;
  } catch {
    // Never log the token or accept an unverified fallback.
    return false;
  }
}
`;
  return runtime + '\n' + source
    .replace(guard, 'if (!(await nialAuthorizeRequest(req))) {')
    .replace(limitCheck, 'if (req.nialGuestLimited || recentCalls.length >= 12 || activeCalls >= 3) {')
    .replaceAll(originCheck, '(!req.nialFirebaseUid && req.headers.origin !== origin)');
}
