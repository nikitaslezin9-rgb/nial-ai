import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { addFirebaseGuestAuth } from '../scripts/firebase-guest-build.mjs';

// Firebase and Firestore are stubbed: these tests do not validate real JWT signatures or contact APIs.
const original = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const password = 'x'.repeat(32);
const basic = 'Basic ' + Buffer.from('nial:' + password).toString('base64');
const origin = 'https://example.invalid';
const today = new Date().toISOString().slice(0, 10);

function fakeDb(seed, broken) {
  const docs = new Map(Object.entries(seed).map(([path, data]) => [path, { ...data }]));
  return {
    docs,
    collection(name) { return { doc(id) { return { path: name + '/' + id }; } }; },
    async runTransaction(fn) {
      if (broken) throw new Error('Stub store unavailable');
      const writes = [];
      const tx = {
        async get(ref) { const data = docs.get(ref.path); return { exists: Boolean(data), data: () => data }; },
        set(ref, data) { writes.push([ref.path, { ...data }]); }
      };
      const result = await fn(tx);
      for (const [path, data] of writes) docs.set(path, data);
      return result;
    }
  };
}

function makeHandler({ seed = {}, broken = false, configured = true } = {}) {
  let handler;
  const db = fakeDb(seed, broken);
  const generated = addFirebaseGuestAuth(original)
    .replace(/^import .+;\r?$/gm, '')
    .replace("const page = await readFile(new URL('./index.html', import.meta.url));", 'const page = Buffer.from("TEST PAGE");');
  const env = { GIGACHAT_CREDENTIALS: 'test-only', NIAL_ACCESS_PASSWORD: password, NIAL_ORIGIN: origin };
  if (configured) env.FIREBASE_SERVICE_ACCOUNT = '{"stub":true}';
  const context = {
    Buffer, URL, AbortSignal, createHash, randomUUID, timingSafeEqual,
    process: { env, exit() { throw new Error('Unexpected process.exit'); } },
    console,
    http: { createServer(fn) { handler = fn; return { listen() {} }; } },
    nialInitializeApp(options, name) {
      assert.equal(options.projectId, 'nial-ai');
      assert.ok(['nial-guest-auth', 'nial-guest-usage'].includes(name));
      if (name === 'nial-guest-usage') assert.ok(options.credential);
      return { name };
    },
    nialCert(account) { return { account }; },
    nialGetFirestore() { return db; },
    nialGetAuth() {
      return { async verifyIdToken(token) {
        if (token === 'valid.stub.token') return { uid: 'guesttest', firebase: { sign_in_provider: 'anonymous' } };
        if (token === 'other.stub.token') return { uid: 'guestother', firebase: { sign_in_provider: 'anonymous' } };
        if (token === 'member.stub.token') return { uid: 'membertest', firebase: { sign_in_provider: 'password' } };
        if (token === 'empty.stub.token') return { uid: '', firebase: { sign_in_provider: 'anonymous' } };
        throw new Error('Stub verifier rejected token');
      } };
    },
    fetch() { throw new Error('Network calls are forbidden in authorization tests'); }
  };
  vm.runInNewContext(generated, context, { timeout: 3000 });
  assert.equal(typeof handler, 'function');
  handler.db = db;
  return handler;
}

async function request(method, url, headers = {}, handler = makeHandler()) {
  const req = {
    method, url, headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from('not-json'); }
  };
  const result = { status: null, headers: {}, body: '' };
  const finishers = [];
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    writeHead(status, values) { result.status = status; Object.assign(result.headers, values || {}); },
    once(event, fn) { if (event === 'finish') finishers.push(fn); },
    end(value) { result.body = String(value ?? ''); }
  };
  await handler(req, res);
  finishers.forEach(fn => fn());
  assert.notEqual(result.status, null);
  return result;
}

const jsonHeaders = { 'content-type': 'application/json' };
const bearer = token => ({ ...jsonHeaders, authorization: 'Bearer ' + token });

test('health endpoint remains accessible without credentials', async () => {
  const result = await request('GET', '/healthz');
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
});

