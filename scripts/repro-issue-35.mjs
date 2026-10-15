// Issue #35: unchanged open notes and bulk conflict resolution, using real source.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'gitsync-i35-'));
const bytes = (s) => new TextEncoder().encode(s);
class Element {
 constructor(options = {}) { this.text = options.text; this.children = []; this.events = {}; }
 createEl(tag, options) { const el = new Element(options); el.tag = tag; this.appendChild(el); return el; }
 createDiv(options) { return this.createEl('div', options); }
 appendChild(el) { el.parent = this; this.children.push(el); }
 addClass() {} toggleClass() {} setText(text) { this.text = text; }
 addEventListener(name, cb) { this.events[name] = cb; }
 empty() { this.children = []; }
 remove() { this.parent.children = this.parent.children.filter((el) => el !== this); }
 find(text) { return this.text === text ? this : this.children.map((el) => el.find(text)).find(Boolean); }
}
globalThis.createDiv = () => new Element();
globalThis.window = globalThis;
const stub = join(temp, 'obsidian.mjs');
await writeFile(stub, `
export class TFile { constructor(path) { this.path = path; } }
export class FileSystemAdapter {}
export const Platform = { isMobile: false };
export function getLanguage() { return 'en'; }
export function requestUrl(opts) { return globalThis.requestMock(opts); }
export class Notice { constructor(message) { throw new Error(message); } }
export class Modal {
 constructor() { this.contentEl = createDiv(); this.titleEl = createDiv(); this.modalEl = createDiv(); this.containerEl = createDiv(); }
 close() { this.onClose(); }
}
export class Setting {
 constructor() {} setName() { return this; }
 addDropdown(cb) { const dd = { addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }; cb(dd); return this; }
}
`);
try {
 const entry = join(temp, 'entry.mjs');
 await writeFile(entry, [
  'src/obsidian-fs.ts', 'src/git-fs.ts', 'src/github-sync.ts', 'src/api-conflict-modal.ts', 'src/conflict-modal.ts',
 ].map((p) => `export * from ${JSON.stringify(resolve(p))};`).join('\n') + `\nexport { TFile } from ${JSON.stringify(stub)};`);
 const outfile = join(temp, 'engine.mjs');
 await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', alias: { obsidian: stub }, logLevel: 'error' });
 const { TFile, createSyncAdapter, GitFs, apiSync, gitBlobSha, ApiConflictModal, ConflictModal } = await import(outfile);
 const file = new TFile('note.md');
 let disk = 'base', editor = 'base', notifications = 0;
 const raw = {
  async exists(p) { return p === 'note.md'; },
  async list() { return { files: ['note.md'], folders: [] }; },
  async readBinary() { return bytes(disk).buffer; },
  async write(p, data) { disk = data; },
  async writeBinary(p, data) { disk = new TextDecoder().decode(data); },
  async remove() { disk = null; },
 };
 const vault = {
  adapter: raw,
  getAbstractFileByPath(p) { return p === file.path ? file : null; },
  async modify(f, data) { assert.equal(f, file); disk = editor = data; notifications++; },
  async modifyBinary(f, data) { await this.modify(f, new TextDecoder().decode(data)); },
  async delete(f) { assert.equal(f, file); disk = editor = null; notifications++; },
 };
 const adapter = createSyncAdapter(vault);
 const baseSha = await gitBlobSha(bytes('base'));
 const remoteSha = await gitBlobSha(bytes('remote'));
 globalThis.requestMock = async ({ url, method }) => {
  assert.equal(method, 'GET', 'unchanged local note must never be pushed');
  let json;
  if (url.includes('/git/ref/')) json = { object: { sha: 'commit' } };
  else if (url.includes('/git/commits/')) json = { tree: { sha: 'tree' } };
  else if (url.includes('/git/trees/')) json = { tree: [{ path: 'note.md', type: 'blob', sha: remoteSha, mode: '100644' }] };
  else if (url.includes('/git/blobs/')) return { status: 200, headers: {}, arrayBuffer: bytes('remote').buffer };
  else throw new Error(url);
  return { status: 200, json };
 };
 const options = { owner: 'test', repo: 'test', branch: 'main', token: 'test', adapter, excluded: () => false,
  baseline: { commitSha: 'base', shas: { 'note.md': baseSha } } };
 const result = await apiSync(options);
 assert.deepEqual(result.conflicts, []);
 assert.deepEqual(result.pulled, ['note.md']);
 assert.equal(editor, 'remote', 'API pull updates open editor');
 assert.equal(notifications, 1);
 const repeat = await apiSync({ ...options, baseline: result.newBaseline });
 assert.deepEqual(repeat.conflicts, []);
 assert.deepEqual(repeat.pulled, []);
 disk = 'local edit';
 const conflict = await apiSync(options);
 assert.equal(conflict.conflicts.length, 1, 'real two-sided edits still require resolution');
 assert.equal(disk, 'local edit');
 await new GitFs(adapter).writeFile('/note.md', bytes('git remote'));
 assert.equal(editor, 'git remote', 'Git write also updates open editor');
 await adapter.write('.git/test', 'metadata');
 assert.equal(editor, 'git remote', 'metadata bypasses vault notification');
 await adapter.remove('note.md');
 assert.equal(editor, null, 'deletion notifies Obsidian');
 console.log('✓ API pull and repeat sync need no approval; real conflicts remain; both engines notify open notes');

 const files = Array.from({ length: 50 }, (_, i) => ({ path: `file-${i}`, localContent: i === 0 ? null : bytes('local'), remoteContent: i === 1 ? null : new Uint8Array([255, i]) }));
 for (const side of ['local', 'remote']) {
  let resolved;
  const modal = new ApiConflictModal({}, files, (r) => { resolved = r; }, () => assert.fail('unexpected cancel'));
  modal.onOpen();
  assert.ok(modal.contentEl.find('Resolve & sync'), 'resolve available on first file');
  modal.contentEl.find(`Use ${side} for all`).events.click();
  assert.equal(resolved, undefined, 'bulk selection waits for explicit apply');
  modal.contentEl.find('Resolve & sync').events.click();
  assert.equal(resolved.size, 50);
  for (const f of files) assert.deepEqual(resolved.get(f.path), f[`${side}Content`]);
 }
 for (const side of ['local', 'remote']) {
  let resolved;
  const git = { async isConflictBinary() { return false; }, async readVersion() { return 'text'; }, async readWorkingFile() { return 'merged'; },
   async completeMerge(r) { resolved = r; return {}; } };
  const modal = new ConflictModal({}, git, { files: files.map((f) => f.path) }, () => {}, () => assert.fail('unexpected abort'));
  await modal.onOpen();
  modal.contentEl.find(`Use ${side} for all`).events.click();
  assert.equal(resolved, undefined);
  await modal.resolve(modal.contentEl.find('Resolve & sync'));
  assert.equal(resolved.size, 50);
  for (const value of resolved.values()) assert.equal(value.type, side);
 }
 console.log('✓ Both conflict dialogs resolve 50 files in bulk, preserving binary bytes and deletions');
} finally { await rm(temp, { recursive: true, force: true }); }
