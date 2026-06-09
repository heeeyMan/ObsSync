import { requestUrl, DataAdapter } from "obsidian";
import { t } from "./i18n";

/**
 * Stage 1 of the new sync engine: a read-only "dry-run pull" over the GitHub
 * Git Data API. It walks a branch's tree and streams every blob *one at a time*
 * to validate memory behaviour on a large repo WITHOUT writing anything into
 * the vault (non-destructive).
 *
 * This file is intentionally independent of the isomorphic-git engine
 * (`git.ts`/`git-fs.ts`/`git-http.ts`). Like {@link ./github-api.ts}, all HTTP
 * goes through Obsidian's {@link requestUrl}: a plain `fetch` is blocked by CORS
 * inside Obsidian, whereas `requestUrl` is proxied through the native layer and
 * works identically (and CORS-free) on desktop and mobile.
 *
 * The token is used only as an `Authorization` header — it is never logged.
 */

/**
 * `requestUrl` has no timeout, so a stalled request on a dropped mobile
 * connection never settles. Mirror github-api.ts / git-http.ts: cap each
 * request with a Promise.race; on expiry surface the network error.
 */
const REQUEST_TIMEOUT_MS = 60_000;

const API_BASE = "https://api.github.com";

/** Emit a progress message every N processed blobs. */
const PROGRESS_EVERY = 25;

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		// GitHub's API rejects requests without a User-Agent with HTTP 403.
		"User-Agent": "obsidian-gitsync",
	};
}

/**
 * GET against the GitHub API with a timeout and status handling.
 * Returns the parsed JSON body; throws a localized error on auth/rate-limit
 * failures (401/403 → errBadToken) and on network/timeout failures
 * (→ errNetwork). 404 maps to errNotFound so a missing branch/repo is clear.
 */
async function apiGet(url: string, token: string): Promise<unknown> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => {
			reject(new Error(`ERR_TIMEOUT: request timed out after ${REQUEST_TIMEOUT_MS}ms`));
		}, REQUEST_TIMEOUT_MS);
	});

	let res;
	try {
		res = await Promise.race([
			requestUrl({
				url,
				method: "GET",
				headers: headers(token),
				throw: false,
			}),
			timeout,
		]);
	} catch {
		// Timeout or a thrown transport failure — surface as a network error.
		throw new Error(t("errNetwork"));
	} finally {
		if (timer) window.clearTimeout(timer);
	}

	// status 0 means the request never reached the server (offline, DNS, etc.).
	if (!res.status) {
		throw new Error(t("errNetwork"));
	}
	if (res.status === 401 || res.status === 403) {
		throw new Error(t("errBadToken"));
	}
	if (res.status === 404) {
		throw new Error(t("errNotFound"));
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(t("errNetwork"));
	}

	return res.json;
}

/**
 * POST/PATCH against the GitHub API with the same timeout and status handling
 * as {@link apiGet}. Sends `body` as JSON and returns the parsed JSON response.
 * 401/403 → errBadToken, 404 → errNotFound, network/timeout → errNetwork; any
 * other non-2xx is surfaced as a network error. The token is only ever sent as
 * an Authorization header — never logged.
 */
async function apiWrite(
	url: string,
	method: "POST" | "PATCH",
	body: unknown,
	token: string,
): Promise<unknown> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => {
			reject(new Error(`ERR_TIMEOUT: request timed out after ${REQUEST_TIMEOUT_MS}ms`));
		}, REQUEST_TIMEOUT_MS);
	});

	let res;
	try {
		res = await Promise.race([
			requestUrl({
				url,
				method,
				headers: { ...headers(token), "Content-Type": "application/json" },
				body: JSON.stringify(body),
				throw: false,
			}),
			timeout,
		]);
	} catch {
		throw new Error(t("errNetwork"));
	} finally {
		if (timer) window.clearTimeout(timer);
	}

	if (!res.status) {
		throw new Error(t("errNetwork"));
	}
	if (res.status === 401 || res.status === 403) {
		throw new Error(t("errBadToken"));
	}
	if (res.status === 404) {
		throw new Error(t("errNotFound"));
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(t("errNetwork"));
	}

	return res.json;
}

