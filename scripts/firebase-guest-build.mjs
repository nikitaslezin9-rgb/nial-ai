// Applied only to the generated Netlify server, not to local server.mjs.
const GUEST_LIMIT_PER_MINUTE = 6;
const DAILY_TOTAL_LIMIT = 500;
const DAILY_GUEST_LIMIT = 40;
const DAILY_IMAGE_TOTAL_LIMIT = 100;
const DAILY_IMAGE_GUEST_LIMIT = 5;

export function addFirebaseGuestAuth(source) {
  const guard = 'if (!authorized(req)) {';
  const originCheck = 'req.headers.origin !== origin';
  const limitCheck = 'if (recentCalls.length >= 12 || activeCalls >= 3) {';
  const imageReply = /json\(200, \{\s*id: fileId,\s*url: `\/generated\/\$\{fileId\}\.jpg`\s*\}\);/;
  if (source.split(guard).length !== 2 || !source.includes(originCheck) ||
      source.split(limitCheck).length !== 2) {
    throw new Error('Unexpected authorization structure; guest build stopped.');
  }
  if (!imageReply.test(source)) {
    throw new Error('Unexpected image structure; guest build stopped.');
  }
  const runtime = `
import { initializeApp as nialInitializeApp, cert as nialCert } from 'firebase-admin/app';
import { getAuth as nialGetAuth } from 'firebase-admin/auth';
import { getFirestore as nialGetFirestore } from 'firebase-admin/firestore';
const nialGuestAuth = nialGetAuth(nialInitializeApp({ projectId: 'nial-ai' }, 'nial-guest-auth'));
// Per-minute guest limit lives in process memory and is not shared between serverless instances.
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
// Daily limits are shared between instances through Firestore. Any failure blocks the request.
let nialUsageDb = null;
function nialSafe(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/[^A-Za-z0-9_./-]/g, '').slice(0, 60)
    : '';
}
function nialUsage() {
  if (!nialUsageDb) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw Object.assign(new Error('Usage store is not configured'), { nialStage: 'env-missing' });
    let account;
    try {
      account = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Usage store key is not JSON'), { nialStage: 'env-not-json' });
    }
    if (account?.project_id !== 'nial-ai') {
      console.error('nial usage key project mismatch', JSON.stringify({ keyProject: nialSafe(account?.project_id) }));
    }
    const app = nialInitializeApp(
      { credential: nialCert(account), projectId: 'nial-ai' },
      'nial-guest-usage'
    );
    nialUsageDb = nialGetFirestore(app);
  }
  return nialUsageDb;
}
// kind is 'chat' or 'image'; each kind has its own total and per-guest daily counters.
async function nialChargeGuest(uid, kind) {
  let stage = 'input';
  try {
    if (!/^[A-Za-z0-9]{1,128}$/.test(uid)) return 'unavailable';
    stage = 'config';
    const db = nialUsage();
    stage = 'transaction';
    const image = kind === 'image';
    const day = new Date().toISOString().slice(0, 10);
    const totalRef = db.collection('usage').doc((image ? 'image-day-' : 'day-') + day);
    const guestRef = db.collection('usage').doc((image ? 'image-guest-' : 'guest-') + day + '-' + uid);
    const totalLimit = image ? ${DAILY_IMAGE_TOTAL_LIMIT} : ${DAILY_TOTAL_LIMIT};
    const guestLimit = image ? ${DAILY_IMAGE_GUEST_LIMIT} : ${DAILY_GUEST_LIMIT};
    return await db.runTransaction(async tx => {
      const totalDoc = await tx.get(totalRef);
      const guestDoc = await tx.get(guestRef);
      const total = totalDoc.exists ? Number(totalDoc.data().count) || 0 : 0;
      const guest = guestDoc.exists ? Number(guestDoc.data().count) || 0 : 0;
      if (total >= totalLimit || guest >= guestLimit) return 'limit';
      tx.set(totalRef, { count: total + 1 });
      tx.set(guestRef, { count: guest + 1 });
      return 'ok';
    });
  } catch (error) {
    // Only the stage and codes are logged: error messages may contain parts of the key.
    const detail = {
      stage: nialSafe(error?.nialStage) || stage,
      name: nialSafe(error?.name),
      code: nialSafe(error?.code)
    };
    console.error('nial usage unavailable', JSON.stringify(detail));
    return 'unavailable';
  }
}
async function nialAuthorizeRequest(req) {
  // Preserve the existing browser authentication without changing its scope.
  if (authorized(req)) return true;
  // Guest tokens authorize chat and image generation only, never the page or stored images.
  if (req.method !== 'POST' || !['/chat', '/image'].includes(req.url)) return false;
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
  const quota =
    "const nialImage = req.url === '/image';\n" +
    "    const nialQuota = req.nialFirebaseUid && !req.nialGuestLimited\n" +
    "      ? await nialChargeGuest(req.nialFirebaseUid, nialImage ? 'image' : 'chat') : 'ok';\n" +
    "    if (nialQuota !== 'ok') {\n" +
    "      return json(nialQuota === 'limit' ? 429 : 503, { error: nialQuota === 'limit'\n" +
    "        ? (nialImage ? 'Дневной лимит картинок исчерпан. Попробуй завтра.' : 'Дневной лимит исчерпан. Попробуй завтра.')\n" +
    "        : 'Сервис лимитов недоступен. Попробуй позже.' });\n" +
    "    }\n" +
    "    ";
  // Guests receive the image inside the response: serverless instances do not share the image cache.
  const guestImageReply =
    "if (req.nialFirebaseUid && image.length > 4 * 1024 * 1024) {\n" +
    "      throw new Error('Изображение слишком большое для передачи в приложение.');\n" +
    "    }\n" +
    "    json(200, req.nialFirebaseUid\n" +
    "      ? { id: fileId, mime: 'image/jpeg', data: image.toString('base64') }\n" +
    "      : { id: fileId, url: '/generated/' + fileId + '.jpg' });";
  return runtime + '\n' + source
    .replace(guard, 'if (!(await nialAuthorizeRequest(req))) {')
    .replace(limitCheck, () => quota + 'if (req.nialGuestLimited || recentCalls.length >= 12 || activeCalls >= 3) {')
    .replace(imageReply, () => guestImageReply)
    .replaceAll(originCheck, '(!req.nialFirebaseUid && req.headers.origin !== origin)');
}
