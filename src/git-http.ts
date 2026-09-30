import { Platform, requestUrl } from "obsidian";
import type { HttpClient, GitHttpRequest, GitHttpResponse } from "isomorphic-git";

/**
 * HTTP client for isomorphic-git.
 *
 * A plain `fetch` is blocked by CORS inside Obsidian (the request originates
 * from `app://obsidian.md`).
 *
 * Desktop uses Node's `http`/`https`. GitHub's git HTTP backend does not
 * answer a POST until it has `Content-Length`, and it never replies to a
 * chunked body — sync then sits until our timeout. Electron's `net.request`
 * (what Obsidian's `requestUrl` uses on desktop) rejects a manual
 * `Content-Length` with `net::ERR_INVALID_ARGUMENT` and does not add one
 * itself. Node's client accepts the header and frames the body.
 *
 * Mobile has no Node builtins, so it stays on `requestUrl` (Capacitor) and
 * does send `Content-Length`. That path is not the desktop Electron stack.
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

/**
 * Headers we never forward from the caller. `Host` and `Transfer-Encoding`
 * make Electron's `net.request` fail with `net::ERR_INVALID_ARGUMENT`. A
 * caller-supplied `Content-Length` is dropped too, then replaced (when
 * `contentLength` is passed) with the length of the buffer we actually send.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
	"content-length",
	"host",
	"trailer",
	"te",
	"upgrade",
	"cookie2",
	"keep-alive",
	"transfer-encoding",
]);

/**
 * Copy isomorphic-git's headers into a fresh object.
 *
 * The copy matters: isomorphic-git reuses and mutates the same header object
 * across the discover GET and the pack POST.
 *
 * Pass `contentLength` whenever a body is sent. GitHub waits forever on a
 * git smart-HTTP POST that has no `Content-Length`.
 *
 * Exported for the offline check in `scripts/git-http-url.mjs`.
 */
export function prepareGitHttpHeaders(
	headers: Record<string, string>,
	options: { contentLength?: number } = {}
): Record<string, string> {
	const headersOut: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
		headersOut[key] = value;
	}
	if (!headerValue(headersOut, "user-agent")) {
		headersOut["User-Agent"] = "git/obsidian-git-vault-sync";
	}
	if (options.contentLength !== undefined) {
		headersOut["Content-Length"] = String(options.contentLength);
	}
	return headersOut;
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

/** Node's `http`/`https` `request`, the only surface the desktop path needs. */
interface NodeClientRequest {
	write(chunk: Uint8Array): void;
	end(): void;
	destroy(err?: Error): void;
	on(event: "error", cb: (err: Error) => void): void;
}

interface NodeIncomingMessage {
	statusCode?: number;
	statusMessage?: string;
	headers: Record<string, string | string[] | undefined>;
	resume(): void;
	on(event: "data", cb: (chunk: Uint8Array) => void): void;
	on(event: "end", cb: () => void): void;
	on(event: "error", cb: (err: Error) => void): void;
}

interface NodeHttpLike {
	request(
		url: string,
		options: { method: string; headers: Record<string, string> },
		cb: (res: NodeIncomingMessage) => void
	): NodeClientRequest;
}

declare function require(module: string): NodeHttpLike;

const MAX_REDIRECTS = 5;

