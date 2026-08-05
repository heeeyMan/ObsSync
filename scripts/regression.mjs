// GitSync git-semantics regression suite.
//
// There is no test runner for the Obsidian-coupled code (GitFs, requestUrl
// HTTP, modals) — those must be exercised live in a vault (see TESTING.md).
// What CAN be validated offline is the Git semantics the plugin relies on:
// merge/commit/staging behaviour, selective-sync snapshot/restore, NFC path
// normalization, and branch-name validation. This suite drives the real
// isomorphic-git against node:fs in a throwaway temp repo — the same approach
// the project uses to verify changes to git.ts without launching Obsidian.
//
// Run: npm test   (or: node scripts/regression.mjs)
// Exit code is non-zero if any assertion fails, so it works in CI.

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import diff3Merge from "diff3";

let passed = 0;
let failed = 0;
const author = { name: "Test", email: "test@example.com" };

function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m`);
  }
}

function section(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gitsync-test-"));
  try {
    await git.init({ fs, dir, defaultBranch: "main" });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- 1. Merge: two-parent commit, no loss of non-conflicting changes --------
async function testCleanMerge() {
  section("Merge — non-conflicting changes from both sides are preserved");
  await withRepo(async (dir) => {
    await writeFile(join(dir, "a.md"), "a base\n");
    await writeFile(join(dir, "b.md"), "b base\n");
    await git.add({ fs, dir, filepath: "a.md" });
    await git.add({ fs, dir, filepath: "b.md" });
    const base = await git.commit({ fs, dir, message: "base", author });

    // "remote" branch edits b.md
    await git.branch({ fs, dir, ref: "theirs", checkout: true });
    await writeFile(join(dir, "b.md"), "b base\nremote line\n");
    await git.add({ fs, dir, filepath: "b.md" });
    const theirs = await git.commit({ fs, dir, message: "remote edit", author });

    // local branch edits a.md
    await git.checkout({ fs, dir, ref: "main" });
    await writeFile(join(dir, "a.md"), "a base\nlocal line\n");
    await git.add({ fs, dir, filepath: "a.md" });
    const ours = await git.commit({ fs, dir, message: "local edit", author });

    const result = await git.merge({
      fs, dir, ours: "main", theirs: "theirs", author, abortOnConflict: false,
    });
    await git.checkout({ fs, dir, ref: "main" });

    const mergeOid = result.oid ?? (await git.resolveRef({ fs, dir, ref: "main" }));
    const commit = await git.readCommit({ fs, dir, oid: mergeOid });
    ok(commit.commit.parent.length === 2, "merge commit has exactly 2 parents");
    ok(
      commit.commit.parent.includes(ours) && commit.commit.parent.includes(theirs),
      "parents are local and remote tips"
    );

    const a = await readFile(join(dir, "a.md"), "utf8");
    const b = await readFile(join(dir, "b.md"), "utf8");
    ok(a.includes("local line"), "local change to a.md kept");
    ok(b.includes("remote line"), "remote change to b.md merged in");
    ok(base !== mergeOid, "merge advanced history");
  });
}

// --- 2. Conflict detection writes markers -----------------------------------
async function testConflict() {
  section("Merge — overlapping edits raise a conflict with markers");
  await withRepo(async (dir) => {
    await writeFile(join(dir, "c.md"), "line1\nline2\nline3\n");
    await git.add({ fs, dir, filepath: "c.md" });
    await git.commit({ fs, dir, message: "base", author });

    await git.branch({ fs, dir, ref: "theirs", checkout: true });
    await writeFile(join(dir, "c.md"), "line1\nREMOTE\nline3\n");
    await git.add({ fs, dir, filepath: "c.md" });
    await git.commit({ fs, dir, message: "remote", author });

    await git.checkout({ fs, dir, ref: "main" });
    await writeFile(join(dir, "c.md"), "line1\nLOCAL\nline3\n");
    await git.add({ fs, dir, filepath: "c.md" });
    await git.commit({ fs, dir, message: "local", author });

    let threw = false;
    try {
      await git.merge({ fs, dir, ours: "main", theirs: "theirs", author, abortOnConflict: false });
    } catch (e) {
      threw = e?.code === "MergeConflictError" || /conflict/i.test(String(e));
    }
    ok(threw, "overlapping edits throw MergeConflictError");

    const content = await readFile(join(dir, "c.md"), "utf8");
    ok(content.includes("<<<<<<<") && content.includes(">>>>>>>"), "conflict markers written to working tree");
    ok(content.includes("LOCAL") && content.includes("REMOTE"), "both sides present in markers");
  });
}

// --- 2b. Binary safety: a binary file changed on BOTH sides must not be -----
// UTF-8-decoded and re-encoded by the merge (that silently corrupts it — a
// PNG's leading 0x89 becomes EF BF BD). Mirrors src/git.ts binarySafeMergeDriver
// (kept in sync); the driver forces a conflict for binary and delegates text to
// the same `diff3` isomorphic-git bundles.
const LINEBREAKS = /^.*(\r?\n|$)/gm;
function decodedLooksBinary(text) {
  return text.includes("\u0000") || text.includes("\uFFFD");
}
function binarySafeMergeDriver({ branches, contents }) {
  if (contents.some(decodedLooksBinary)) {
    return { cleanMerge: false, mergedText: contents[1] ?? "" };
  }
  const ourName = branches[1];
  const theirName = branches[2];
  const ours = contents[1].match(LINEBREAKS) ?? [];
  const base = contents[0].match(LINEBREAKS) ?? [];
  const theirs = contents[2].match(LINEBREAKS) ?? [];
  const result = diff3Merge(ours, base, theirs);
  let mergedText = "";
  let cleanMerge = true;
  for (const item of result) {
    if (item.ok) mergedText += item.ok.join("");
    if (item.conflict) {
      cleanMerge = false;
      mergedText += `${"<".repeat(7)} ${ourName}\n${item.conflict.a.join("")}`;
      mergedText += `${"=".repeat(7)}\n${item.conflict.b.join("")}`;
      mergedText += `${">".repeat(7)} ${theirName}\n`;
    }
  }
  return { cleanMerge, mergedText };
}

// A PNG signature + a byte no valid UTF-8 text contains, per side.
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngLike(tag) {
  return new Uint8Array([...PNG_SIG, 0x00, 0x01, 0x02, tag, 0xff, 0xfe]);
}

async function makeBothSidesBinaryRepo(dir) {
  await writeFile(join(dir, "img.png"), pngLike(0x10)); // base
  await git.add({ fs, dir, filepath: "img.png" });
  await git.commit({ fs, dir, message: "base", author });

  await git.branch({ fs, dir, ref: "theirs", checkout: true });
  await writeFile(join(dir, "img.png"), pngLike(0x22)); // remote edit
  await git.add({ fs, dir, filepath: "img.png" });
  await git.commit({ fs, dir, message: "remote", author });

  await git.checkout({ fs, dir, ref: "main" });
  await writeFile(join(dir, "img.png"), pngLike(0x33)); // local edit
  await git.add({ fs, dir, filepath: "img.png" });
  await git.commit({ fs, dir, message: "local", author });
}

function hasReplacementBytes(buf) {
  // EF BF BD is UTF-8 for U+FFFD — the signature of a lossy binary→text decode.
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) return true;
  }
  return false;
}

async function testBinaryMergeDefaultCorrupts() {
  section("Binary — the DEFAULT merge driver corrupts a both-sides PNG (the bug)");
  await withRepo(async (dir) => {
    await makeBothSidesBinaryRepo(dir);
    // No mergeDriver → isomorphic-git decodes both blobs as UTF-8 and re-encodes.
    await git.merge({ fs, dir, ours: "main", theirs: "theirs", author, abortOnConflict: false })
      .catch(() => {});
    const merged = await readFile(join(dir, "img.png"));
    const intact = Buffer.compare(merged, Buffer.from(pngLike(0x33))) === 0 ||
      Buffer.compare(merged, Buffer.from(pngLike(0x22))) === 0;
    ok(!intact || hasReplacementBytes(merged),
      "default driver corrupts the binary (documents why the fix is needed)");
  });
}

async function testBinaryMergeDriverSafe() {
  section("Binary — binarySafeMergeDriver conflicts instead of corrupting, blobs intact");
  await withRepo(async (dir) => {
    await makeBothSidesBinaryRepo(dir);

    let threw = false;
    try {
      await git.merge({
        fs, dir, ours: "main", theirs: "theirs", author,
        mergeDriver: binarySafeMergeDriver,
        abortOnConflict: false,
      });
    } catch (e) {
      threw = e?.code === "MergeConflictError" || /conflict/i.test(String(e));
    }
    ok(threw, "both-sides binary change raises a conflict (not a silent auto-merge)");

    // Resolution reads the original blob bytes from each side's commit — prove
    // both are byte-for-byte intact (no U+FFFD, correct length).
    const oursOid = await git.resolveRef({ fs, dir, ref: "main" });
    const theirsOid = await git.resolveRef({ fs, dir, ref: "theirs" });
    const oursBlob = await git.readBlob({ fs, dir, oid: oursOid, filepath: "img.png" });
    const theirsBlob = await git.readBlob({ fs, dir, oid: theirsOid, filepath: "img.png" });
    ok(Buffer.compare(Buffer.from(oursBlob.blob), Buffer.from(pngLike(0x33))) === 0,
      "local (ours) blob is byte-for-byte intact");
    ok(Buffer.compare(Buffer.from(theirsBlob.blob), Buffer.from(pngLike(0x22))) === 0,
      "remote (theirs) blob is byte-for-byte intact");
    ok(!hasReplacementBytes(Buffer.from(oursBlob.blob)) &&
       !hasReplacementBytes(Buffer.from(theirsBlob.blob)),
      "no U+FFFD replacement bytes introduced");
  });
}

async function testBinaryMergeTextStillMerges() {
  section("Binary — text files still auto-merge cleanly under the driver");
  await withRepo(async (dir) => {
    // Same file, non-overlapping edits on each side → diff3 merges cleanly.
    await writeFile(join(dir, "note.md"), "l1\nl2\nl3\nl4\nl5\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "base", author });

    await git.branch({ fs, dir, ref: "theirs", checkout: true });
    await writeFile(join(dir, "note.md"), "l1\nl2\nl3\nl4\nREMOTE\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "remote", author });

    await git.checkout({ fs, dir, ref: "main" });
    await writeFile(join(dir, "note.md"), "LOCAL\nl2\nl3\nl4\nl5\n");
    await git.add({ fs, dir, filepath: "note.md" });
    await git.commit({ fs, dir, message: "local", author });

    await git.merge({
      fs, dir, ours: "main", theirs: "theirs", author,
      mergeDriver: binarySafeMergeDriver,
      abortOnConflict: false,
    });
    // merge() updates the ref but not the working tree; check out to inspect it.
    await git.checkout({ fs, dir, ref: "main", force: true });
    const merged = await readFile(join(dir, "note.md"), "utf8");
    ok(merged.includes("LOCAL") && merged.includes("REMOTE") && !merged.includes("<<<<<<<"),
      "non-overlapping text edits merge without a conflict");
  });
}

// --- 2c. File mode: staging a changed executable must keep its 100755 bit ----
// GitFs can't report a file's exec bit (always 100644), so plain `git.add`
// strips 100755 and produces an endless mode-flip commit. GitManager.stageAll
// snapshots the exec paths from HEAD and re-applies 100755 via git.updateIndex;
// this mirrors that add→restore sequence against real isomorphic-git.
async function treeMode(dir, commitOid, filepath) {
  let mode;
  await git.walk({
    fs, dir, trees: [git.TREE({ ref: commitOid })],
    map: async (fp, [e]) => { if (fp === filepath && e) mode = (await e.mode()).toString(8); return undefined; },
  });
  return mode;
}
async function stagedOid(dir, filepath) {
  let oid;
  await git.walk({
    fs, dir, trees: [git.STAGE()],
    map: async (fp, [e]) => { if (fp === filepath && e) oid = await e.oid(); return undefined; },
  });
  return oid;
}
async function testExecModePreserved() {
  section("File mode — re-staging a changed executable keeps its 100755 bit");
  await withRepo(async (dir) => {
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\necho hi\n");
    await fs.promises.chmod(join(dir, "deploy.sh"), 0o755);
    await git.add({ fs, dir, filepath: "deploy.sh" });
    const c0 = await git.commit({ fs, dir, message: "add script", author });
    ok((await treeMode(dir, c0, "deploy.sh")) === "100755", "precondition: committed as 100755");

    // The plugin's world: content changed upstream, and the working file has lost
    // its exec bit (GitFs reports 100644; checkout never chmods). Simulate with a
    // content edit + chmod 644.
    // CONTROL — plain add strips the bit (the reported bug).
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\necho changed\n");
    await fs.promises.chmod(join(dir, "deploy.sh"), 0o644);
    await git.add({ fs, dir, filepath: "deploy.sh" });
    const cBug = await git.commit({ fs, dir, message: "bug", author });
    ok((await treeMode(dir, cBug, "deploy.sh")) === "100644", "control: plain add strips exec bit (the bug)");

    // FIX — restore 100755 on the freshly-staged oid (mirrors restoreExecMode).
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\necho fixed\n");
    await fs.promises.chmod(join(dir, "deploy.sh"), 0o644);
    await git.add({ fs, dir, filepath: "deploy.sh" });
    const oid = await stagedOid(dir, "deploy.sh");
    await git.updateIndex({ fs, dir, filepath: "deploy.sh", oid, mode: 0o100755, add: true });
    const cFix = await git.commit({ fs, dir, message: "fixed", author });
    ok((await treeMode(dir, cFix, "deploy.sh")) === "100755", "fix: exec bit preserved after re-staging changed content");
    const blob = await git.readBlob({ fs, dir, oid: cFix, filepath: "deploy.sh" });
    ok(Buffer.from(blob.blob).toString().includes("fixed"), "fix: the new content is committed too (a real change, not a mode-only no-op)");

    // And a second sync would see NO change (no ping-pong): status is clean.
    await fs.promises.chmod(join(dir, "deploy.sh"), 0o644);
    const m = await git.statusMatrix({ fs, dir, filter: (f) => f === "deploy.sh" });
    const [, head, workdir, stage] = m[0];
    ok(head === 1 && workdir === 1 && stage === 1, "fix: no residual change → no mode-flip ping-pong");
  });
}

// --- 3. Selective-sync snapshot/restore (the C2 guarantee) ------------------
// Mirrors git.ts: a deselected/excluded file edited on disk is snapshotted
// before a merge checkout clobbers it, then restored afterwards.
async function testSnapshotRestore() {
  section("Selective sync — snapshot restores a clobbered on-disk edit");
  await withRepo(async (dir) => {
    await writeFile(join(dir, "keep.md"), "v0\n");
    await git.add({ fs, dir, filepath: "keep.md" });
    await git.commit({ fs, dir, message: "base", author });

    // User edits keep.md on disk but deselects it (not staged/committed).
    await writeFile(join(dir, "keep.md"), "v0\nUNCOMMITTED USER EDIT\n");
    // Snapshot before the destructive checkout (what git.ts captures).
    const snapshot = new Map();
    snapshot.set("keep.md", await readFile(join(dir, "keep.md")));

    // A merge checkout reverts the working tree to committed content.
    await git.checkout({ fs, dir, ref: "main", force: true });
    const clobbered = await readFile(join(dir, "keep.md"), "utf8");
    ok(!clobbered.includes("UNCOMMITTED"), "precondition: checkout clobbers the on-disk edit");

    // restoreSnapshotSafely writes the bytes back.
    for (const [p, bytes] of snapshot) await writeFile(join(dir, p), bytes);
    const restored = await readFile(join(dir, "keep.md"), "utf8");
    ok(restored.includes("UNCOMMITTED USER EDIT"), "snapshot restores the deselected edit after merge");
  });
}

// --- 4. NFC path normalization (the H4 guarantee) ---------------------------
// iOS hands back NFD filenames; git stores bytes as given. Without NFC
// normalization the same name looks like two different paths across platforms.
async function testNfc() {
  section("Path normalization — NFD and NFC names collapse to one path");
  const nfd = "й".normalize("NFD"); // й decomposed: и + combining breve
  const nfc = "й".normalize("NFC");
  ok(nfd !== nfc, "precondition: NFD and NFC bytes differ for 'й'");
  ok(nfd.normalize("NFC") === nfc, "NFC normalization makes NFD == NFC");

  await withRepo(async (dir) => {
    const nameNfc = "мой файл.md".normalize("NFC");
    await writeFile(join(dir, nameNfc), "content\n");
    await git.add({ fs, dir, filepath: nameNfc });
    await git.commit({ fs, dir, message: "add", author });

    // Simulate iOS reporting the on-disk name in NFD: a status pass that
    // normalizes every path to NFC (what GitFs.normalize now does) must NOT
    // see a phantom delete+add.
    const matrix = await git.statusMatrix({ fs, dir });
    const normalizedPaths = matrix.map((row) => row[0].normalize("NFC"));
    const lookup = nameNfc.normalize("NFC");
    ok(normalizedPaths.includes(lookup), "committed file found under its NFC path");
    const phantom = normalizedPaths.filter((p) => p === lookup).length;
    ok(phantom === 1, "exactly one entry — no phantom NFD duplicate");
  });
}

// --- 5. Branch-name validation (mirrors settings.ts isValidBranchName) ------
function isValidBranchName(name) {
  if (!name || name !== name.trim()) return false;
  if (/[\s~^:?*\[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.endsWith(".lock")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

function testBranchValidation() {
  section("Branch-name validation — accepts valid refs, rejects bad ones");
  for (const good of ["main", "feature/foo", "release-1.2", "dev_branch.2", "user/fix-bug"]) {
    ok(isValidBranchName(good), `accepts "${good}"`);
  }
  for (const bad of ["has space", "a..b", "~tilde", "feat:x", "end/", "/start", ".dot", "x.lock", "a//b", "br@{x}"]) {
    ok(!isValidBranchName(bad), `rejects "${bad}"`);
  }
}

// --- run --------------------------------------------------------------------
console.log("GitSync git-semantics regression suite\n(validates iso-git behaviour the plugin relies on — not the Obsidian layers)");
await testCleanMerge();
await testConflict();
await testBinaryMergeDefaultCorrupts();
await testBinaryMergeDriverSafe();
await testBinaryMergeTextStillMerges();
await testExecModePreserved();
await testSnapshotRestore();
await testNfc();
testBranchValidation();

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
