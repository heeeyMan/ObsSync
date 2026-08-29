// Reproduces issue #32 (CRLF/LF false positives on Windows autocrlf) against the
// REAL src/ engine. A text file committed with LF, then rewritten in the working
// tree with CRLF (what Git-for-Windows autocrlf=true checkout produces), must not
// be reported/staged as a change — matching `git status` on the CLI. Real edits
// and binary changes must still be detected.
//
// Run: node scripts/repro-issue-32.mjs

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
	const outdir = await mkdtemp(join(tmpdir(), "gitsync-i32-"));
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
	const outfile = join(ROOT, "scripts", ".repro-i32-engine.mjs");
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x1a, 0x0a]);

async function run(engine) {
	const settings = { excludePaths: "", branch: "main", authorName: "T", authorEmail: "t@e.com", commitMessage: "vault sync", remoteUrl: "", token: "", username: "" };

	section("A. normalizeCrlf (pure)");
	const lf = new TextEncoder().encode("a\nb\nc\n");
	const crlf = new TextEncoder().encode("a\r\nb\r\nc\r\n");
	ok(Buffer.compare(Buffer.from(engine.normalizeCrlf(crlf)), Buffer.from(lf)) === 0, "CRLF bytes normalize to the LF bytes");
	ok(engine.normalizeCrlf(lf) === lf, "LF bytes return the same reference (no-op)");

	section("B. GitManager — CRLF working file over an LF blob is NOT a change (issue #32)");
	const dir = await mkdtemp(join(tmpdir(), "gitsync-i32-run-"));
	try {
		const adapter = nodeFsAdapter(dir);
		const gitfs = new engine.GitFs(adapter);
		await git.init({ fs: gitfs, dir: "/", defaultBranch: "main" });
		// Commit LF text + a binary + a second LF note.
		await gitfs.writeFile("note.md", "line1\nline2\nline3\n");
		await gitfs.writeFile("doc/readme.md", "# Title\n\nbody\n");
		await gitfs.writeFile("img.png", PNG);
		for (const p of ["note.md", "doc/readme.md", "img.png"]) await git.add({ fs: gitfs, dir: "/", filepath: p });
		await git.commit({ fs: gitfs, dir: "/", message: "base (LF)", author });

		const gm = new engine.GitManager(adapter, () => settings);

		// Simulate a Windows autocrlf checkout: rewrite the text files with CRLF.
		await adapter.write("note.md", "line1\r\nline2\r\nline3\r\n");
		await adapter.write("doc/readme.md", "# Title\r\n\r\nbody\r\n");

		ok((await gm.countChanges()) === 0, "countChanges() = 0 (CRLF-only files ignored)");
		ok((await gm.listChanges()).length === 0, "listChanges() empty");
		ok((await gm.stageAll()) === 0, "stageAll() stages nothing");

		section("C. A REAL edit is still detected (CRLF file whose content actually changed)");
		await adapter.write("note.md", "line1\r\nCHANGED\r\nline3\r\n");
		const changes = await gm.listChanges();
		ok(changes.length === 1 && changes[0].path === "note.md", "the genuinely edited file shows as 1 change");
		ok((await gm.countChanges()) === 1, "countChanges() = 1");

		section("D. A changed BINARY is still detected (never treated as line-ending)");
		await adapter.writeBinary("img.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x11]).buffer);
		const withBin = (await gm.listChanges()).map((c) => c.path).sort();
		ok(withBin.includes("img.png"), "the changed PNG is reported as a change");

		section("E. Staging commits ONLY the real edits, not the CRLF-only file");
		// doc/readme.md is still CRLF-only (unchanged content) — must stay out.
		const staged = await gm.stageAll();
		await git.commit({ fs: gitfs, dir: "/", message: "sync", author });
		ok(staged === 2, "stageAll staged exactly the 2 real changes (note.md edit + img.png)");
		let committedReadme;
		await git.walk({ fs: gitfs, dir: "/", trees: [git.TREE({ ref: "HEAD" })], map: async (fp, [e]) => { if (fp === "doc/readme.md" && e) committedReadme = Buffer.from((await e.content())).toString(); return undefined; } });
		ok(committedReadme === "# Title\n\nbody\n", "doc/readme.md in HEAD is still the original LF blob (no CRLF committed)");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

console.log("Reproduction — issue #32: CRLF/LF working-tree files are not false-positive changes");
const { mod, cleanup } = await loadRealEngine();
try { await run(mod); } finally { await cleanup(); }
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