/**
 * Resolve a branch tip to its commit SHA and root tree SHA.
 *
 * 1. GET /repos/{owner}/{repo}/git/ref/heads/{branch} → object.sha (commit).
 * 2. GET /repos/{owner}/{repo}/git/commits/{commitSha} → tree.sha.
 *
 * A missing branch returns 404, which {@link apiGet} maps to `errNotFound`.
 */
export async function getBranchHead(
	owner: string,
	repo: string,
	branch: string,
	token: string,
): Promise<{ commitSha: string; treeSha: string }> {
	const ref = (await apiGet(
		`${API_BASE}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
		token,
	)) as { object?: { sha?: unknown } };

	const commitSha = ref?.object && typeof ref.object.sha === "string" ? ref.object.sha : "";
	if (!commitSha) {
		throw new Error(t("errNotFound"));
	}

	const commit = (await apiGet(
		`${API_BASE}/repos/${owner}/${repo}/git/commits/${commitSha}`,
		token,
	)) as { tree?: { sha?: unknown } };

	const treeSha = commit?.tree && typeof commit.tree.sha === "string" ? commit.tree.sha : "";
	if (!treeSha) {
		throw new Error(t("errNotFound"));
	}

	return { commitSha, treeSha };
}

export interface TreeBlobEntry {
	path: string;
	sha: string;
	size: number;
}

/**
 * GET /repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1 — the full recursive
 * tree. Returns only blob entries (files); subtree (`tree`) and submodule
 * (`commit`) entries are dropped. `truncated` is GitHub's flag for when the tree
 * exceeded the server's response limit (not expected for a ~372-file repo, but
 * surfaced so the caller can warn instead of silently pulling a partial list).
 */
export async function getTree(
	owner: string,
	repo: string,
	treeSha: string,
	token: string,
): Promise<{ entries: TreeBlobEntry[]; truncated: boolean }> {
	const data = (await apiGet(
		`${API_BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
		token,
	)) as { tree?: unknown; truncated?: unknown };

	const truncated = data.truncated === true;
	const entries: TreeBlobEntry[] = [];

	if (Array.isArray(data.tree)) {
		for (const e of data.tree) {
			const rec = e as { type?: unknown; path?: unknown; sha?: unknown; size?: unknown };
			if (rec.type !== "blob") continue;
			entries.push({
				path: typeof rec.path === "string" ? rec.path : "",
				sha: typeof rec.sha === "string" ? rec.sha : "",
				size: typeof rec.size === "number" ? rec.size : 0,
			});
		}
	}

	return { entries, truncated };
}

/**
 * GET /repos/{owner}/{repo}/git/blobs/{blobSha} — a single blob. GitHub returns
 * the content base64-encoded (`encoding: "base64"`); we decode it to raw bytes.
 * Callers fetch blobs one at a time and drop the reference immediately, so peak
 * memory stays at roughly one blob.
 */
export async function getBlob(
	owner: string,
	repo: string,
	blobSha: string,
	token: string,
): Promise<Uint8Array> {
	const data = (await apiGet(
		`${API_BASE}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
		token,
	)) as { content?: unknown; encoding?: unknown };

	const encoding = typeof data.encoding === "string" ? data.encoding : "";
	const content = typeof data.content === "string" ? data.content : "";

	if (encoding !== "base64") {
		// The blobs endpoint always returns base64 for binary-safe transport.
		// Anything else means an unexpected/malformed response.
		throw new Error(t("errNetwork"));
	}

	return base64ToBytes(content);
}

/**
 * Decode base64 to a Uint8Array. GitHub wraps base64 content at 60 chars with
 * newlines, so strip whitespace first. `atob` is available in the Obsidian
 * (Electron/Capacitor) environment.
 */
function base64ToBytes(b64: string): Uint8Array {
	const clean = b64.replace(/\s+/g, "");
	const binary = atob(clean);
	const len = binary.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Encode raw bytes to base64. Mirrors {@link base64ToBytes}; `btoa` needs a
 * binary string (one char per byte), so we build it in chunks to avoid blowing
 * the argument limit of `String.fromCharCode(...)` on large blobs.
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const sub = bytes.subarray(i, i + CHUNK);
		binary += String.fromCharCode.apply(null, sub as unknown as number[]);
	}
	return btoa(binary);
}

/**
 * POST /git/blobs — upload a single blob's content (base64) and return its sha.
 * Callers push one blob at a time and drop the bytes immediately, so peak
 * memory stays at roughly one blob.
 */
export async function createBlob(
	owner: string,
	repo: string,
	token: string,
	content: Uint8Array,
): Promise<string> {
	const data = (await apiWrite(
		`${API_BASE}/repos/${owner}/${repo}/git/blobs`,
		"POST",
		{ content: bytesToBase64(content), encoding: "base64" },
		token,
	)) as { sha?: unknown };
	const sha = typeof data.sha === "string" ? data.sha : "";
	if (!sha) throw new Error(t("errNetwork"));
	return sha;
}

/** A single entry for {@link createTree}. `sha: null` deletes the path. */
export interface TreeEntryInput {
	path: string;
	sha: string | null;
	mode?: string;
}

/**
 * POST /git/trees — build a new tree on top of `baseTreeSha`. Each entry is a
 * blob: `{ path, mode: "100644", type: "blob", sha }` to add/modify, or
 * `{ path, mode: "100644", type: "blob", sha: null }` to delete the path from
 * the base tree. Returns the new tree sha.
 */
export async function createTree(
	owner: string,
	repo: string,
	token: string,
	baseTreeSha: string,
	entries: TreeEntryInput[],
): Promise<string> {
	const tree = entries.map((e) => ({
		path: e.path,
		mode: e.mode ?? "100644",
		type: "blob",
		sha: e.sha,
	}));
	const data = (await apiWrite(
		`${API_BASE}/repos/${owner}/${repo}/git/trees`,
		"POST",
		{ base_tree: baseTreeSha, tree },
		token,
	)) as { sha?: unknown };
	const sha = typeof data.sha === "string" ? data.sha : "";
	if (!sha) throw new Error(t("errNetwork"));
	return sha;
}

/**
 * POST /git/commits — create a commit pointing at `treeSha` with a single
 * parent `parentSha`. Returns the new commit sha.
 */
export async function createCommit(
	owner: string,
	repo: string,
	token: string,
	message: string,
	treeSha: string,
	parentSha: string,
): Promise<string> {
	const data = (await apiWrite(
		`${API_BASE}/repos/${owner}/${repo}/git/commits`,
		"POST",
		{ message, tree: treeSha, parents: [parentSha] },
		token,
	)) as { sha?: unknown };
	const sha = typeof data.sha === "string" ? data.sha : "";
	if (!sha) throw new Error(t("errNetwork"));
	return sha;
}

/**
 * PATCH /git/refs/heads/{branch} — move the branch ref to `commitSha`. With
 * `force=false` GitHub rejects a non-fast-forward update (422), which surfaces
 * as a network error so the caller re-syncs. Set `force=true` only when the
 * caller knows the new commit descends from the remote tip it just read.
 */
export async function updateRef(
	owner: string,
	repo: string,
	token: string,
	branch: string,
	commitSha: string,
	force = false,
): Promise<void> {
	await apiWrite(
		`${API_BASE}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
		"PATCH",
		{ sha: commitSha, force },
		token,
	);
}

/**
 * Compute a Git blob object id: SHA-1 of the bytes
 * `"blob " + <byteLength> + "\0"` followed by the content. This matches
 * `git hash-object` and the `sha` GitHub reports in a tree, so it lets us
 * compare a local file against a remote blob without a network round-trip.
 *
 * Uses Web Crypto (`crypto.subtle.digest("SHA-1", …)`), available in Obsidian.
 */
export async function gitBlobSha(content: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${content.length}\0`);
	const payload = new Uint8Array(header.length + content.length);
	payload.set(header, 0);
	payload.set(content, header.length);

	const digest = await crypto.subtle.digest("SHA-1", payload);
	return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

/**
 * Parse `owner`/`repo` out of an HTTPS GitHub remote URL, e.g.
 * `https://github.com/owner/repo.git` → `{ owner, repo }`. Returns null if the
 * URL isn't a recognizable github.com HTTPS repo URL. (Convenience for the UI;
 * `dryRunPull` itself takes pre-parsed owner/repo.)
 */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
	const m = remoteUrl
		.trim()
		.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
	if (!m) return null;
	const owner = m[1];
	const repo = m[2];
	if (!owner || !repo) return null;
	return { owner, repo };
}

export interface DryRunPullStats {
	blobs: number;
	totalBytes: number;
	maxBlobBytes: number;
	truncated: boolean;
}

/**
 * Read-only "dry-run pull": resolve the branch head, fetch its recursive tree,
 * then stream every blob ONE AT A TIME. Nothing is written to the vault.
 *
 * Memory: only one blob is held at a time. Each iteration fetches the blob,
 * reads its length, optionally verifies its git blob sha, then drops the
 * reference (set to undefined) so the bytes are eligible for GC before the next
 * fetch. We accumulate only numbers (count / totalBytes / maxBlobBytes), never
 * the contents, so peak memory ≈ one blob regardless of repo size.
 */
export async function dryRunPull(opts: {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	onProgress?: (msg: string) => void;
}): Promise<DryRunPullStats> {
	const { owner, repo, branch, token, onProgress } = opts;

	onProgress?.(t("progFetching"));
	const { treeSha } = await getBranchHead(owner, repo, branch, token);

	const { entries, truncated } = await getTree(owner, repo, treeSha, token);
	const total = entries.length;

	let blobs = 0;
	let totalBytes = 0;
	let maxBlobBytes = 0;

	for (const entry of entries) {
		// Fetch one blob; verify its identity against the tree's sha.
		let content: Uint8Array | undefined = await getBlob(owner, repo, entry.sha, token);

		const computed = await gitBlobSha(content);
		if (computed !== entry.sha) {
			throw new Error(t("errNetwork"));
		}

		const len = content.length;
		blobs++;
		totalBytes += len;
		if (len > maxBlobBytes) maxBlobBytes = len;

		// Drop the reference so the bytes can be collected before the next fetch.
		content = undefined;

		if (onProgress && (blobs % PROGRESS_EVERY === 0 || blobs === total)) {
			onProgress(t("progDryRun", { n: blobs, total }));
		}
	}

	return { blobs, totalBytes, maxBlobBytes, truncated };
}

/* -------------------------------------------------------------------------- */
/* Stage 2: full API sync (pull + push) over the Git Data API.                */
/* -------------------------------------------------------------------------- */

/**
 * A snapshot of the confirmed common state after the last successful sync:
 * local == remote at that point. `commitSha` is the remote commit we were in
 * sync with; `shas` maps each (non-excluded) path to its git blob sha then.
 * Change detection diffs the current local and remote sha sets against this.
 */
export interface ApiSyncBaseline {
	commitSha: string | null;
	shas: Record<string, string>;
}

/**
 * Everything the caller needs to resolve one conflicting path interactively
 * WITHOUT the engine having to hold any content. `remoteSha`/`baseSha` let the
 * UI lazily fetch the relevant blob bytes via {@link getBlob} (the local side is
 * already on disk), while `localDeleted`/`remoteDeleted` describe the *kind* of
 * clash (modify/modify vs. delete/modify vs. modify/delete) so the UI can frame
 * the choice correctly.
 *
 * - `remoteSha`: the git blob sha on the remote, or `null` if deleted there.
 * - `baseSha`: the path's sha in the last-synced baseline, or `null` if it
 *   wasn't tracked then (added on both sides).
 * - `localDeleted` / `remoteDeleted`: whether the path was removed on that side.
 */
export interface ConflictInfo {
	path: string;
	remoteSha: string | null;
	baseSha: string | null;
	localDeleted: boolean;
	remoteDeleted: boolean;
}

export interface ApiSyncResult {
	pulled: string[];
	pushed: string[];
	deletedLocal: string[];
	deletedRemote: string[];
	conflicts: ConflictInfo[];
	committed: boolean;
	newBaseline: ApiSyncBaseline;
}

/**
 * Detect whether bytes are "binary" the same way the vault layer does: a NUL
 * byte anywhere means binary. Text is written via `adapter.write` (preserving
 * the platform's string handling); binary via `adapter.writeBinary`.
 */
function looksBinary(bytes: Uint8Array): boolean {
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

const TEXT_DECODER = new TextDecoder("utf-8");

/**
 * Recursively walk the vault via `adapter.list` (which is per-folder), yielding
 * every non-excluded file path. Reading content is left to the caller so we
 * never hold more than one file's bytes at a time. The repo's own `.git` and
 * anything `excluded` rejects is skipped (folders are pruned eagerly).
 */
async function listVaultFiles(
	adapter: DataAdapter,
	dir: string,
	excluded: (path: string) => boolean,
	out: string[],
): Promise<void> {
	const listing = await adapter.list(dir === "" ? "/" : dir);
	for (const file of listing.files) {
		const p = file.replace(/^\/+/, "");
		if (!p || excluded(p)) continue;
		out.push(p);
	}
	for (const folder of listing.folders) {
		const f = folder.replace(/^\/+/, "");
		if (!f) continue;
		// Prune excluded folders (the predicate is also given a trailing-slash
		// form so a "folder/" rule matches) and the repo's git dir.
		if (f === ".git" || excluded(f) || excluded(`${f}/`)) continue;
		await listVaultFiles(adapter, f, excluded, out);
	}
}

/**
 * Build `path -> gitBlobSha` for the whole vault, reading each file's bytes one
 * at a time and dropping them after hashing. Peak memory ≈ one file.
 */
async function scanLocalShas(
	adapter: DataAdapter,
	excluded: (path: string) => boolean,
	onProgress?: (msg: string) => void,
): Promise<Record<string, string>> {
	const paths: string[] = [];
	await listVaultFiles(adapter, "", excluded, paths);

	const shas: Record<string, string> = {};
	let i = 0;
	for (const p of paths) {
		let bytes: Uint8Array | undefined = new Uint8Array(await adapter.readBinary(p));
		shas[p] = await gitBlobSha(bytes);
		bytes = undefined;
		i++;
		if (onProgress && i % PROGRESS_EVERY === 0) {
			onProgress(t("progStaging"));
		}
	}
	return shas;
}

/** Classify a set of paths into added/modified vs deleted against a baseline. */
function diffShas(
	current: Record<string, string>,
	baseline: Record<string, string>,
): { changed: Set<string>; deleted: Set<string> } {
	const changed = new Set<string>();
	const deleted = new Set<string>();
	for (const [p, sha] of Object.entries(current)) {
		if (baseline[p] !== sha) changed.add(p);
	}
	for (const p of Object.keys(baseline)) {
		if (!(p in current)) deleted.add(p);
	}
	return { changed, deleted };
}

/**
 * Full bidirectional sync over the Git Data API, with NO conflict resolution
 * yet (stage 3). Memory is held to roughly one blob at a time throughout.
 *
 * Algorithm:
 *  1. Resolve the remote head and recursive tree → `remoteShas` (blobs only,
 *     excluded paths dropped).
 *  2. Walk the vault → `localShas` (git blob sha of every non-excluded file).
 *  3. Diff each side against `baseline.shas`:
 *       localChanged/localDeleted, remoteChanged/remoteDeleted.
 *  4. A path is a CONFLICT when it changed on both sides to different results
 *     (different sha, or deleted on one side and changed on the other). On this
 *     stage conflicts are left completely untouched (not pulled, not pushed,
 *     local file unchanged) and collected in `result.conflicts`.
 *  5. Pull non-conflict remote changes: fetch each blob (one at a time) and
 *     write it; remove files deleted remotely.
 *  6. Push non-conflict local changes: createBlob per file, one createTree on
 *     top of the remote tree (modified shas + deletions as sha:null), one
 *     createCommit (parent = remote commit), updateRef.
 *  7. Rebuild the baseline from the now-agreed state. Conflict paths keep their
 *     OLD baseline sha so they're re-detected as changed next time.
 */
export async function apiSync(opts: {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	adapter: DataAdapter;
	baseline: ApiSyncBaseline;
	excluded: (path: string) => boolean;
	message?: string;
	onProgress?: (msg: string) => void;
}): Promise<ApiSyncResult> {
	const { owner, repo, branch, token, adapter, baseline, excluded, onProgress } = opts;

	// 1. Remote state.
	onProgress?.(t("progFetching"));
	const { commitSha: remoteCommit, treeSha: remoteTree } = await getBranchHead(
		owner,
		repo,
		branch,
		token,
	);
	const { entries } = await getTree(owner, repo, remoteTree, token);
	const remoteShas: Record<string, string> = {};
	for (const e of entries) {
		if (!e.path || excluded(e.path)) continue;
		remoteShas[e.path] = e.sha;
	}

	// 2. Local state.
	const localShas = await scanLocalShas(adapter, excluded, onProgress);

	// 3. Diff both sides against the baseline.
	const local = diffShas(localShas, baseline.shas);
	const remote = diffShas(remoteShas, baseline.shas);

	// 4. Conflicts: touched on both sides with differing outcomes.
	const conflicts = new Set<string>();
	const touchedLocal = new Set<string>([...local.changed, ...local.deleted]);
	const touchedRemote = new Set<string>([...remote.changed, ...remote.deleted]);
	for (const p of touchedLocal) {
		if (!touchedRemote.has(p)) continue;
		const lSha = localShas[p]; // undefined if locally deleted
		const rSha = remoteShas[p]; // undefined if remotely deleted
		if (lSha !== rSha) conflicts.add(p);
		// If both ended at the same sha (lSha === rSha, incl. both-deleted) the
		// two sides converged — no conflict, and nothing to pull or push.
	}

	// Enrich each clash with the data needed for interactive resolution: the
	// remote/base blob shas (so the UI can lazily fetch content) and which side
	// deleted the path. The classification above is unchanged — we only describe
	// what we already decided is a conflict.
	const conflictInfos: ConflictInfo[] = [...conflicts].sort().map((p) => {
		const remoteSha = p in remoteShas ? remoteShas[p] : null;
		const baseSha = p in baseline.shas ? baseline.shas[p] : null;
		return {
			path: p,
			remoteSha,
			baseSha,
			localDeleted: !(p in localShas),
			remoteDeleted: remoteSha === null,
		};
	});

	const result: ApiSyncResult = {
		pulled: [],
		pushed: [],
		deletedLocal: [],
		deletedRemote: [],
		conflicts: conflictInfos,
		committed: false,
		newBaseline: { commitSha: baseline.commitSha, shas: {} },
	};

	// 5. Pull non-conflict remote changes.
	const toPull = [...remote.changed].filter((p) => !conflicts.has(p)).sort();
	const toDeleteLocal = [...remote.deleted].filter((p) => !conflicts.has(p)).sort();

	let pullCount = 0;
	for (const p of toPull) {
		// Skip pulling a blob whose content already matches locally (both sides
		// independently produced the same bytes): nothing to download or write,
		// so it must not be reported as pulled. The baseline is rebuilt from the
		// remote set below and stays correct regardless.
		if (localShas[p] === remoteShas[p]) {
			continue;
		}
		let bytes: Uint8Array | undefined = await getBlob(owner, repo, remoteShas[p], token);
		await writeVaultFile(adapter, p, bytes);
		bytes = undefined;
		result.pulled.push(p);
		pullCount++;
		if (onProgress && pullCount % PROGRESS_EVERY === 0) onProgress(t("progMerging"));
	}
	for (const p of toDeleteLocal) {
		if (await adapter.exists(p)) await adapter.remove(p);
		result.deletedLocal.push(p);
	}

	// 6. Push non-conflict local changes.
	const toPush = [...local.changed].filter((p) => !conflicts.has(p)).sort();
	const toDeleteRemote = [...local.deleted].filter((p) => !conflicts.has(p)).sort();

	// Drop no-op pushes where the remote already has the identical sha (e.g. the
	// same edit landed on both sides) — re-pushing would be an empty change.
	const realPush = toPush.filter((p) => remoteShas[p] !== localShas[p]);
	const realDeleteRemote = toDeleteRemote.filter((p) => p in remoteShas);

	let newCommit = remoteCommit;
	if (realPush.length > 0 || realDeleteRemote.length > 0) {
		onProgress?.(t("progPushing"));
		const treeEntries: TreeEntryInput[] = [];
		let pushCount = 0;
		for (const p of realPush) {
			let bytes: Uint8Array | undefined = new Uint8Array(await adapter.readBinary(p));
			const sha = await createBlob(owner, repo, token, bytes);
			bytes = undefined;
			treeEntries.push({ path: p, sha });
			pushCount++;
			if (onProgress && pushCount % PROGRESS_EVERY === 0) onProgress(t("progPushing"));
		}
		for (const p of realDeleteRemote) {
			treeEntries.push({ path: p, sha: null });
		}

		const newTree = await createTree(owner, repo, token, remoteTree, treeEntries);
		const message = opts.message && opts.message.trim() ? opts.message : "GitSync";
		newCommit = await createCommit(owner, repo, token, message, newTree, remoteCommit);
		await updateRef(owner, repo, token, branch, newCommit, false);
		result.committed = true;
	}

	for (const p of realPush) result.pushed.push(p);
	for (const p of realDeleteRemote) result.deletedRemote.push(p);

	// 7. Rebuild the baseline = the agreed common state we just established.
	//    Start from the (effective) remote set, apply what we pulled/deleted
	//    locally and pushed/deleted remotely, then re-pin conflict paths to
	//    their OLD baseline sha so they re-surface as changes next sync.
	const nb: Record<string, string> = {};
	// Begin from remote tree (post-known state), minus conflict paths handled below.
	for (const [p, sha] of Object.entries(remoteShas)) nb[p] = sha;
	// Apply pulls (now local matches remote — already in nb) and local deletions.
	for (const p of result.deletedLocal) delete nb[p];
	// Apply pushes: those paths now exist remotely at the local sha.
	for (const p of result.pushed) nb[p] = localShas[p];
	for (const p of result.deletedRemote) delete nb[p];
	// Conflict paths: keep them as they were in the prior baseline (or absent),
	// so the next sync re-detects them and resolution can run.
	for (const p of conflicts) {
		if (p in baseline.shas) nb[p] = baseline.shas[p];
		else delete nb[p];
	}

	result.newBaseline = { commitSha: newCommit, shas: nb };
	return result;
}

/**
 * Stage 3: apply user conflict resolutions and commit them.
 *
 * Each entry in `resolved` is a path the user resolved: `content != null` is the
 * chosen final bytes (local, remote, or a manual merge); `content == null` means
 * "delete this path" (locally and on the remote). The flow:
 *
 *  1. Write resolutions to DISK first via the adapter (so the working tree and
 *     the commit we build agree): bytes → writeVaultFile, null → remove if it
 *     exists locally.
 *  2. RE-READ the remote head ({@link getBranchHead}) — the remote may have
 *     advanced since `apiSync` ran (another device pushed, or apiSync itself
 *     pushed non-conflict changes). We build the commit on top of the *current*
 *     remote commit/tree so the ref update fast-forwards.
 *  3. createBlob per resolved file (one at a time, bytes dropped immediately),
 *     one createTree on top of the live remote tree (resolved shas; deletions as
 *     sha:null), one createCommit (parent = live remote commit), updateRef.
 *  4. Rebuild the baseline from `opts.baseline`: for each resolved path set its
 *     new sha (gitBlobSha of the content) or delete it (content == null); set
 *     `commitSha` to the new commit. Every other baseline entry is preserved.
 *
 * Memory: at most one blob's bytes are held at a time. The token is only ever an
 * Authorization header — never logged.
 *
 * An empty `resolved` is a no-op: `committed=false`, baseline unchanged.
 */
export async function commitResolutions(opts: {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	adapter: DataAdapter;
	baseline: ApiSyncBaseline;
	resolved: Array<{ path: string; content: Uint8Array | null }>;
	message?: string;
	onProgress?: (msg: string) => void;
}): Promise<{ committed: boolean; newBaseline: ApiSyncBaseline }> {
	const { owner, repo, branch, token, adapter, baseline, resolved, onProgress } = opts;

	// No resolutions → nothing to write, commit, or change in the baseline.
	if (resolved.length === 0) {
		return { committed: false, newBaseline: baseline };
	}

	// 1. Write resolutions to disk first (working tree == what we'll commit).
	onProgress?.(t("progMerging"));
	for (const r of resolved) {
		if (r.content !== null) {
			await writeVaultFile(adapter, r.path, r.content);
		} else if (await adapter.exists(r.path)) {
			await adapter.remove(r.path);
		}
	}

	// 2. Re-read the live remote head so we build on top of the current tip.
	onProgress?.(t("progFetching"));
	const { commitSha: remoteCommit, treeSha: remoteTree } = await getBranchHead(
		owner,
		repo,
		branch,
		token,
	);

	// 3. Upload resolved blobs one at a time, then build tree + commit + ref.
	onProgress?.(t("progPushing"));
	const treeEntries: TreeEntryInput[] = [];
	// Track the new blob sha per resolved path so the baseline matches exactly
	// what we committed (no extra hashing pass, no second copy of the bytes).
	const resolvedShas: Record<string, string> = {};
	let pushCount = 0;
	for (const r of resolved) {
		if (r.content !== null) {
			let bytes: Uint8Array | undefined = r.content;
			const sha = await createBlob(owner, repo, token, bytes);
			bytes = undefined;
			treeEntries.push({ path: r.path, sha });
			resolvedShas[r.path] = sha;
		} else {
			treeEntries.push({ path: r.path, sha: null });
		}
		pushCount++;
		if (onProgress && pushCount % PROGRESS_EVERY === 0) onProgress(t("progPushing"));
	}

	const newTree = await createTree(owner, repo, token, remoteTree, treeEntries);
	const message = opts.message && opts.message.trim() ? opts.message : "GitSync";
	const newCommit = await createCommit(owner, repo, token, message, newTree, remoteCommit);
	await updateRef(owner, repo, token, branch, newCommit, false);

	// 4. Rebuild the baseline: keep everything from the prior baseline, then
	//    apply the resolved paths (new sha, or removed when deleted).
	const nb: Record<string, string> = { ...baseline.shas };
	for (const r of resolved) {
		if (r.content !== null) {
			nb[r.path] = resolvedShas[r.path];
		} else {
			delete nb[r.path];
		}
	}

	return { committed: true, newBaseline: { commitSha: newCommit, shas: nb } };
}

/** Write bytes to the vault, choosing text vs binary path like git-fs does. */
async function writeVaultFile(adapter: DataAdapter, path: string, bytes: Uint8Array): Promise<void> {
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	if (dir && !(await adapter.exists(dir))) {
		// Create the ancestor chain top-down.
		const segs = dir.split("/");
		let prefix = "";
		for (const seg of segs) {
			if (!seg) continue;
			prefix = prefix ? `${prefix}/${seg}` : seg;
			if (!(await adapter.exists(prefix))) await adapter.mkdir(prefix);
		}
	}
	if (looksBinary(bytes)) {
		await adapter.writeBinary(path, new Uint8Array(bytes).buffer);
	} else {
		await adapter.write(path, TEXT_DECODER.decode(bytes));
	}
}
