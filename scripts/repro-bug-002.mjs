// Reproduces issue #31 follow-up "Unrelated conflicts break binary files"
// (tracked as BUG-002) end to end against the REAL plugin code in src/.
//
// The scenario: a TEXT file conflicts on both sides, while binary attachments
// are UNRELATED (unchanged, or changed on only one side). isomorphic-git's
// conflict-path write-back decodes the ENTIRE merged tree as UTF-8 back into the
// working directory, so every binary in the vault gets corrupted even though the
// user is only resolving a text conflict. The fix is GitManager's
// repairConflictBinaries pass (wired into the merge-conflict handler).
//
// Run: node scripts/repro-bug-002.mjs
// Exit code is non-zero if the fix regressed.

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

let passed = 0;
let failed = 0;
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
	for (let i = 0; i + 2 < buf.length; i++) {
		if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) return true;
	}
	return false;
}
function startsWithPngSig(buf) {
	return PNG_SIG.every((b, i) => buf[i] === b);
}

// --- Bundle the real src/ functions with `obsidian` stubbed -----------------
async function loadRealEngine() {
	const outdir = await mkdtemp(join(tmpdir(), "gitsync-bug2-"));
	const stubPath = join(outdir, "obsidian-stub.mjs");
	await writeFile(
		stubPath,
		`export const Platform = { isMobile: false };
		 export function requestUrl() { throw new Error("network disabled in repro"); }
		 export class Notice {}
		 export class Modal {}
		 export class Setting {}
		 export class App {}
		 export function normalizePath(p) { return p; }
		 export function getLanguage() { return "en"; }\n`
	);
	const entry = join(outdir, "entry.mjs");
	await writeFile(
		entry,
		`export { binarySafeMergeDriver, repairConflictBinaries, isBinaryBytes } from ${JSON.stringify(join(ROOT, "src/git.ts"))};
		 export { GitFs } from ${JSON.stringify(join(ROOT, "src/git-fs.ts"))};\n`
	);
	const outfile = join(ROOT, "scripts", ".repro-bug2-engine.mjs");
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "error",
		alias: { obsidian: stubPath },
		external: ["isomorphic-git", "diff3"],
	});
	const mod = await import(outfile);
	return {
		mod,
		cleanup: async () => {
			await rm(outdir, { recursive: true, force: true });
			await rm(outfile, { force: true });
		},
	};
}

