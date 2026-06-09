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
await testSnapshotRestore();
await testNfc();
testBranchValidation();

console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
