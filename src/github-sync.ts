import { requestUrl } from "obsidian";
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
