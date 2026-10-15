// Issue #34: reproduce the desktop adapter failure after a mobile rename, then verify two sync passes.
// Run: node scripts/repro-issue-34-roundtrip.mjs

import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import git from "isomorphic-git";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const author = { name: "Test", email: "test@example.com" };

let passed = 0, failed = 0;
function ok(cond, label) {
	if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
	else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m`); }
}
function section(name) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

async function loadRealEngine() {
	const outdir = await mkdtemp(join(tmpdir(), "gitsync-i34-roundtrip-"));
	const stubPath = join(outdir, "obsidian-stub.mjs");
	await writeFile(stubPath,
		`export const Platform = { isMobile: false };
		 export function requestUrl() { throw new Error("network disabled"); }
		 export class FileSystemAdapter {} export class TFile {} export class Notice {} export class Modal {} export class Setting {} export class App {}
		 export function normalizePath(p){return p} export function getLanguage(){return "en"}\n`);
	const entry = join(outdir, "entry.mjs");
	await writeFile(entry,
		`export { GitManager, normalizeCrlf } from ${JSON.stringify(join(ROOT, "src/git.ts"))};
		 export { FileSystemAdapter } from ${JSON.stringify(stubPath)};
         export { createSyncAdapter } from ${JSON.stringify(join(ROOT, "src/obsidian-fs.ts"))};
         export { GitFs } from ${JSON.stringify(join(ROOT, "src/git-fs.ts"))};\n`);
	const outfile = join(ROOT, "scripts", ".repro-i34-roundtrip-engine.mjs");
	await build({ entryPoints: [entry], outfile, bundle: true, format: "esm",
		banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
        platform: "node", logLevel: "error", alias: { obsidian: stubPath },
		external: ["isomorphic-git", "diff3"] });
	const mod = await import(outfile);
	return { mod, cleanup: async () => { await rm(outdir, { recursive: true, force: true }); await rm(outfile, { force: true }); } };
}

function nodeFsAdapter(base) {
	const abs = (p) => join(base, p);
	return {
		async exists(p) { try { await fs.promises.access(abs(p)); return true; } catch { return false; } },
		async read(p) { return await fs.promises.readFile(abs(p), "utf8"); },
		async readBinary(p) { const b = await fs.promises.readFile(abs(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
		async write(p, data) { await fs.promises.mkdir(dirname(abs(p)), { recursive: true }); await fs.promises.writeFile(abs(p), data); },
		async writeBinary(p, ab) { await fs.promises.mkdir(dirname(abs(p)), { recursive: true }); await fs.promises.writeFile(abs(p), Buffer.from(ab)); },
		async remove(p) { await fs.promises.rm(abs(p), { force: true }); },
		async rmdir(p) { await fs.promises.rm(abs(p), { recursive: true, force: true }); },
		async mkdir(p) { await fs.promises.mkdir(abs(p), { recursive: true }); },
		async stat(p) { try { const s = await fs.promises.stat(abs(p)); return { type: s.isDirectory() ? "folder" : "file", size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; } catch { return null; } },
		async list(p) {
			const rel = p === "/" ? "" : p.replace(/^\/+/, "");
			const entries = await fs.promises.readdir(abs(rel), { withFileTypes: true });
			const files = [], folders = [];
			for (const e of entries) { const full = rel ? `${rel}/${e.name}` : e.name; (e.isDirectory() ? folders : files).push(full); }
			return { files, folders };
		},
	};
}



const { mod: engine, cleanup } = await loadRealEngine();
async function scenario(fixed) {
 const dir = await mkdtemp(join(tmpdir(), "gitsync-roundtrip-"));
 try {
  const raw = Object.assign(new engine.FileSystemAdapter(), nodeFsAdapter(dir));
  raw.getFullPath = p => join(dir, p);
  // Match the installed Obsidian 1.14.4 desktop implementation exactly.
  raw.rmdir = (p, recursive) => fs.promises.rm(join(dir, p), { recursive, maxRetries: 5 });
  const adapter = fixed ? engine.createSyncAdapter({ adapter: raw, getAbstractFileByPath: () => null }) : raw;
  const gitfs = new engine.GitFs(adapter);
  const settings = {excludePaths:'', branch:'main', authorName:author.name, authorEmail:author.email};
  const gm = new engine.GitManager(adapter, () => settings);
  await git.init({fs:gitfs,dir:'/',defaultBranch:'main'});
  const paths = ['job/empty.md', 'job/note.md', 'image.bin'];
  for (const p of paths) {
   await gitfs.writeFile(`Variant2/${p}`, p === 'job/empty.md' ? '' : p === 'image.bin' ? new Uint8Array([0,255,128,1]) : 'keep this note');
   await git.add({fs:gitfs,dir:'/',filepath:`Variant2/${p}`});
  }
  const base = await git.commit({fs:gitfs,dir:'/',message:'PC rename already synced to mobile',author});
  // Build the commit the API engine sends for the mobile rename.
  await fs.promises.rename(join(dir,'Variant2'),join(dir,'Variant3'));
  for (const p of paths) {
   await git.remove({fs:gitfs,dir:'/',filepath:`Variant2/${p}`});
   await git.add({fs:gitfs,dir:'/',filepath:`Variant3/${p}`});
  }
  const remote = await git.commit({fs:gitfs,dir:'/',message:'mobile rename',author});
  // Restore the PC's pre-pull state without exercising the buggy cleanup yet.
  await fs.promises.rename(join(dir,'Variant3'),join(dir,'Variant2'));
  await git.writeRef({fs:gitfs,dir:'/',ref:'refs/heads/main',value:base,force:true});
  for (const p of paths) {
   await git.remove({fs:gitfs,dir:'/',filepath:`Variant3/${p}`});
   await git.add({fs:gitfs,dir:'/',filepath:`Variant2/${p}`});
  }
  await git.writeRef({fs:gitfs,dir:'/',ref:'refs/remotes/origin/main',value:remote,force:true});
  let failure;
  try { await gm.mergeRemote('main','refs/remotes/origin/main',base,remote,{},()=>{},[],null,false); }
  catch (e) { failure=e; }
  if (!fixed) {
   ok(failure?.code === 'ERR_FS_EISDIR', 'CONTROL: first pull fails removing an empty directory');
   ok(await git.resolveRef({fs:gitfs,dir:'/',ref:'HEAD'}) === remote, 'CONTROL: HEAD has already advanced');
   ok(!await raw.exists('Variant3/job/note.md'), 'CONTROL: renamed file never reaches PC');
   ok((await gm.listChanges()).some(c=>c.path==='Variant3/job/note.md' && c.status==='deleted'), 'CONTROL: second sync would stage remote file deletion');
   return;
  }
  if (failure) throw failure;
  ok(!await raw.exists('Variant2'), 'FIX: old folder removed on first pull');
  ok(await raw.read('Variant3/job/note.md') === 'keep this note', 'FIX: renamed note present with intact content');
  ok((await raw.stat('Variant3/job/empty.md')).size === 0, 'FIX: empty note preserved');
  ok(Buffer.from(await raw.readBinary('Variant3/image.bin')).equals(Buffer.from([0,255,128,1])), 'FIX: binary note preserved');
  ok((await gm.stageAll()) === 0, 'FIX: second sync stages nothing (no deletion commit)');
  await gm.mergeRemote('main','refs/remotes/origin/main',remote,remote,{},()=>{},[],null,false);
  ok((await gm.listChanges()).length === 0, 'FIX: repeated pull stays clean');
  // Native empty-only deletion must keep a newly-created note even if the
  // directory appeared empty to the cleanup's preceding list call.
  await raw.mkdir('race'); await raw.write('race/keep.md','keep');
  let rejected=false;
  try { await adapter.rmdir('race',false); } catch(e) { rejected=e.code==='ENOTEMPTY'||e.code==='EEXIST'; }
  ok(rejected && await raw.exists('race/keep.md'), 'FIX: nonempty directory cannot be recursively deleted');
 } finally { await rm(dir,{recursive:true,force:true}); }
}
try {
 await scenario(false);
 await scenario(true);
 const calls = [];
 const mobile = engine.createSyncAdapter({adapter: {rmdir: async (...args) => calls.push(args)}});
 await mobile.rmdir('empty', false);
 await mobile.rmdir('recursive', true);
 ok(JSON.stringify(calls) === JSON.stringify([['empty',false],['recursive',true]]),
  'MOBILE: directory deletion delegates to the mobile adapter with its original flags');
} finally { await cleanup(); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