test('chat rejects missing credentials', async () => {
  assert.equal((await request('POST', '/chat', jsonHeaders)).status, 401);
});

test('chat rejects tokens rejected by the verifier', async () => {
  assert.equal((await request('POST', '/chat', bearer('invalid.stub.token'))).status, 401);
});

test('verified anonymous chat passes auth without browser Origin and reaches JSON validation', async () => {
  const result = await request('POST', '/chat', bearer('valid.stub.token'));
  assert.equal(result.status, 400);
  assert.match(JSON.parse(result.body).error, /JSON/);
});

test('verified non-anonymous users are rejected', async () => {
  assert.equal((await request('POST', '/chat', bearer('member.stub.token'))).status, 401);
});

test('empty verified UID is rejected', async () => {
  assert.equal((await request('POST', '/chat', bearer('empty.stub.token'))).status, 401);
});

test('guest tokens cannot open the page or image endpoints', async () => {
  assert.equal((await request('GET', '/', bearer('valid.stub.token'))).status, 401);
  assert.equal((await request('POST', '/image', bearer('valid.stub.token'))).status, 401);
  assert.equal((await request('GET', '/generated/test.jpg', bearer('valid.stub.token'))).status, 401);
});

test('existing browser credentials still open the page', async () => {
  const result = await request('GET', '/', { authorization: basic });
  assert.equal(result.status, 200);
  assert.equal(result.body, 'TEST PAGE');
});

test('browser chat still requires its original Origin', async () => {
  assert.equal((await request('POST', '/chat', { ...jsonHeaders, authorization: basic })).status, 403);
});

test('guest chat still requires JSON content type', async () => {
  assert.equal((await request('POST', '/chat', { authorization: 'Bearer valid.stub.token' })).status, 415);
});

test('one guest is limited per UID per minute without blocking another guest', async () => {
  const handler = makeHandler();
  for (let i = 0; i < 6; i++) {
    assert.equal((await request('POST', '/chat', bearer('valid.stub.token'), handler)).status, 400);
  }
  assert.equal((await request('POST', '/chat', bearer('valid.stub.token'), handler)).status, 429);
  assert.equal((await request('POST', '/chat', bearer('other.stub.token'), handler)).status, 400);
});

test('guest requests are counted in the shared daily store', async () => {
  const handler = makeHandler();
  await request('POST', '/chat', bearer('valid.stub.token'), handler);
  await request('POST', '/chat', bearer('other.stub.token'), handler);
  assert.equal(handler.db.docs.get('usage/day-' + today).count, 2);
  assert.equal(handler.db.docs.get('usage/guest-' + today + '-guesttest').count, 1);
});

test('daily per-guest limit returns 429', async () => {
  const handler = makeHandler({ seed: { ['usage/guest-' + today + '-guesttest']: { count: 40 } } });
  const blocked = await request('POST', '/chat', bearer('valid.stub.token'), handler);
  assert.equal(blocked.status, 429);
  assert.equal((await request('POST', '/chat', bearer('other.stub.token'), handler)).status, 400);
});

test('daily total limit returns 429 for every guest', async () => {
  const handler = makeHandler({ seed: { ['usage/day-' + today]: { count: 500 } } });
  assert.equal((await request('POST', '/chat', bearer('other.stub.token'), handler)).status, 429);
});

test('unavailable or unconfigured usage store blocks guests', async () => {
  assert.equal((await request('POST', '/chat', bearer('valid.stub.token'), makeHandler({ broken: true }))).status, 503);
  assert.equal((await request('POST', '/chat', bearer('valid.stub.token'), makeHandler({ configured: false }))).status, 503);
});

test('browser users are not charged to the guest store', async () => {
  const handler = makeHandler();
  await request('POST', '/chat', { ...jsonHeaders, authorization: basic, origin }, handler);
  assert.equal(handler.db.docs.size, 0);
});

test('unexpected authorization source structure stops the build', () => {
  assert.throws(() => addFirebaseGuestAuth(''), /Unexpected authorization structure/);
  assert.throws(() => addFirebaseGuestAuth(original + '\nif (!authorized(req)) { }'), /Unexpected authorization structure/);
});
