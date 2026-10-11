// Issue #34: real Git checkouts prune obsolete folders without deleting untracked files.
// Run: node scripts/repro-issue-34.mjs

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
	const outdir = await mkdtemp(join(tmpdir(), "gitsync-i34-"));
	const stubPath = join(outdir, "obsidian-stub.mjs");
	await writeFile(stubPath,
		`export const Platform = { isMobile: false };
		 export function requestUrl() { throw new Error("network disabled"); }
		 export class Notice {} export class Modal {} export class Setting {} export class App {}
		 export function normalizePath(p){return p} export function getLanguage(){return "en"}\n`);
	const entry = join(outdir, "entry.mjs");
	await writeFile(entry,
		`export { GitManager, normalizeCrlf } from ${JSON.stringify(join(ROOT, "src/git.ts"))};
		 export { GitFs } from ${JSON.stringify(join(ROOT, "src/git-fs.ts"))};\n`);
	const outfile = join(ROOT, "scripts", ".repro-i34-engine.mjs");
	await build({ entryPoints: [entry], outfile, bundle: true, format: "esm",
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
const dir = await mkdtemp(join(tmpdir(), "gitsync-i34-run-"));
try {
 const adapter = nodeFsAdapter(dir);
 // Enforce Obsidian's non-recursive rmdir contract in the adapter stub.
 adapter.rmdir = async (p, recursive) => recursive
  ? fs.promises.rm(join(dir, p), { recursive: true })
  : fs.promises.rmdir(join(dir, p));
 const gitfs = new engine.GitFs(adapter);
 await git.init({ fs: gitfs, dir: "/", defaultBranch: "main" });
 await gitfs.writeFile("old/nested/note.md", "note");
 await git.add({ fs: gitfs, dir: "/", filepath: "old/nested/note.md" });
 const base = await git.commit({ fs: gitfs, dir: "/", message: "base", author });
 await gitfs.unlink("old/nested/note.md");
 await git.remove({ fs: gitfs, dir: "/", filepath: "old/nested/note.md" });
 await gitfs.writeFile("new/nested/note.md", "note");
 await git.add({ fs: gitfs, dir: "/", filepath: "new/nested/note.md" });
 const renamed = await git.commit({ fs: gitfs, dir: "/", message: "rename", author });
 await git.checkout({ fs: gitfs, dir: "/", ref: base });
 ok(await adapter.exists("old/nested/note.md"), "base checkout restores original folder");
 ok(!(await adapter.exists("new")), "checkout removes obsolete nested folders");
 await gitfs.writeFile("old/untracked.md", "keep");
 await git.checkout({ fs: gitfs, dir: "/", ref: renamed });
 ok(await adapter.exists("new/nested/note.md"), "rename checkout creates new folder");
 ok(!(await adapter.exists("old/nested")), "rename checkout removes empty old subfolder");
 ok(await adapter.exists("old/untracked.md"), "untracked files survive cleanup");
 await gitfs.writeFile("deleted/a/note.md", "note");
 await gitfs.unlink("deleted/a/note.md");
 ok(!(await adapter.exists("deleted")), "deletion prunes all empty ancestors");
 await gitfs.writeFile(".obsidian/cache/note.md", "keep config folder");
 await gitfs.unlink(".obsidian/cache/note.md");
 ok(await adapter.exists(".obsidian/cache"), "hidden configuration directories survive");
 ok(await adapter.exists(".git"), "repository metadata survives checkout");
} finally {
 await rm(dir, { recursive: true, force: true });
 await cleanup();
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
