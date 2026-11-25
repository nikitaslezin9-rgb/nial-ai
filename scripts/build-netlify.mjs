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
source = source.replace(pageLine, 'const page = Buffer.from(' + JSON.stringify(html.toString('base64')) + ', \'base64\');');
source = source.replace(start, 'export default ' + start).replace(listen, '});\n');
source = "process.env.NIAL_ORIGIN ||= process.env.URL || 'https://steady-wisp-637e8f.netlify.app';\n" + source;
await mkdir('netlify/server', { recursive: true });
await mkdir('public-nial', { recursive: true });
await writeFile('netlify/server/index.mjs', source);
await writeFile('public-nial/robots.txt', 'User-agent: *\nDisallow: /\n');
execFileSync(process.execPath, ['--check', 'netlify/server/index.mjs'], { stdio: 'inherit' });
