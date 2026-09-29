import { requestUrl } from "obsidian";
import type { HttpClient, GitHttpRequest, GitHttpResponse } from "isomorphic-git";

/**
 * HTTP client for isomorphic-git built on Obsidian's {@link requestUrl}.
 *
 * A plain `fetch` is blocked by CORS inside Obsidian (the request originates
 * from `app://obsidian.md`), whereas `requestUrl` is proxied through the native
 * layer (Electron on desktop, Capacitor on mobile) and is not subject to CORS.
 */

/**
 * `requestUrl` has no timeout, so a request stalled by a dropped mobile
 * connection never settles and `sync()` hangs forever with `syncing` stuck on.
 * Cap each request; on expiry we reject with a message `friendlyError` maps to
 * the timeout error.
 *
 * GETs (`info/refs`) are small — fail those fast. POSTs are the pack transfer:
 * the body is the want/have list (or the push pack) and the response is the
 * downloaded packfile. A full-history fetch of a real vault routinely takes
 * longer than a minute, so the pack cap is much higher.
 */
const GET_TIMEOUT_MS = 60_000;
const PACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Rewrite a GitHub smart-HTTP URL so the repo path ends in `.git`.
 *
 * `https://github.com/owner/repo` (no `.git`) 301-redirects to
 * `https://github.com/owner/repo.git/...`. `fetch` follows that. Obsidian's
 * `requestUrl` (Electron `net.request` / Capacitor) often does not follow a
 * POST redirect and instead waits until our timeout — sync then fails with
 * `ERR_TIMEOUT` on the first `git-upload-pack` / `git-receive-pack`. GitHub's
 * own clone URL already includes `.git`; a URL typed without it does not.
 * Other hosts are left alone: appending `.git` there can 404 a server whose
 * repo path is not suffixed.
 *
 * Exported for the offline URL check in `scripts/git-http-url.mjs`.
 */
export function canonicalizeGitHttpUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return url;
	if (/\.git(\/|$)/i.test(parsed.pathname)) return url;
	const svc = parsed.pathname.match(
		/^(.*)(\/(?:info\/refs|git-upload-pack|git-receive-pack))$/
	);
	if (!svc) return url;
	const base = svc[1].replace(/\/$/, "");
	if (!base) return url;
	parsed.pathname = `${base}.git${svc[2]}`;
	return parsed.toString();
}

function headerValue(
	headers: Record<string, string>,
	name: string
): string | undefined {
	const want = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want) return value;
	}
	return undefined;
}

/** URL safe to put in an error string: no userinfo, in case a token was embedded. */
function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

async function collectBody(
	body: GitHttpRequest["body"]
): Promise<ArrayBuffer | undefined> {
	if (!body) return undefined;
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) {
		chunks.push(chunk);
	}
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	if (total === 0) return undefined;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	// Drop references to the intermediate chunks so the GC can reclaim those
	// copies of the packfile immediately; on a phone a push/clone body can be
	// large and holding both the chunks and the merged buffer risks OOM.
	chunks.length = 0;
	// Exact slice: a Uint8Array view can share a larger buffer, and requestUrl
	// sends the whole ArrayBuffer. A too-long body (or a mismatched
	// Content-Length) makes GitHub's git HTTP backend wait until we time out.
	return merged.buffer.slice(0, merged.byteLength);
}

export const obsidianHttpClient: HttpClient = {
	async request({
		url,
		method = "GET",
		headers = {},
		body,
	}: GitHttpRequest): Promise<GitHttpResponse> {
		const bodyBuffer = await collectBody(body);
		// Copy: isomorphic-git reuses and mutates this object across the
		// discover GET and the pack POST. Writing Content-Length onto it would
		// leak the previous POST's length onto the next GET.
		const headersOut: Record<string, string> = { ...headers };
		if (!headerValue(headersOut, "user-agent")) {
			headersOut["User-Agent"] = "git/obsidian-git-vault-sync";
		}
		const contentType = headerValue(headersOut, "content-type");
		// GitHub's smart HTTP POST hangs until the client gives up when the
		// body is sent chunked (no Content-Length). `fetch` sets the length
		// itself; `requestUrl` does not, so a pack upload/download sits until
		// this timeout. Set it explicitly from the buffered body.
		if (bodyBuffer) {
			headersOut["Content-Length"] = String(bodyBuffer.byteLength);
		}
		const canonicalUrl = canonicalizeGitHttpUrl(url);
		const timeoutMs = bodyBuffer ? PACK_TIMEOUT_MS : GET_TIMEOUT_MS;

		let timer: number | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => {
				reject(
					new Error(
						`ERR_TIMEOUT: ${method} ${redactUrl(canonicalUrl)} timed out after ${timeoutMs}ms`
					)
				);
			}, timeoutMs);
		});

		let res;
		try {
			res = await Promise.race([
				requestUrl({
					url: canonicalUrl,
					method,
					headers: headersOut,
					// Obsidian sends a binary body reliably only when contentType
					// is set on the request, not solely via the headers map.
					// Omit it on GETs so we don't stamp an undefined content type.
					...(contentType ? { contentType } : {}),
					...(bodyBuffer ? { body: bodyBuffer } : {}),
					throw: false,
				}),
				timeout,
			]);
		} finally {
			if (timer) window.clearTimeout(timer);
		}

		// status 0 (and the empty body that comes with it) means the request
		// never reached the server — surface it as a network failure so
		// friendlyError maps it to errNetwork rather than a confusing HTTP error.
		if (!res.status) {
			throw new Error("ERR_NETWORK: request failed (no response)");
		}

		// requestUrl lowercases header names; isomorphic-git reads them
		// case-insensitively, so pass them through as-is.
		return {
			url: canonicalUrl,
			method,
			statusCode: res.status,
			statusMessage: String(res.status),
			headers: res.headers,
			// isomorphic-git accepts a plain array of chunks here even though
			// the published type only names AsyncIterableIterator.
			body: [
				new Uint8Array(res.arrayBuffer ?? new ArrayBuffer(0)),
			] as unknown as GitHttpResponse["body"],
		};
	},
};
