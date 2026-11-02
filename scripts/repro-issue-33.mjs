// Actual production modules; no network or device required.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, appendFile, stat, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'gitsync-i33-'));
const stub = join(dir, 'obsidian.mjs');
try {
 await writeFile(stub, 'export const requestUrl = o => globalThis.requestMock(o);');
 const entry = join(dir, 'entry.mjs');
 await writeFile(entry, ['src/chunked-download.ts', 'src/sync-diagnostics.ts', 'src/github-sync.ts']
  .map(p => `export * from ${JSON.stringify(resolve(p))};`).join('\n'));
 const outfile = join(dir, 'test.mjs');
 await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', alias: { obsidian: stub }, logLevel: 'error' });
 const { downloadInChunks, SyncDiagnostics, apiSync, gitBlobSha } = await import(outfile);
 let maxWrite = 0;
 const adapter = {
  async exists(p) { try { await access(p); return true; } catch { return false; } },
  mkdir: p => mkdir(p), read: p => readFile(p, 'utf8'), write: (p, s) => writeFile(p, s),
  writeBinary: (p, b) => writeFile(p, new Uint8Array(b)),
  async appendBinary(p, b) { maxWrite = Math.max(maxWrite, b.byteLength); await appendFile(p, new Uint8Array(b)); },
  stat, remove: p => rm(p),
 };
 const size = 64_931_472;
 // Deterministic bytes generated one block at a time; independent Node Git hash.
 const make = (offset, length) => Uint8Array.from({ length }, (_, i) => (offset + i) % 251);
 const expected = createHash('sha1').update(`blob ${size}\0`);
 for (let offset = 0; offset < size; offset += 1048576) expected.update(make(offset, Math.min(1048576, size - offset)));
 const sha = expected.digest('hex');
 let requests = 0;
 globalThis.requestMock = async ({ url, headers }) => {
  assert.ok(url.includes('/' + 'a'.repeat(40) + '/folder/large%20file.bin'));
  assert.equal(headers.Authorization, 'Bearer SECRET');
  const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range).map(Number);
  requests++;
  return { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}` }, arrayBuffer: make(start, end - start + 1).buffer };
 };
 const events = [];
 const options = { owner: 'owner', repo: 'repo', commit: 'a'.repeat(40), path: 'folder/large file.bin', sha, size,
  token: 'SECRET', destination: join(dir, 'download.part'), adapter,
  diagnose: async e => {
   events.push(e);
   if (e.stage === 'chunk-complete') {
    // Independently verify the actual assembled on-disk bytes before cleanup.
    const file = await readFile(options.destination);
    assert.equal(createHash('sha1').update(`blob ${size}\0`).update(file).digest('hex'), sha);
   }
  } };
 await downloadInChunks(options);
 assert.equal(requests, 62);
 assert.equal(maxWrite, 1048576);
 assert.equal(await adapter.exists(options.destination), false);
 assert.equal(JSON.stringify(events).includes('SECRET'), false);
 assert.equal(JSON.stringify(events).includes('large file'), false);
 console.log('PASS 64,931,472 bytes, 62 requests, <=1 MiB per append, independent disk SHA-1');
 const good = globalThis.requestMock;
 for (const [name, modify] of [
  ['ignored Range', r => ({ ...r, status: 200 })],
  ['wrong range', r => ({ ...r, headers: { 'Content-Range': `bytes 1-1048576/${size}` } })],
  ['short body', r => ({ ...r, arrayBuffer: new ArrayBuffer(7) })],
  ['unauthorized', r => ({ ...r, status: 401 })],
 ]) {
  globalThis.requestMock = async o => modify(await good(o));
  await assert.rejects(downloadInChunks(options));
  assert.equal(await adapter.exists(options.destination), false);
  console.log('PASS rejects ' + name + ', removes partial');
 }
 // Small cases exercise final digest, empty files, disk failures without 62MB repeats.
 const small = { ...options, size: 3, sha: createHash('sha1').update('blob 3\0abc').digest('hex'), diagnose: async () => {} };
 globalThis.requestMock = async () => ({ status: 206, headers: { 'content-range': 'bytes 0-2/3' }, arrayBuffer: new TextEncoder().encode('bad').buffer });
 await assert.rejects(downloadInChunks(small), /BLOB_HASH_MISMATCH/);
 globalThis.requestMock = async () => { throw new Error('network'); };
 await assert.rejects(downloadInChunks(small), /network/);
 await downloadInChunks({ ...small, size: 0, sha: createHash('sha1').update('blob 0\0').digest('hex') });
 await writeFile(options.destination, 'existing');
 await assert.rejects(downloadInChunks(small), /DESTINATION_EXISTS/);
 assert.equal(await readFile(options.destination, 'utf8'), 'existing');
 await rm(options.destination);
 globalThis.requestMock = async () => ({ status: 206, headers: { 'content-range': 'bytes 0-2/3' }, arrayBuffer: new TextEncoder().encode('abc').buffer });
 await assert.rejects(downloadInChunks({ ...small, adapter: { ...adapter, appendBinary: async () => { throw new Error('disk full'); } } }), /disk full/);
 assert.equal(await adapter.exists(options.destination), false);
 console.log('PASS hash mismatch, network failure, empty blob, existing destination, write failure');
 const logs = join(dir, 'diagnostics');
 let journal = new SyncDiagnostics(adapter, logs);
 await journal.load();
 for (let i = 0; i < 90; i++) await journal.record({ stage: 'chunk-written', bytes: i });
 journal = new SyncDiagnostics(adapter, logs); await journal.load();
 assert.equal(JSON.parse(journal.report()).recent.length, 80);
 assert.equal(JSON.parse(journal.report()).recent.at(-1).bytes, 89);
 await writeFile(join(logs, 'journal-0.json'), '{torn');
 journal = new SyncDiagnostics(adapter, logs); await journal.load();
 assert.equal(JSON.parse(journal.report()).recent.at(-1).bytes, 88);
 assert.equal(JSON.parse(journal.report()).interrupted.at(-1).bytes, 88);
 console.log('PASS bounded journal survives restart and torn latest write; interrupted run preserved');
 globalThis.window = globalThis;
 const original = new TextEncoder().encode('original');
 const incoming = new TextEncoder().encode('incoming');
 const baseSha = await gitBlobSha(original), incomingSha = await gitBlobSha(incoming);
 const stages = [];
 let note = 'original';
 const syncAdapter = {
  async list() { return { files: ['note.md'], folders: [] }; },
  async stat() { return { size: original.length }; },
  async readBinary() { assert.equal(stages.at(-1), 'scan-read'); return original.buffer; },
  async write(p, value) { assert.equal(stages.at(-1), 'pull-write'); note = value; },
 };
 globalThis.requestMock = async ({ url }) => {
  if (url.includes('/git/ref/')) return { status: 200, json: { object: { sha: 'head' } } };
  if (url.includes('/git/commits/')) return { status: 200, json: { tree: { sha: 'tree' } } };
  if (url.includes('/git/trees/')) return { status: 200, json: { tree: [{ type: 'blob', path: 'note.md', sha: incomingSha, size: incoming.length }] } };
  assert.equal(stages.at(-1), 'pull-download');
  return { status: 200, headers: {}, arrayBuffer: incoming.buffer };
 };
 const synced = await apiSync({ owner: 'o', repo: 'r', branch: 'main', token: 'SECRET', adapter: syncAdapter,
  baseline: { commitSha: 'old', shas: { 'note.md': baseSha } }, excluded: () => false,
  diagnose: async e => { stages.push(e.stage); assert.equal(JSON.stringify(e).includes('note.md'), false); } });
 assert.equal(note, 'incoming');
 assert.equal(synced.newBaseline.shas['note.md'], incomingSha);
 assert.deepEqual(stages, ['remote-head', 'remote-tree', 'scan-read', 'scan-hash', 'scan-done', 'pull-download', 'pull-write', 'pull-done']);
 console.log('PASS real API sync checkpoints precede file IO and preserve sync result');

} finally { await rm(dir, { recursive: true, force: true }); }
