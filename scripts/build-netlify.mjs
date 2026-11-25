import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

let source = await readFile('server.mjs', 'utf8');
const html = await readFile('index.html');
const pageLine = "const page = await readFile(new URL('./index.html', import.meta.url));";
const start = 'http.createServer(async (req, res) => {';
const listen = /\}\)\.listen\(port, binding, \(\) => \{[\s\S]*?\}\);\s*$/;
if (!source.includes(pageLine) || !source.includes(start) || !listen.test(source)) {
  throw new Error('Unexpected server structure; original files have not been changed.');
}
const diagnostics = `
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  let stage;
  try {
    const url = new URL(address);
    if (url.hostname === 'ngw.devices.sberbank.ru' && url.pathname === '/api/v2/oauth') stage = 'oauth';
    if (url.hostname === 'api.giga.chat') stage = 'api';
  } catch {}
  if (!stage) return originalFetch(input, init);
  const id = randomUUID();
  const started = Date.now();
  const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : undefined;
  console.log(JSON.stringify({ event: 'gigachat_start', stage, id }));
  try {
    const response = await originalFetch(input, init);
    console.log(JSON.stringify({ event: 'gigachat_response', stage, id, status: response.status, ms: Date.now() - started }));
    return response;
  } catch (error) {
    console.error(JSON.stringify({ event: 'gigachat_error', stage, id, ms: Date.now() - started, name: safeCode(error?.name), code: safeCode(error?.code), causeCode: safeCode(error?.cause?.code) }));
    throw error;
  }
};
`;
source = source.replace(pageLine, 'const page = Buffer.from(' + JSON.stringify(html.toString('base64')) + ', \'base64\');');
source = source.replace(start, 'export default ' + start).replace(listen, '});\n');
source = "process.env.NIAL_ORIGIN ||= process.env.URL || 'https://steady-wisp-637e8f.netlify.app';\n" + diagnostics + source;
await mkdir('netlify/server', { recursive: true });
await mkdir('public-nial', { recursive: true });
await writeFile('netlify/server/index.mjs', source);
await writeFile('public-nial/robots.txt', 'User-agent: *\nDisallow: /\n');
execFileSync(process.execPath, ['--check', 'netlify/server/index.mjs'], { stdio: 'inherit' });
