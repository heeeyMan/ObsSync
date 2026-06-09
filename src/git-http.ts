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
 * the network error.
 */
const REQUEST_TIMEOUT_MS = 60_000;
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
	return merged.buffer;
}

export const obsidianHttpClient: HttpClient = {
	async request({
		url,
		method = "GET",
		headers = {},
		body,
	}: GitHttpRequest): Promise<GitHttpResponse> {
		const bodyBuffer = await collectBody(body);

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
					headers,
					body: bodyBuffer,
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
			url,
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
