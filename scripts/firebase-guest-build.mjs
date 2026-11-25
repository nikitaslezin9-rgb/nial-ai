// Applied only to the generated Netlify server, not to local server.mjs.
export function addFirebaseGuestAuth(source) {
  const guard = 'if (!authorized(req)) {';
  const originCheck = 'req.headers.origin !== origin';
  if (source.split(guard).length !== 2 || !source.includes(originCheck)) {
    throw new Error('Unexpected authorization structure; guest build stopped.');
  }
  const runtime = `
import { initializeApp as nialInitializeApp } from 'firebase-admin/app';
import { getAuth as nialGetAuth } from 'firebase-admin/auth';
const nialGuestAuth = nialGetAuth(nialInitializeApp({ projectId: 'nial-ai' }, 'nial-guest-auth'));
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
    return true;
  } catch {
    // Never log the token or accept an unverified fallback.
    return false;
  }
}
`;
  return runtime + '\n' + source
    .replace(guard, 'if (!(await nialAuthorizeRequest(req))) {')
    .replaceAll(originCheck, '(!req.nialFirebaseUid && req.headers.origin !== origin)');
}
