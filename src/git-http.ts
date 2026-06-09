import { requestUrl } from "obsidian";
import type { HttpClient, GitHttpRequest, GitHttpResponse } from "isomorphic-git";

/**
 * HTTP client for isomorphic-git built on Obsidian's {@link requestUrl}.
 *
 * A plain `fetch` is blocked by CORS inside Obsidian (the request originates
 * from `app://obsidian.md`), whereas `requestUrl` is proxied through the native
 * layer (Electron on desktop, Capacitor on mobile) and is not subject to CORS.
 */
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

		const res = await requestUrl({
			url,
			method,
			headers,
			body: bodyBuffer,
			throw: false,
		});

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