// A node-fs DataAdapter (mode-less, like Obsidian's) so GitFs — the exact fs the
// plugin hands isomorphic-git — drives the whole merge on disk.
function nodeFsAdapter(base) {
	const abs = (p) => join(base, p);
	return {
		async exists(p) { try { await fs.promises.access(abs(p)); return true; } catch { return false; } },
		async read(p) { return await fs.promises.readFile(abs(p), "utf8"); },
		async readBinary(p) {
			const b = await fs.promises.readFile(abs(p));
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		},
		async write(p, data) { await fs.promises.mkdir(dirname(abs(p)), { recursive: true }); await fs.promises.writeFile(abs(p), data); },
		async writeBinary(p, ab) { await fs.promises.mkdir(dirname(abs(p)), { recursive: true }); await fs.promises.writeFile(abs(p), Buffer.from(ab)); },
		async remove(p) { await fs.promises.rm(abs(p), { force: true }); },
		async rmdir(p) { await fs.promises.rm(abs(p), { recursive: true, force: true }); },
		async mkdir(p) { await fs.promises.mkdir(abs(p), { recursive: true }); },
		async stat(p) {
			try {
				const s = await fs.promises.stat(abs(p));
				return { type: s.isDirectory() ? "folder" : "file", size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
			} catch { return null; }
		},
		async list(p) {
			const rel = p === "/" ? "" : p.replace(/^\/+/, "");
			const entries = await fs.promises.readdir(abs(rel), { withFileTypes: true });
			const files = [], folders = [];
			for (const e of entries) {
				const full = rel ? `${rel}/${e.name}` : e.name;
				(e.isDirectory() ? folders : files).push(full);
			}
			return { files, folders };
		},
	};
}

// Build a repo whose ONLY genuine conflict is a text note, while binaries cover
// every non-conflicted shape the repair must get right:
//   keep.png        — untouched on both sides            → must stay original
//   remote-only.png — changed on the remote only         → must keep REMOTE bytes
//   local-only.png  — changed on our side only           → must keep OUR bytes
//   we-deleted.png  — deleted on our side, untouched theirs → must NOT resurrect
//   their-add.png   — added on the remote only           → must land (uncorrupted)
async function buildRepo(gitfs) {
	const dir = "/";
	await git.init({ fs: gitfs, dir, defaultBranch: "main" });

	// GitFs.writeFile creates parent folders on demand, so no mkdir needed.
	await gitfs.writeFile("notes/note.md", "line1\nshared\nline3\n");
	await gitfs.writeFile("attachments/keep.png", png(0x01));
	await gitfs.writeFile("attachments/remote-only.png", png(0x01));
	await gitfs.writeFile("attachments/local-only.png", png(0x01));
	await gitfs.writeFile("attachments/we-deleted.png", png(0x01));
	for (const p of [
		"notes/note.md",
		"attachments/keep.png",
		"attachments/remote-only.png",
		"attachments/local-only.png",
		"attachments/we-deleted.png",
	]) {
		await git.add({ fs: gitfs, dir, filepath: p });
	}
	await git.commit({ fs: gitfs, dir, message: "base", author });

	await git.branch({ fs: gitfs, dir, ref: "theirs", checkout: true });
	await gitfs.writeFile("notes/note.md", "line1\nTHEIR change\nline3\n");
	await gitfs.writeFile("attachments/remote-only.png", png(0x02)); // remote edits this binary
	await gitfs.writeFile("attachments/their-add.png", png(0x07)); // remote adds a new binary
	for (const p of ["notes/note.md", "attachments/remote-only.png", "attachments/their-add.png"]) {
		await git.add({ fs: gitfs, dir, filepath: p });
	}
	await git.commit({ fs: gitfs, dir, message: "remote edits", author });

	await git.checkout({ fs: gitfs, dir, ref: "main" });
	await gitfs.writeFile("notes/note.md", "line1\nOUR change\nline3\n");
	await gitfs.writeFile("attachments/local-only.png", png(0x03)); // we edit this binary
	await gitfs.unlink("attachments/we-deleted.png"); // we delete this binary
	await git.add({ fs: gitfs, dir, filepath: "notes/note.md" });
	await git.add({ fs: gitfs, dir, filepath: "attachments/local-only.png" });
	await git.remove({ fs: gitfs, dir, filepath: "attachments/we-deleted.png" });
	await git.commit({ fs: gitfs, dir, message: "local edits + delete", author });
}

async function runMergeToConflict(gitfs, engine) {
	const dir = "/";
	const oursOid = await git.resolveRef({ fs: gitfs, dir, ref: "main" });
	const theirsOid = await git.resolveRef({ fs: gitfs, dir, ref: "theirs" });
	let files = null;
	try {
		await git.merge({
			fs: gitfs, dir, ours: "main", theirs: "theirs", author,
			mergeDriver: engine.binarySafeMergeDriver,
			abortOnConflict: false,
		});
	} catch (e) {
		files = e?.data?.filepaths ?? (e?.code === "MergeConflictError" ? [] : null);
	}
	return { oursOid, theirsOid, files };
}

async function testControl(engine) {
	section("A. CONTROL — a text conflict corrupts UNRELATED binaries (no repair)");
	const base = await mkdtemp(join(tmpdir(), "gitsync-bug2-ctl-"));
	try {
		const gitfs = new engine.GitFs(nodeFsAdapter(base));
		await buildRepo(gitfs);
		const { files } = await runMergeToConflict(gitfs, engine);
		ok(Array.isArray(files) && files.includes("notes/note.md"),
			"the text note is the reported conflict");

		const keep = await readFile(join(base, "attachments/keep.png"));
		ok(!startsWithPngSig(keep) || hasReplacementBytes(keep),
			`untouched binary is corrupted by the merge write-back (${keep.length} bytes, U+FFFD=${hasReplacementBytes(keep)})`);
		const remoteOnly = await readFile(join(base, "attachments/remote-only.png"));
		ok(!startsWithPngSig(remoteOnly) || hasReplacementBytes(remoteOnly),
			`remote-only binary is corrupted too (${remoteOnly.length} bytes, U+FFFD=${hasReplacementBytes(remoteOnly)})`);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

async function testFix(engine) {
	section("B. FIX — repairConflictBinaries restores every non-conflicted binary");
	const base = await mkdtemp(join(tmpdir(), "gitsync-bug2-fix-"));
	try {
		const gitfs = new engine.GitFs(nodeFsAdapter(base));
		await buildRepo(gitfs);
		const { oursOid, theirsOid, files } = await runMergeToConflict(gitfs, engine);

		// The real repair pass the plugin now runs before handing off the conflict.
		await engine.repairConflictBinaries(gitfs, "/", oursOid, theirsOid, new Set(files));

		const keep = await readFile(join(base, "attachments/keep.png"));
		ok(Buffer.compare(keep, Buffer.from(png(0x01))) === 0,
			"untouched binary is byte-for-byte its original");
		ok(startsWithPngSig(keep) && !hasReplacementBytes(keep),
			"  → valid 89 50 4e 47 signature, no U+FFFD");

		const remoteOnly = await readFile(join(base, "attachments/remote-only.png"));
		ok(Buffer.compare(remoteOnly, Buffer.from(png(0x02))) === 0,
			"remote-only binary keeps the REMOTE bytes (the one-sided change is preserved)");
		ok(startsWithPngSig(remoteOnly) && !hasReplacementBytes(remoteOnly),
			"  → valid signature, no U+FFFD");

		const localOnly = await readFile(join(base, "attachments/local-only.png"));
		ok(Buffer.compare(localOnly, Buffer.from(png(0x03))) === 0,
			"local-only binary keeps OUR bytes (our one-sided edit is preserved)");

		const theirAdd = await readFile(join(base, "attachments/their-add.png"));
		ok(Buffer.compare(theirAdd, Buffer.from(png(0x07))) === 0,
			"remote-added binary lands byte-for-byte (one-sided add, uncorrupted)");

		// A binary we deleted must NOT be resurrected by the repair (regression
		// guard: the present-only-side branches must consult the merge base).
		ok(!fs.existsSync(join(base, "attachments/we-deleted.png")),
			"our deletion is honored — the binary is not brought back");

		// The text conflict must be untouched: the note still carries markers.
		const note = await readFile(join(base, "notes/note.md"), "utf8");
		ok(note.includes("<<<<<<<") && note.includes(">>>>>>>"),
			"the text conflict markers are left intact for the resolver");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

console.log("Reproduction — BUG-002: unrelated conflicts corrupt binary files (real src/ engine)");
const { mod, cleanup } = await loadRealEngine();
try {
	await testControl(mod);
	await testFix(mod);
} finally {
	await cleanup();
}
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
