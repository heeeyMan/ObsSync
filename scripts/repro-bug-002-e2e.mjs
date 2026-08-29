// End-to-end BUG-002 check: drives the FULL git-engine conflict path against the
// real src/ engine — git.merge (corrupts) → repairConflictBinaries → the REAL
// GitManager.completeMerge (stage + two-parent commit) — and verifies the final
// COMMITTED tree and working tree hold correct binary bytes. Unlike
// repro-bug-002.mjs (which stops after repair), this proves the whole resolve
// flow doesn't re-corrupt.
//
// Run: node scripts/repro-bug-002-e2e.mjs

import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(tag) {
	return new Uint8Array([...PNG_SIG, 0x00, 0x00, 0x00, 0x0d, tag, 0xff, 0xc4, 0xef]);
}
function hasReplacementBytes(buf) {
	for (let i = 0; i + 2 < buf.length; i++)
		if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) return true;
	return false;
}
function startsWithPngSig(buf) { return PNG_SIG.every((b, i) => buf[i] === b); }

async function loadRealEngine() {
	const outdir = await mkdtemp(join(tmpdir(), "gitsync-e2e-"));
	const stubPath = join(outdir, "obsidian-stub.mjs");
	await writeFile(stubPath,
		`export const Platform = { isMobile: false };
		 export function requestUrl() { throw new Error("network disabled in repro"); }
		 export class Notice {}
		 export class Modal {}
		 export class Setting {}
		 export class App {}
		 export function normalizePath(p) { return p; }
		 export function getLanguage() { return "en"; }\n`);
	const entry = join(outdir, "entry.mjs");
	await writeFile(entry,
		`export { binarySafeMergeDriver, repairConflictBinaries, GitManager } from ${JSON.stringify(join(ROOT, "src/git.ts"))};
		 export { GitFs } from ${JSON.stringify(join(ROOT, "src/git-fs.ts"))};\n`);
	const outfile = join(ROOT, "scripts", ".repro-e2e-engine.mjs");
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

// base: note.md + unchanged.png + both.png
// theirs: note.md' + both.png' (remote changed the note AND this image)
// main:   note.md'' + both.png'' (we changed the note AND this image differently)
// → conflicts: note.md (text) AND both.png (binary); unchanged.png is collateral.
async function buildRepo(gitfs) {
	const dir = "/";
	await git.init({ fs: gitfs, dir, defaultBranch: "main" });
	await gitfs.writeFile("notes/note.md", "l1\nshared\nl3\n");
	await gitfs.writeFile("attachments/unchanged.png", png(0x01));
	await gitfs.writeFile("attachments/both.png", png(0x01));
	for (const p of ["notes/note.md", "attachments/unchanged.png", "attachments/both.png"])
		await git.add({ fs: gitfs, dir, filepath: p });
	await git.commit({ fs: gitfs, dir, message: "base", author });

	await git.branch({ fs: gitfs, dir, ref: "theirs", checkout: true });
	await gitfs.writeFile("notes/note.md", "l1\nTHEIR\nl3\n");
	await gitfs.writeFile("attachments/both.png", png(0x02)); // remote's image bytes
	await git.add({ fs: gitfs, dir, filepath: "notes/note.md" });
	await git.add({ fs: gitfs, dir, filepath: "attachments/both.png" });
	await git.commit({ fs: gitfs, dir, message: "remote", author });

	await git.checkout({ fs: gitfs, dir, ref: "main" });
	await gitfs.writeFile("notes/note.md", "l1\nOUR\nl3\n");
	await gitfs.writeFile("attachments/both.png", png(0x03)); // our image bytes
	await git.add({ fs: gitfs, dir, filepath: "notes/note.md" });
	await git.add({ fs: gitfs, dir, filepath: "attachments/both.png" });
	await git.commit({ fs: gitfs, dir, message: "local", author });
}

async function run(engine) {
	section("E2E — merge → repair → REAL completeMerge, check committed + working tree");
	const base = await mkdtemp(join(tmpdir(), "gitsync-e2e-run-"));
	try {
		const adapter = nodeFsAdapter(base);
		const gitfs = new engine.GitFs(adapter);
		const dir = "/";
		await buildRepo(gitfs);

		const oursOid = await git.resolveRef({ fs: gitfs, dir, ref: "main" });
		const theirsOid = await git.resolveRef({ fs: gitfs, dir, ref: "theirs" });

		// 1. The merge isomorphic-git performs inside fetchAndMerge.
		let files = [];
		try {
			await git.merge({ fs: gitfs, dir, ours: "main", theirs: "theirs", author,
				mergeDriver: engine.binarySafeMergeDriver, abortOnConflict: false });
		} catch (e) { files = e?.data?.filepaths ?? []; }
		ok(files.includes("notes/note.md"), "note.md is a (text) conflict");
		ok(files.includes("attachments/both.png"), "both.png is a (binary) conflict");

		// After the merge write-back, the UNRELATED image is corrupted on disk.
		const preRepair = await readFile(join(base, "attachments/unchanged.png"));
		ok(hasReplacementBytes(preRepair) || !startsWithPngSig(preRepair),
			"post-merge: unchanged.png corrupted on disk (isomorphic-git write-back)");

		// 2. The repair pass the plugin runs before handing off the conflict.
		await engine.repairConflictBinaries(gitfs, dir, oursOid, theirsOid, new Set(files));
		const postRepair = await readFile(join(base, "attachments/unchanged.png"));
		ok(Buffer.compare(postRepair, Buffer.from(png(0x01))) === 0,
			"post-repair: unchanged.png restored on disk");

		// 3. The REAL GitManager.completeMerge (resolve note→manual, image→remote).
		const settings = { branch: "main", authorName: "Test", authorEmail: "test@example.com",
			excludePaths: "", commitMessage: "vault sync", remoteUrl: "", token: "", username: "" };
		const gm = new engine.GitManager(adapter, () => settings);
		const resolutions = new Map([
			["notes/note.md", { type: "manual", content: "l1\nRESOLVED\nl3\n" }],
			["attachments/both.png", { type: "remote" }],
		]);
		let commitTip = null;
		try {
			await gm.completeMerge(resolutions, oursOid, theirsOid, "main", undefined, [], null);
		} catch (e) {
			// doPush fails (no remote) — but the two-parent commit is already local.
		}
		commitTip = await git.resolveRef({ fs: gitfs, dir, ref: "main" });

		// 4. Inspect the COMMITTED tree — this is what gets pushed.
		const committedUnchanged = Buffer.from((await git.readBlob({ fs: gitfs, dir, oid: commitTip, filepath: "attachments/unchanged.png" })).blob);
		ok(Buffer.compare(committedUnchanged, Buffer.from(png(0x01))) === 0,
			"COMMITTED unchanged.png is byte-for-byte original");
		ok(startsWithPngSig(committedUnchanged) && !hasReplacementBytes(committedUnchanged),
			"  → valid PNG signature, no U+FFFD");

		const committedBoth = Buffer.from((await git.readBlob({ fs: gitfs, dir, oid: commitTip, filepath: "attachments/both.png" })).blob);
		ok(Buffer.compare(committedBoth, Buffer.from(png(0x02))) === 0,
			"COMMITTED both.png holds the chosen REMOTE bytes");
		ok(startsWithPngSig(committedBoth) && !hasReplacementBytes(committedBoth),
			"  → valid PNG signature, no U+FFFD");

		// 5. Working tree on disk matches too.
		const diskUnchanged = await readFile(join(base, "attachments/unchanged.png"));
		const diskBoth = await readFile(join(base, "attachments/both.png"));
		ok(startsWithPngSig(diskUnchanged) && !hasReplacementBytes(diskUnchanged), "disk unchanged.png valid");
		ok(startsWithPngSig(diskBoth) && !hasReplacementBytes(diskBoth), "disk both.png valid");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

console.log("E2E reproduction — full git-engine conflict resolve preserves binaries (#31 / BUG-002)");
const { mod, cleanup } = await loadRealEngine();
try { await run(mod); } finally { await cleanup(); }
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
