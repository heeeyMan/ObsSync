// Read-only probe. --auth uses gh's existing token, never prints it or response bodies.
import { execFileSync } from 'node:child_process';
const token = process.argv.includes('--auth') ? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() : '';
const auth = token ? { Authorization: `Bearer ${token}` } : {};
const base = 'https://api.github.com/repos/heeeyMan/ObsSync';
const json = async url => { const r = await fetch(url, { headers: auth }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const head = await json(`${base}/commits/main`);
const file = await json(`${base}/contents/README.md?ref=${head.sha}`);
const raw = `https://raw.githubusercontent.com/heeeyMan/ObsSync/${head.sha}/README.md`;
for (const [label, url, extra, method] of [
 ['raw-first', raw, { Range: 'bytes=0-1023' }, 'GET'],
 ['raw-second', raw, { Range: 'bytes=1024-2047' }, 'GET'],
 ['git-blob', `${base}/git/blobs/${file.sha}`, { Range: 'bytes=0-1023', Accept: 'application/vnd.github.raw' }, 'GET'],
 ['raw-cors-preflight', raw, { Origin: 'http://localhost', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,range' }, 'OPTIONS'],
]) {
 const r = await fetch(url, { method, headers: { ...(method === 'GET' ? auth : {}), ...extra } });
 const bytes = (await r.arrayBuffer()).byteLength;
 console.log(JSON.stringify({ label, authenticated: !!token && method === 'GET', status: r.status, bytes,
  contentRange: r.headers.get('content-range'), allowOrigin: r.headers.get('access-control-allow-origin'),
  allowHeaders: r.headers.get('access-control-allow-headers'), commit: head.sha }));
}
