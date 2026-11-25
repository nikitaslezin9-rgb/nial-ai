import { readFile, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const response = await fetch('https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt', { signal: AbortSignal.timeout(30000), redirect: 'error' });
if (!response.ok) throw new Error('Official root certificate download failed: HTTP ' + response.status);
const pem = await response.text();
if (pem.length > 20000) throw new Error('Unexpected certificate size');
const cert = new X509Certificate(pem);
if (!cert.ca || !cert.verify(cert.publicKey) || !cert.subject.includes('Russian Trusted Root CA') || Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) {
  throw new Error('Official root certificate validation failed');
}
const prefix = "import * as nialTLS from 'node:tls';\n" +
  "if (typeof nialTLS.setDefaultCACertificates !== 'function') throw new Error('Node.js 24.5+ is required for secure CA configuration');\n" +
  'nialTLS.setDefaultCACertificates([...nialTLS.getCACertificates(\'default\'), ' + JSON.stringify(cert.toString()) + ']);\n' +
  "console.log('GigaChat root CA configured; TLS verification remains enabled');\n";
const target = 'netlify/server/index.mjs';
await writeFile(target, prefix + await readFile(target, 'utf8'));
execFileSync(process.execPath, ['--check', target], { stdio: 'inherit' });
console.log('Official GigaChat root CA fingerprint: ' + cert.fingerprint256);