export interface NodeGitHttpResult {
	url: string;
	statusCode: number;
	statusMessage: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

/**
 * Desktop git HTTP. Sets `Content-Length` from the buffered body and follows
 * redirects without turning a POST into a GET — GitHub's `.git` 301 is a POST,
 * and dropping the body would make the next hop hang the same way.
 *
 * `require("http")` / `require("https")` stay inside this function so the
 * mobile bundle does not touch Node builtins at load time.
 *
 * Exported for the local-server check in `scripts/git-http-url.mjs`.
 */
export function nodeGitHttpRequest(options: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: ArrayBuffer;
	timeoutMs: number;
	deadline?: number;
	hop?: number;
}): Promise<NodeGitHttpResult> {
	const deadline = options.deadline ?? Date.now() + options.timeoutMs;
	const hop = options.hop ?? 0;
	const { url, method } = options;
	const body = options.body;
	const headers: Record<string, string> = { ...options.headers };
	if (body) {
		for (const key of Object.keys(headers)) {
			const lower = key.toLowerCase();
			if (lower === "content-length" || lower === "transfer-encoding") {
				delete headers[key];
			}
		}
		headers["Content-Length"] = String(body.byteLength);
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let handedOff = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (err: Error | null, value?: NodeGitHttpResult) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (err) reject(err);
			else resolve(value as NodeGitHttpResult);
		};
		const fail = (err: Error) => {
			const msg = err.message || String(err);
			if (/ERR_TIMEOUT/i.test(msg)) finish(err);
			else finish(new Error(`ERR_NETWORK: ${msg}`));
		};

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch (err) {
			fail(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		let mod: NodeHttpLike;
		try {
			mod = parsed.protocol === "http:" ? require("http") : require("https");
		} catch (err) {
			fail(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			fail(
				new Error(
					`ERR_TIMEOUT: ${method} ${redactUrl(url)} timed out after ${options.timeoutMs}ms`
				)
			);
			return;
		}

		const req = mod.request(url, { method, headers }, (res) => {
			const statusCode = res.statusCode ?? 0;
			const location = headerListValue(res.headers.location);
			if (
				location &&
				hop < MAX_REDIRECTS &&
				(statusCode === 301 ||
					statusCode === 302 ||
					statusCode === 307 ||
					statusCode === 308)
			) {
				handedOff = true;
				if (timer !== undefined) clearTimeout(timer);
				res.resume();
				let nextUrl: string;
				try {
					nextUrl = new URL(location, url).toString();
				} catch (err) {
					fail(err instanceof Error ? err : new Error(String(err)));
					return;
				}
				nodeGitHttpRequest({
					url: nextUrl,
					method,
					headers: headersForRedirect(headers, url, nextUrl),
					body,
					timeoutMs: options.timeoutMs,
					deadline,
					hop: hop + 1,
				}).then(
					(value) => finish(null, value),
					(err) => fail(err instanceof Error ? err : new Error(String(err)))
				);
				return;
			}

			const chunks: Uint8Array[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("error", (err) => fail(err));
			res.on("end", () => {
				finish(null, {
					url,
					statusCode,
					statusMessage: res.statusMessage || String(statusCode),
					headers: flattenNodeHeaders(res.headers),
					body: concatBytes(chunks),
				});
			});
		});

		timer = setTimeout(() => {
			req.destroy(
				new Error(
					`ERR_TIMEOUT: ${method} ${redactUrl(url)} timed out after ${options.timeoutMs}ms`
				)
			);
		}, remaining);

		req.on("error", (err) => {
			if (!handedOff) fail(err);
		});
		if (body) req.write(new Uint8Array(body));
		req.end();
	});
}

function headerListValue(
	value: string | string[] | undefined
): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function flattenNodeHeaders(
	raw: Record<string, string | string[] | undefined>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		out[key] = Array.isArray(value) ? value.join(", ") : value;
	}
	return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/** Drop credentials when a redirect leaves the host that issued them. */
function headersForRedirect(
	headers: Record<string, string>,
	from: string,
	to: string
): Record<string, string> {
	let fromHost = "";
	let toHost = "";
	try {
		fromHost = new URL(from).hostname;
		toHost = new URL(to).hostname;
	} catch {
		return headers;
	}
	if (fromHost === toHost) return headers;
	const copy: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (/^(authorization|proxy-authorization|cookie)$/i.test(key)) continue;
		copy[key] = value;
	}
	return copy;
}

export const obsidianHttpClient: HttpClient = {
	async request({
		url,
		method = "GET",
		headers = {},
		body,
	}: GitHttpRequest): Promise<GitHttpResponse> {
		const bodyBuffer = await collectBody(body);
		const headersOut = prepareGitHttpHeaders(headers, {
			contentLength: bodyBuffer ? bodyBuffer.byteLength : undefined,
		});
		const contentType = headerValue(headersOut, "content-type");
		const canonicalUrl = canonicalizeGitHttpUrl(url);
		const timeoutMs = bodyBuffer ? PACK_TIMEOUT_MS : GET_TIMEOUT_MS;

		// Desktop Electron rejects Content-Length on requestUrl and then
		// leaves the git POST chunked, which GitHub never answers. Node's
		// client frames the same body correctly.
		if (Platform.isDesktopApp) {
			const nodeRes = await nodeGitHttpRequest({
				url: canonicalUrl,
				method,
				headers: headersOut,
				body: bodyBuffer,
				timeoutMs,
			});
			if (!nodeRes.statusCode) {
				throw new Error("ERR_NETWORK: request failed (no response)");
			}
			return {
				url: nodeRes.url,
				method,
				statusCode: nodeRes.statusCode,
				statusMessage: nodeRes.statusMessage,
				headers: nodeRes.headers,
				body: [nodeRes.body] as unknown as GitHttpResponse["body"],
			};
		}

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
