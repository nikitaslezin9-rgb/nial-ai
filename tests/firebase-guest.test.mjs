import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { addFirebaseGuestAuth } from '../scripts/firebase-guest-build.mjs';

// Firebase is stubbed: these tests do not validate real JWT signatures or contact APIs.
const original = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const password = 'x'.repeat(32);
const basic = 'Basic ' + Buffer.from('nial:' + password).toString('base64');
const origin = 'https://example.invalid';

async function request(method, url, headers = {}) {
  let handler;
  const generated = addFirebaseGuestAuth(original)
    .replace(/^import .+;\r?$/gm, '')
    .replace("const page = await readFile(new URL('./index.html', import.meta.url));", 'const page = Buffer.from("TEST PAGE");');
  const context = {
    Buffer, URL, AbortSignal, createHash, randomUUID, timingSafeEqual,
    process: {
      env: { GIGACHAT_CREDENTIALS: 'test-only', NIAL_ACCESS_PASSWORD: password, NIAL_ORIGIN: origin },
      exit() { throw new Error('Unexpected process.exit'); }
    },
    console,
    http: { createServer(fn) { handler = fn; return { listen() {} }; } },
    nialInitializeApp(options, name) {
      assert.equal(options.projectId, 'nial-ai');
      assert.equal(name, 'nial-guest-auth');
      return {};
    },
    nialGetAuth() {
      return { async verifyIdToken(token) {
        if (token === 'valid.stub.token') return { uid: 'guest-test', firebase: { sign_in_provider: 'anonymous' } };
        if (token === 'member.stub.token') return { uid: 'member-test', firebase: { sign_in_provider: 'password' } };
        if (token === 'empty.stub.token') return { uid: '', firebase: { sign_in_provider: 'anonymous' } };
        throw new Error('Stub verifier rejected token');
      } };
    },
    fetch() { throw new Error('Network calls are forbidden in authorization tests'); }
  };
  vm.runInNewContext(generated, context, { timeout: 3000 });
  assert.equal(typeof handler, 'function');
  const req = {
    method, url, headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from('not-json'); }
  };
  const result = { status: null, headers: {}, body: '' };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    writeHead(status, values) { result.status = status; Object.assign(result.headers, values || {}); },
    once() {},
    end(value) { result.body = String(value ?? ''); }
  };
  await handler(req, res);
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

test('unexpected authorization source structure stops the build', () => {
  assert.throws(() => addFirebaseGuestAuth(''), /Unexpected authorization structure/);
  assert.throws(() => addFirebaseGuestAuth(original + '\nif (!authorized(req)) { }'), /Unexpected authorization structure/);
});
