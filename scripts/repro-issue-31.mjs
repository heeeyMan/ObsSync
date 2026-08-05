// Reproduces GitHub issue #31 (silent PNG/binary corruption on merge/pull) end
// to end against the REAL plugin code in src/ — no Obsidian required.
//
// Unlike scripts/regression.mjs (which copies the merge driver), this bundles
// the actual src/git.ts + src/github-sync.ts with `obsidian` stubbed, so it
// exercises the shipping functions:
//   - binarySafeMergeDriver  (git engine, desktop)
//   - writeVaultFile / decodeTextOrNull  (GitHub API engine, mobile)
//
// Run: node scripts/repro-issue-31.mjs
// Exit code is non-zero if the fix regressed.

import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
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

// A minimal PNG: 8-byte signature + IHDR-ish bytes. 0x89 is an invalid UTF-8
// lead byte, so a lossy text round-trip turns it into EF BF BD (U+FFFD).
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
  const outdir = await mkdtemp(join(tmpdir(), "gitsync-repro-"));
  const stubPath = join(outdir, "obsidian-stub.mjs");
  await writeFile(
    stubPath,
    // Only the value imports git.ts / github-sync.ts reference need to resolve;
    // none are invoked at import time (requestUrl only fires on a real sync).
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
    `export { binarySafeMergeDriver, isBinaryBytes, GitManager } from ${JSON.stringify(join(ROOT, "src/git.ts"))};
     export { writeVaultFile, decodeTextOrNull } from ${JSON.stringify(join(ROOT, "src/github-sync.ts"))};\n`
  );
  // Output under the project root so Node can resolve the external
  // isomorphic-git / diff3 from node_modules at import time.
  const outfile = join(ROOT, "scripts", ".repro-engine.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "error",
    alias: { obsidian: stubPath },
    // Let Node resolve these from node_modules (their CJS internals do dynamic
    // require("buffer"), which an ESM bundle can't shim).
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

// base PNG → remote edit (theirs) → local edit (main): the same file changed on
// both sides, which is the exact case that triggered corruption.
async function buildBinaryRepo(dir) {
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "attachments"), { recursive: true });

  await writeFile(join(dir, "attachments/photo.png"), png(0x01));
  await git.add({ fs, dir, filepath: "attachments/photo.png" });
  await git.commit({ fs, dir, message: "base", author });

  await git.branch({ fs, dir, ref: "theirs", checkout: true });
  await writeFile(join(dir, "attachments/photo.png"), png(0x02));
  await git.add({ fs, dir, filepath: "attachments/photo.png" });
  await git.commit({ fs, dir, message: "remote edit", author });

  await git.checkout({ fs, dir, ref: "main" });
  await writeFile(join(dir, "attachments/photo.png"), png(0x03));
  await git.add({ fs, dir, filepath: "attachments/photo.png" });
  await git.commit({ fs, dir, message: "local edit", author });
}

