# Issue #33: diagnostic build and chunked-download experiment

## Integrated candidate: 0.2.27-issue33.2 (2026-10-28)

The standalone prototype below describes `.1`. Candidate `.2` integrates the
range downloader into **ordinary API Sync**, for remote files above 1 MiB.
This is a transport threshold, not a file-size cap: larger files are still
synchronized. Small files retain the existing path, including Vault notifications
for open notes. The Git/isomorphic-git engine is unchanged.

- Download to an excluded temporary file at a fixed remote commit.
- Verify both incoming bytes and the assembled on-disk file using Git SHA-1.
- Check the local file still matches the scan before replacing it.
- Retain the original in `diagnostics/transfer/previous.bin` during replacement.
  A persisted transaction permits recovery before the next scan. If both copies
  exist and the target differs from the downloaded version, stop and preserve
  both rather than guess which one to discard. Git-engine sync is blocked while
  such a transaction is pending, to avoid committing the temporary absence.
- Hash large local files through a streamed local resource response instead of
  `readBinary`. No whole-file fallback if local streaming is unavailable.
- Keep the original baseline on a failed sync; already verified downloads can
  be recognized on retry. Failed downloads do not replace the previous file.

Minimum Obsidian version is now **1.12.3**, where the public API marks
`appendBinary` as introduced. The reporter's Obsidian 1.14.4 meets this requirement.

**What is verified:** Node integration tests perform a full API pull of a
64,931,472-byte attachment and a small note, then a repeat Sync with no download
or push. Large full-file reads are forbidden by the adapter mock. Failure tests
cover network errors, ignored ranges, corrupt responses, disk full, same-size
corrupt disk writes, concurrent local edits, failed promotion, and simulated
process death before/after replacement. Existing sync/conflict regression tests
also pass.

**What remains device-only:** local resource streaming (including excluded temp
files), native rename behavior, file watcher/editor refresh for large files, and
memory use during full-vault sync. `.1`'s Android success confirms range transfer
and append for that run, not these additional paths. Local resource responses
may be buffered differently on other hosts. Uploads and conflict-resolution UI
still use the previous whole-file paths; this candidate targets initial pull and
unchanged repeat sync, not a claim that every sync operation is now memory-bounded.

### BRAT test sequence for .2

1. Keep automatic sync and sync on startup off. In BRAT edit `heeeyMan/ObsSync`
   and select the specific/frozen version `0.2.27-issue33.2`, then reload the plugin.
2. Select the GitHub API sync engine (Auto selects it on mobile).
3. Enable sync diagnostics using the command; confirm the enabled notice.
4. When asked to test this candidate, run ordinary Sync in the foreground. Save
   the report whether it succeeds, errors or crashes. After a crash, collect the
   report before retrying. A `scan-stream`/`pull-verify-disk` failure may indicate
   the newly introduced local-resource read path needs work on this device.
5. After a successful initial pull, verify several notes and the large attachment,
   then run a second unchanged Sync and collect that report separately.
6. Do not send `data.json` or the `transfer` directory; send only the diagnostic
   viewer report or the bounded journal files described below. A transaction file
   includes a local path and `previous.bin`/`pull.part` contain vault contents.
7. Disable diagnostics after testing. Do not downgrade to `.1`/stable while a
   file-recovery error is outstanding; keep both copies and report the failure.

`node scripts/repro-issue-33-sync.mjs` is included in `npm test`.

## Standalone prototype: 0.2.27-issue33.1

This is a prototype, not a replacement sync engine. It adds no file-size cap and
never silently skips files. Normal sync still uses the existing transport.

## Verified on 2026-10-27

Live read-only probes of `heeeyMan/ObsSync`, commit
`c35c4d0fe77c4c0718307c4f076405ea2e943617`, README.md (8121 bytes):

| Request | Observed result |
| --- | --- |
| Git Blobs API, raw media type, Range 0–1023 | 200, entire 8121-byte file; Range ignored |
| Raw immutable URL, Range 0–1023, Authorization header | 206, 1024 bytes, matching Content-Range |
| Same Raw URL, Range 1024–2047, Authorization header | 206, 1024 bytes, matching Content-Range |
| Raw OPTIONS, browser origin, authorization + range headers | 403; no Access-Control-Allow-Headers |

Repeat with `node scripts/probe-github-ranges.mjs --auth`. This uses the existing
`gh` login in memory and prints selected metadata only. Without `--auth`, it
probes anonymous access. Authentication against a public file does **not** prove
access to private repositories; run the in-app command with the intended private
repository/token to verify that combination. No private repository was tested.

The installed public Obsidian types expose `requestUrl` with a complete
`ArrayBuffer`, not a response stream, and `DataAdapter.appendBinary` for appending
bytes. The prototype uses both: one 1 MiB HTTP range at a time, sequential writes.
This bounds the response size only when the server honors Range. If a proxy or
server returns 200, the prototype rejects it, but `requestUrl` may already have
buffered the full response. There is no automatic full-file fallback.

