# Bug History

A running log of reported bugs, their root cause, the fix, and the tests that
guard against regression. Newest first. Each entry links back to the source
report (GitHub issue) where one exists.

Status legend: 🟢 fixed · 🟡 in progress · 🔴 open

---

## BUG-006 — CRLF/LF: hundreds of phantom "modified" files on Windows

- **Status:** 🟢 fixed in **0.2.21** *(status/staging logic covered offline; the real Windows checkout needs a live check)*
- **Reported:** issue [#32](https://github.com/heeeyMan/ObsSync/issues/32) (`wzhulifantastic`), Windows 11, 0.2.16
- **Severity:** high — ~650 false "changes" on a clean tree; risks users committing/discarding en masse
- **Engine:** git (isomorphic-git, desktop)

### Symptoms

Git Vault Sync showed ~650 pending changes while Git-for-Windows CLI reported a
completely clean tree (`git status --porcelain` → 0), with local `HEAD` == `origin/main`.
Every affected file differed **only** by CRLF vs LF; no content differences. Often
triggered right after an external `git reset --hard` / `checkout` / fresh clone with
the system default `core.autocrlf=true`.

### Root cause

`core.autocrlf=true` makes Git-for-Windows check LF-committed text files out with
CRLF, then compare working files to the index **through its clean filter**
(`clean(working) == blob`), so it sees no change. isomorphic-git (the plugin's
desktop engine) has no autocrlf/`.gitattributes` support and compares **raw
bytes** — a CRLF working file over an LF blob hashes differently, so every text
file looks modified.

### Fix

Change detection now treats a tracked file that differs from its HEAD blob **only**
by CRLF↔LF as unchanged, in `countChanges`, `listChanges`, and `stageAll`
(`isLineEndingOnlyChange` in `git.ts`): it CRLF→LF-normalizes the working bytes
(`normalizeCrlf`, byte-level) and compares to the HEAD blob; equal ⇒ not a change.
So the plugin never reports, stages, or commits a pure line-ending flip — it agrees
with the Git CLI. Properties:

- **Safe cross-platform:** an LF file has no CRLF to strip, so it's a no-op off
  Windows; the working file is **never** rewritten; only tracked
  content-modified files (`head===1 && workdir===2`) are checked; adds/deletes and
  binaries are always real changes.
- **Cheap on the status timer:** results are cached per path, invalidated on
  mtime/size/HEAD change, so the whole vault isn't re-hashed every tick.
- One-directional by design (normalizes the working side only), matching git's
  "repo stores LF" model. A file *committed* with CRLF that's now LF still shows
  as a change (correct — never hides a real diff).

Note: an intentional pure line-ending change can no longer be committed via the
plugin (same as git-with-autocrlf). The reporter's other asks — a Git-for-Windows
CLI backend, and hard OS-level `.git/index` locking against a concurrently-running
external git — are larger and tracked separately; the plugin already recovers from
a corrupt/foreign index via `withIndexRecovery`.

### Tests

`scripts/repro-issue-32.mjs` drives the real engine: a CRLF working file over an LF
blob is not counted/listed/staged; a genuinely edited (CRLF) file and a changed
binary still are; and a commit of real edits leaves the CRLF-only file's HEAD blob
LF (no CRLF written). Wired into `npm test`. **Live checklist:** on Windows with
`core.autocrlf=true`, a freshly `reset --hard` vault should show 0 changes in the
plugin (TESTING.md).

---

## BUG-005 — Obsidian crashes mid-sync on Android (WebView OOM)

- **Status:** 🟡 likely fixed in **0.2.20** — needs confirmation on the affected device
- **Reported:** issue [#33](https://github.com/heeeyMan/ObsSync/issues/33) (`sH1222J`)
- **Severity:** high — hard crash, sync never completes
- **Engine:** API (GitHub Git Data API — the mobile default)

### Symptoms

On a **Lenovo Legion Y700 (Android 15 / ZUI)**, pressing Sync runs for ~5–10 s
then Obsidian crashes and closes. The **same repo + vault sync fine on Windows and
iPhone 17** — so it's device/WebView-specific, not a repo problem.

### Root cause (strong hypothesis — device not reproducible here)

A hard crash that's device-specific after a few seconds of work is the classic
signature of the **Android WebView (Chromium) renderer hitting its heap cap** —
which is a fixed per-process limit independent of the device's RAM, and lower /
more aggressively enforced on some ROMs (ZUI) than on iOS WKWebView.

The API engine's **pull path amplified peak memory per blob**. `getBlob` fetched
the default JSON form, where the content is base64. For a single large attachment
that meant holding, at once: the ~1.33× base64 string, a whitespace-stripped copy
of it (`.replace`), and the `atob` binary string — **~5× the file size** on top of
the decoded bytes. A few large images in a row could spike past the WebView cap and
crash the app.

### Fix

`getBlob` now requests the **`application/vnd.github.raw`** media type and reads
the response's `arrayBuffer` directly — no base64, no JSON parse, no intermediate
copies, so peak memory per pulled blob drops from ~5× to **~1×** the file size. If
a proxy ignores the raw type and answers with JSON, it falls back to the base64
decode (correctness preserved). Verified against the live GitHub API: raw returns
`content-type: text/plain`/`octet-stream` with the bytes as the body; JSON returns
`application/json` with base64.

### Tests / status

Build clean; 76 offline assertions pass. The raw media-type behavior was confirmed
with `curl` against a public repo. The device crash itself can't be reproduced
here — **awaiting the reporter's confirmation** (and an `adb logcat` if it
persists, to see whether the remaining pressure is on the push/base64 or the
local-scan path).

---

## BUG-004 — Large push fails silently; the real error was unreadable

- **Status:** 🟢 fixed in **0.2.19**
- **Reported:** user testing (desktop) — a sync "error" with no visible detail
- **Severity:** high — sync half-completes (commits locally, never pushes) with a
  generic/opaque message
- **Engine:** git (isomorphic-git, desktop)

### Symptoms

A sync committed locally but the **push failed**, leaving the branch ahead of
`origin`. The Notice showed only a generic message ("check your connection"), so
the real reason wasn't visible.

### Root cause

Two separate problems:

1. **Oversized push body.** `shouldChunkPush` chunked large pushes on mobile only
   (`if (!this.shallow) return false`). On desktop a single sync of ~30 MB (here,
   62 restored attachments) built one packfile and POSTed it through Obsidian's
   `requestUrl` in one shot, which fails for a large body — so the push errored
   while the local commit stood.
2. **The real error was hidden.** `friendlyError` mapped the low-level failure to
   a generic localized string and **discarded the original**, so neither the
   Notice nor any log showed the true cause.

> Note: the earlier "images broke on PC" report that led here was **not** a code
> bug in 0.2.18 — the vault ran a stale **0.2.16 copy** of the plugin (not the
> symlink), i.e. pre-BUG-002 code. Verified via `scripts/repro-bug-002-e2e.mjs`
> (full merge→repair→completeMerge preserves binaries). The vault was updated to
> the fixed build and the corrupted attachments were restored from git history.

### Fix

- **Desktop chunked push.** Removed the desktop guard in `shouldChunkPush`, so a
  changeset over `PUSH_CHUNK_THRESHOLD` (8 MB) is split into size-bounded commits
  on **both** platforms — every push body stays small. Small syncs are unchanged.
- **Preserve the raw error.** `friendlyError` now attaches the original error as
  `.cause` (the two `errPushRejected` throws too), so the true reason survives.
- **Error viewer.** A "Show last sync error" command + a status-bar menu item open
  a copyable dialog (`error-modal.ts`) showing the message, timestamp, and the
  full `cause` chain + stack (`describeError`). The plugin records the last
  failure in `lastError`.

### Tests

Build clean; 66 offline assertions still pass. The desktop >8 MB push path and the
modal are UI/network layers — **live checklist:** stage >8 MB of attachments on
desktop, confirm multiple size-bounded commits push successfully; trigger any
sync error and confirm the viewer shows the underlying cause.

---

## BUG-001 — Binary files (PNG/JPG/PDF) corrupted during pull/merge

- **Status:** 🟢 fixed in **0.2.15**
- **Reported:** issue [#31](https://github.com/heeeyMan/ObsSync/issues/31) (`wzhulifantastic`), first release affected `v0.2.14`
- **Severity:** critical — silent data corruption across devices
- **Engine:** git (isomorphic-git, desktop) — primary; API (mobile) — secondary write-back path

### Symptoms

- After a pull/merge/conflict-resolution, PNG attachments became unreadable while
  keeping their original filenames.
- Signature changed from a valid `89 50 4E 47 0D 0A 1A 0A` to a corrupted
  `EF BF BD 50 4E 47 0D 0A`.
- Files grew (~195 KB → ~353 KB, roughly 1.8×).
- The copy on GitHub stayed valid; restoring from GitHub fixed the file only until
  the next sync re-corrupted it.
- Reproduced with **auto-sync and sync-on-startup both disabled** — only the plugin
  being enabled was enough.
- Only *some* attachments were hit (the ones changed on both sides).

### Root cause

`EF BF BD` is the UTF-8 encoding of U+FFFD, the Unicode replacement character —
the tell-tale of a lossy `bytes → UTF-8 string → bytes` round-trip.

- **Git engine:** `git.merge` ran with **no custom merge driver**. isomorphic-git's
  default driver decodes every blob changed on *both* sides with
  `Buffer.from(blob).toString("utf8")`, merges the strings, then re-encodes. Every
  non-UTF-8 byte (like a PNG's `0x89`) is replaced with U+FFFD → `EF BF BD`, which
  also inflates size. Blobs changed on only *one* side are taken by object id and
  stay intact — which is exactly why only some attachments were corrupted.
- **API engine (mobile):** classified write-back content as text/binary with a
  **NUL-only scan**. A binary file with no `0x00` bytes was misclassified as text
  and written through the decoding path.

### Fix

- **Binary-safe merge driver** in `git.ts`: if either side of a both-sides change
  looks binary, the driver raises a **conflict** instead of merging. Resolution
  picks a whole side and writes the **original blob bytes verbatim** — never a
  decoded string. Text still merges via the exact `diff3` implementation
  isomorphic-git bundles, so ordinary note merges are unchanged.
- **API engine:** write-back is now classified with a **strict UTF-8 decode**
  (replaces the NUL-only scan, which missed NUL-free binaries); anything that isn't
  valid UTF-8 is written via `writeBinary`.
- **Both conflict modals** (`conflict-modal.ts`, `api-conflict-modal.ts`) treat
  binary files as **whole-file choices** — no garbled text preview and no
  manual-edit option (manual edit could previously re-save the corrupted content).

### Tests

- Offline regression scenarios in `scripts/regression.mjs`.
- End-to-end repro `scripts/repro-issue-31.mjs` drives the real engine: the old path
  corrupts a PNG (16 B → 69 B, `EF BF BD`), the fix keeps both sides byte-for-byte
  intact with a valid `89 50 4E 47` signature.

### Related fix shipped in the same release

**Executable bit stripped on staging.** `GitFs` can't report a file's mode, so
`git.add` re-staged tracked `100755` scripts as `100644`, producing an endless
mode-flip commit ping-pong. `stageAll` now snapshots executable paths from HEAD and
re-applies `100755` to the freshly-staged blob via `updateIndex`. The API engine
carries each path's git mode from the remote tree through `createTree` so a mobile
push no longer downgrades the bit.

---

## BUG-002 — Unrelated conflicts still corrupt binary files

- **Status:** 🟢 fixed in **0.2.17**
- **Reported:** follow-up on issue [#31](https://github.com/heeeyMan/ObsSync/issues/31) (`wzhulifantastic`, after 0.2.15)
- **Severity:** critical — same silent binary corruption as BUG-001, different trigger
- **Engine:** git (isomorphic-git, desktop)

### Symptoms

> After clicking sync in the plugin options page, if there are conflicts — even when
> the conflicts being resolved are **unrelated** to binary files — the sync process
> causes **all** binary files in the vault to become corrupted, with the same sudden
> size increase as BUG-001.

### Root cause (confirmed)

The BUG-001 fix (the binary-safe merge driver) was **not enough**, because the
corruption on this path doesn't come from the driver at all.

`fetchAndMerge` runs `git.merge({ abortOnConflict: false })` so the working tree
gets the non-conflicting remote changes plus conflict markers before we resolve
interactively. But inside isomorphic-git, whenever a merge hits **any** conflict,
its `mergeTree` writes the **entire merged tree** back to the working directory
with:

```js
const content = new TextDecoder().decode(await entry.content());
await fs.write(path, content, { mode });
```

(`node_modules/isomorphic-git/index.js`, the `unmergedFiles.length !== 0 && !abortOnConflict`
branch). That non-fatal `TextDecoder().decode()` runs over **every blob in the tree**
— not just the conflicted file — so each binary's invalid bytes become U+FFFD
(`EF BF BD`) and the file inflates. The merge driver never sees this write-back; it
only governs how both-sides-modified blobs are combined. `completeMerge` then
`stageAll`s the (now corrupted) working tree and commits it.

That's why a single **text** conflict corrupts every **binary** in the vault, and
why BUG-001's driver fix didn't cover it: BUG-001's repro merged a binary changed
on both sides (driver path); this bug's binaries are unchanged or one-sided
(write-back path).

### Fix

New `repairConflictBinaries` pass in `git.ts`, invoked in `mergeRemote` right after
a `MergeConflict` is detected and before it's thrown to the resolver. It re-derives
each **non-conflicted** path's true merged blob via a 3-way walk over
ours/base/theirs (merge base from `findMergeBase`) and rewrites the binary ones
verbatim with `writeBinary`:

- unchanged or identical on both sides → that blob;
- changed on only one side → that side's blob (one-sided edits are preserved);
- both-sides-different → already a conflict, skipped (`completeMerge` writes the
  chosen side's original bytes by oid).

Text files are skipped — a UTF-8 round-trip of real text is lossless, and they may
carry the conflict markers the resolver needs. The pass runs only on the
interactive conflict path, never on the hot sync path.

### Tests

- `scripts/repro-bug-002.mjs` drives the real engine: a text conflict with an
  untouched PNG and a remote-only-edited PNG. **Control** proves both binaries are
  corrupted by the merge write-back (16 B → 24 B, U+FFFD); **fix** proves
  `repairConflictBinaries` restores both byte-for-byte (untouched → original bytes,
  remote-only → the remote bytes) while the text conflict markers stay intact.
- Wired into `npm test` alongside the BUG-001 repro and the regression suite.

---

## BUG-003 — Unresolved conflicts freeze Obsidian (black screen)

- **Status:** 🟢 fixed in **0.2.18** *(UI-layer fix — needs live confirmation in a vault)*
- **Reported:** follow-up on issue [#31](https://github.com/heeeyMan/ObsSync/issues/31) (`wzhulifantastic`, after 0.2.15)
- **Severity:** high — UI hang / apparent crash, and a half-completed sync
- **Engine:** git (isomorphic-git, desktop)

### Symptoms

> When unresolved conflicts exist, clicking **Review Changes & Sync** (bottom-right)
> freezes the sync and the entire Obsidian interface fails to render — a black
> screen, though the process is **not** reported as "not responding" in task manager.
> The sync **commits locally** but does **not** push and does **not** surface the
> conflicts on GitHub.

### Root cause

Not a hang and not a lost conflict — the engine behaves correctly: `sync()`
commits locally, then `git.merge` throws `MergeConflict`, which `sync()`'s catch
routes to `openConflictModal`. The failure is purely in the **UI layer**.

"Review changes & sync" opens the **ReviewModal**; its Sync button called
`this.close()` and then, **synchronously**, kicked off `sync()`. When that sync
hits a conflict it opens the **ConflictModal** — but the ReviewModal was still
tearing down (its `.modal-bg` backdrop fades out over ~200 ms). Opening a second
modal *while the first is mid-close* makes Obsidian mismanage the shared modal
backdrop/scope: one backdrop is left stranded over the whole workspace — an
opaque, un-dismissable overlay that reads as a "black screen" while the app stays
responsive (hence "not 'not responding'"). The local commit is real; the push
never happens because the merge genuinely conflicted; and the ConflictModal is
there but buried under the stuck backdrop, so it "never shows".

Confirmed by contrast with BUG-002, where a conflict raised from the settings-tab
"Sync now" button opened the ConflictModal fine (no just-closed modal in the way).
The distinguishing factor for BUG-003 is the freshly-closing ReviewModal.

### Fix

Never open the ConflictModal while another GitSync modal is on screen or mid-close:

- **`main.ts` `openConflictModal`** now closes the settings tab (in case the sync
  came from "Sync now") and **defers** the actual open by ~200 ms — past Obsidian's
  modal fade — via `presentConflictModal`. The conflict is **parked**
  (`pendingConflict`) until it's on screen, so it's never lost and stays resolvable
  from the status bar; the deferred timer is cancelled in `onunload`.
- **`review-modal.ts`** defers its `onSync` call (`activeWindow.setTimeout(…, 0)`)
  so the sync — and any resulting ConflictModal — starts only after the ReviewModal
  has fully torn down.
- **`conflict-modal.ts`** wraps its render phase in try/catch: any unexpected
  render failure now closes the modal and shows a Notice instead of stranding a
  half-built modal with its backdrop up.

### Tests

UI/modal behavior can't be exercised by the offline Node suite (it needs a live
Obsidian modal + backdrop). Build is clean and the engine-level suites still pass
(66 assertions). **Live checklist:** with a divergent local+remote, use the ribbon
"Review changes & sync", deselect nothing, and confirm the ConflictModal appears
(no black screen); repeat from the settings-tab "Sync now"; resolve and confirm the
push completes. Tracked in TESTING.md.

---