// --- Scenario A: git engine (desktop) — the exact issue #31 merge path -------
async function testGitEngine(engine) {
  section("A. Git engine (desktop) — PNG changed on BOTH sides through a real merge");

  // --- CONTROL: stock behaviour (no driver) writes a corrupted working tree ---
  const ctl = await mkdtemp(join(tmpdir(), "gitsync-repro-ctl-"));
  try {
    await buildBinaryRepo(ctl);
    // abortOnConflict:false writes the merged (UTF-8-decoded, corrupted) blob to
    // the working tree before throwing; read it directly, no checkout.
    await git.merge({ fs, dir: ctl, ours: "main", theirs: "theirs", author, abortOnConflict: false })
      .catch(() => {});
    const stock = await readFile(join(ctl, "attachments/photo.png"));
    ok(!startsWithPngSig(stock) || hasReplacementBytes(stock),
      `without the fix: working tree is corrupted (${stock.length} bytes, has U+FFFD=${hasReplacementBytes(stock)})`);
  } finally {
    await rm(ctl, { recursive: true, force: true });
  }

  // --- FIX: real binarySafeMergeDriver from src/git.ts ---
  const dir = await mkdtemp(join(tmpdir(), "gitsync-repro-fix-"));
  try {
    await buildBinaryRepo(dir);
    let threw = false;
    try {
      await git.merge({
        fs, dir, ours: "main", theirs: "theirs", author,
        mergeDriver: engine.binarySafeMergeDriver,
        abortOnConflict: false,
      });
    } catch (e) {
      threw = e?.code === "MergeConflictError" || /conflict/i.test(String(e));
    }
    ok(threw, "with the fix: both-sides binary change raises a CONFLICT (no silent auto-merge)");

    // Resolution reads the untouched blob from each side — prove byte-integrity.
    const oursOid = await git.resolveRef({ fs, dir, ref: "main" });
    const theirsOid = await git.resolveRef({ fs, dir, ref: "theirs" });
    const ours = Buffer.from((await git.readBlob({ fs, dir, oid: oursOid, filepath: "attachments/photo.png" })).blob);
    const theirs = Buffer.from((await git.readBlob({ fs, dir, oid: theirsOid, filepath: "attachments/photo.png" })).blob);
    ok(Buffer.compare(ours, Buffer.from(png(0x03))) === 0, "resolve→local keeps the PNG byte-for-byte");
    ok(Buffer.compare(theirs, Buffer.from(png(0x02))) === 0, "resolve→remote keeps the PNG byte-for-byte");
    ok(startsWithPngSig(ours) && !hasReplacementBytes(ours), "valid PNG signature 89 50 4e 47, no EF BF BD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Scenario B: API engine (mobile) — real writeVaultFile write-back --------
function makeMemoryAdapter() {
  const files = new Map();   // path -> Uint8Array
  const dirs = new Set([""]);
  return {
    files,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async write(p, text) { files.set(p, new TextEncoder().encode(text)); },
    async writeBinary(p, ab) { files.set(p, new Uint8Array(ab).slice()); },
  };
}

async function testApiEngine(engine) {
  section("B. API engine (mobile) — real writeVaultFile stores bytes verbatim");
  const a = makeMemoryAdapter();

  // 1. A pulled PNG must land byte-identical (writeBinary path).
  const pngBytes = png(0x2a);
  await engine.writeVaultFile(a, "attachments/pic.png", pngBytes);
  const stored = a.files.get("attachments/pic.png");
  ok(Buffer.compare(Buffer.from(stored), Buffer.from(pngBytes)) === 0,
    "PNG written through writeVaultFile is byte-for-byte identical");
  ok(startsWithPngSig(stored) && !hasReplacementBytes(stored), "no lossy UTF-8 round-trip");

  // 2. A normal markdown note still round-trips as text (incl. UTF-8/Cyrillic).
  const note = "# Заметка\n\nHello — мир 👋\n";
  const noteBytes = new TextEncoder().encode(note);
  await engine.writeVaultFile(a, "notes/note.md", noteBytes);
  ok(Buffer.compare(Buffer.from(a.files.get("notes/note.md")), Buffer.from(noteBytes)) === 0,
    "UTF-8 markdown round-trips exactly");

  // 3. The subtle case: a NUL-free binary (no 0x00) the OLD heuristic missed.
  //    Old code: "binary iff a NUL byte exists" → would treat this as text and
  //    corrupt it. Real decodeTextOrNull rejects it (invalid UTF-8) → writeBinary.
  const nulFree = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xc0, 0xc1]);
  ok(!nulFree.includes(0x00), "precondition: this binary contains no NUL byte");
  ok(engine.decodeTextOrNull(nulFree) === null,
    "real classifier flags a NUL-free binary as binary (old NUL-only test would not)");
  await engine.writeVaultFile(a, "attachments/nonul.bin", nulFree);
  ok(Buffer.compare(Buffer.from(a.files.get("attachments/nonul.bin")), Buffer.from(nulFree)) === 0,
    "NUL-free binary is stored verbatim, not corrupted");
}

// --- Scenario C: real GitManager.stageAll over a 644-only adapter ------------
// A node-fs DataAdapter that, like Obsidian's, reports NO file mode. GitFs then
// hands git.add a 100644 stat, so this exercises the exact staging path that
// stripped the exec bit — proving the shipped GitManager.stageAll restores it.
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
        // Deliberately mode-less — mirrors Obsidian, so GitFs reports 100644.
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

async function testStageAllExecMode(engine) {
  section("C. Real GitManager.stageAll over a mode-less adapter keeps 100755");
  const dir = await mkdtemp(join(tmpdir(), "gitsync-repro-mode-"));
  try {
    await git.init({ fs, dir, defaultBranch: "main" });
    // commit an executable script (node fs reports 755 → committed 100755)
    await fs.promises.mkdir(join(dir, "deploy"), { recursive: true });
    await writeFile(join(dir, "deploy/setup-vps.sh"), "#!/bin/sh\necho v1\n");
    await fs.promises.chmod(join(dir, "deploy/setup-vps.sh"), 0o755);
    await git.add({ fs, dir, filepath: "deploy/setup-vps.sh" });
    const c0 = await git.commit({ fs, dir, message: "add script", author });
    let mode0;
    await git.walk({ fs, dir, trees: [git.TREE({ ref: c0 })], map: async (fp, [e]) => { if (fp === "deploy/setup-vps.sh" && e) mode0 = (await e.mode()).toString(8); return undefined; } });
    ok(mode0 === "100755", "precondition: committed as 100755");

    // Simulate the real world: content changed + exec bit gone on disk.
    await fs.promises.writeFile(join(dir, "deploy/setup-vps.sh"), "#!/bin/sh\necho v2\n");
    await fs.promises.chmod(join(dir, "deploy/setup-vps.sh"), 0o644);

    // Drive the SHIPPED private stageAll through the mode-less adapter.
    const gm = new engine.GitManager(nodeFsAdapter(dir), () => ({ excludePaths: "" }));
    const staged = await gm.stageAll();
    ok(staged >= 1, "stageAll staged the changed script");

    const cFix = await git.commit({ fs, dir, message: "vault sync", author });
    let modeFix, content;
    await git.walk({ fs, dir, trees: [git.TREE({ ref: cFix })], map: async (fp, [e]) => { if (fp === "deploy/setup-vps.sh" && e) modeFix = (await e.mode()).toString(8); return undefined; } });
    const blob = await git.readBlob({ fs, dir, oid: cFix, filepath: "deploy/setup-vps.sh" });
    content = Buffer.from(blob.blob).toString();
    ok(modeFix === "100755", "GitManager.stageAll preserved 100755 (no mode strip)");
    ok(content.includes("v2"), "the real content change was committed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- run --------------------------------------------------------------------
console.log("Reproduction — binary-safety (#31) & exec-mode preservation against the real src/ engine");
const { mod, cleanup } = await loadRealEngine();
try {
  await testGitEngine(mod);
  await testApiEngine(mod);
  await testStageAllExecMode(mod);
} finally {
  await cleanup();
}
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