A Node test passes 64,931,472 bytes (the issue's reported file size) through the
actual downloader with mocked HTTP and a disk-backed adapter: 62 requests,
maximum append 1 MiB, independently verified Git SHA-1 of the assembled file.
It also covers ignored/incorrect ranges, short responses, unauthorized requests,
wrong hash, network/write failures, empty files, existing destination protection,
and journal recovery after a torn write. This does not measure Android memory.

`adb devices -l` reported no attached devices. Native Android `requestUrl`, Range
header forwarding, `appendBinary` implementation/memory usage, and Lenovo Y700
stability remain **unverified**. API availability alone does not prove bounded
native memory consumption.

## Run inside Obsidian on Android

Install this build's `main.js` with the existing manifest/styles, then reload the
plugin. Keep Obsidian in the foreground for the experiment.

1. Use the existing GitHub repository, branch and token settings.
2. In the command palette run **Test chunked download of largest remote file**
   (Russian: **Проверить загрузку крупнейшего файла частями**).
3. The command selects the largest regular file from the remote tree at a fixed
   commit. It downloads into the plugin's excluded `diagnostics/download.part`,
   verifies the received Git blob hash and on-disk size, then deletes the copy.
   It does not write notes, push commits, or update the sync baseline.
4. Run **Show sync diagnostics** and copy the report. If Obsidian crashes, restart
   and open the report: the interrupted run is retained separately from new logs.
5. To diagnose the original sync path, run **Enable / disable sync diagnostics**
   once (watch the enabled notice), then run ordinary Sync with the API engine.
   Disable diagnostics afterward using the same command.

The journal records UTC timestamps, operation stages, sizes, byte offsets, HTTP
status and opaque file identifiers. It does not record file paths, content, URLs,
authorization headers, tokens or raw error messages. Identifiers are Git blob
hashes, or a hash of the path during scanning; these are not guaranteed anonymous.
The report also includes current plugin version, mobile flag and user agent.
Detailed scan/pull/push stages are currently only instrumented for the API engine.

Two rotating journal snapshots keep the last 80 events. An interrupted-run copy
survives subsequent startup sync. Files live under
`<configDir>/plugins/git-vault-sync/diagnostics/` and are excluded by both engines.
A crashed experiment's partial file is removed on the next experiment. A normal
completion or caught failure removes it immediately. This prototype does not
resume partially downloaded data. Native requests cannot be cancelled through
this API; do not reload the plugin while a test request is still running.

## Interpretation and next experiment

- `pull-download` without `pull-write`: failure while fetching/decoding the blob.
- `pull-write` without `pull-done`: failure during the existing full-file write.
- `scan-read` / `scan-hash`: failure during local reading/hashing.
- `chunk-request`: native HTTP call had not returned when execution stopped.
- `chunk-append`: native file append had not completed.
- `chunk-complete`: incoming SHA-1 and final disk size matched. The experiment
  does not re-read the full stored file on Android to verify its hash, since that
  would recreate the original large allocation. Node tests verify disk contents.
- An unfinished stage establishes where execution stopped, not whether the cause
  was OOM, an app shutdown, an OS kill, or another native failure.

On Y700, compare the original and chunked paths on the same 61.9 MiB attachment,
repeat three times, and record Obsidian/WebView versions and timings. When ADB is
available, capture logcat and process memory externally during the run. Test a
private repository as well as public access, and airplane mode during transfer.
Only then decide whether to integrate this transport into normal sync.

GitHub itself documents a 100 MB limit for its Git Blobs API; this prototype adds
no lower limit and does not implement Git LFS. These are distinct from the
Android crash and from a plugin setting that skips large files.

References:
- https://docs.github.com/en/rest/git/blobs
- https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- https://github.com/heeeyMan/ObsSync/issues/33#issuecomment-6443659565

## Test candidate 0.2.27-issue33.3

Diagnostics are mandatory only for this exact prerelease version, including
existing installations with diagnostics disabled. The stable build remains opt-in.
The diagnostic viewer includes a live activity snapshot at the moment it is opened
(syncing flag, current stage, total elapsed time, seconds since last event).
Reopen the viewer to refresh it. Every 5 seconds the progress notice updates elapsed
and last-event time; the timer is not evidence of byte progress. UI ticks are not
written to the bounded journal, so a hung operation cannot evict its last events.

Conflict tracing covers content loading, waiting for a choice, submitting choices,
local writes, fetching head/tree, uploading blobs, creating tree/commit, updating
the branch, and saving the baseline. No conflict content or paths are recorded.
Conflict loading/commit failures now reach the outer Sync error handler rather
than being reported as a successful return. The conflict algorithm is unchanged.

For the reporter: preserve current vault/settings and back up local-only notes,
update the frozen BRAT version to .3, leave auto/startup sync off, and run ordinary
Sync once. Review conflict choices explicitly. If the same step remains for several
minutes, collect diagnostics while it is still pending, before restarting. A
crash report should be collected immediately after reopening, before another Sync.
Do not share data.json or diagnostics/transfer. Native Android validation remains
pending; this build diagnoses the reported stall, not a confirmed fix for it.
