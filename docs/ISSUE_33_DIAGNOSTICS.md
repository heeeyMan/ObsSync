# Issue #33: diagnostic build and chunked-download experiment

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
