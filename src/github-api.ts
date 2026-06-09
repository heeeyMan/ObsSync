import { requestUrl } from "obsidian";
import { t } from "./i18n";

/**
 * Minimal GitHub REST API client used by the settings "Authorization" feature:
 * it resolves the username from a token and lists the repositories the token
 * can see, so the Remote URL field can be populated from a dropdown.
 *
 * Like {@link ./git-http.ts}, all requests go through Obsidian's
 * {@link requestUrl}: a plain `fetch` is blocked by CORS inside Obsidian (the
 * request originates from `app://obsidian.md`), whereas `requestUrl` is proxied
 * through the native layer (Electron on desktop, Capacitor on mobile) and so
 * works identically and without CORS on both platforms.
 *
 * The token is used only as an `Authorization` header — it is never logged.
 */

export interface GitHubUser {
	login: string;
	name: string | null;
}

export interface GitHubRepo {
	fullName: string;
	cloneUrl: string;
	private: boolean;
}

/**
 * `requestUrl` has no timeout, so a stalled request on a dropped mobile
 * connection never settles. Mirror git-http.ts: cap each request with a
 * Promise.race; on expiry reject with a message that maps to the network error.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/** Guard against runaway pagination (100 repos/page × 10 pages = 1000 repos). */
const MAX_PAGES = 10;
const PER_PAGE = 100;

const API_BASE = "https://api.github.com";

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
 * failures and on network/timeout failures.
 */
async function apiGet(url: string, token: string): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
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
	} catch (e) {
		// Timeout or a thrown transport failure — surface as a network error.
		throw new Error(t("errNetwork"));
	} finally {
		if (timer) clearTimeout(timer);
	}

	// status 0 means the request never reached the server (offline, DNS, etc.).
	if (!res.status) {
		throw new Error(t("errNetwork"));
	}
	// 401: bad/expired token. 403: missing scope or rate limited — for the
	// authorization flow this is almost always the token, so surface the same
	// actionable message.
	if (res.status === 401 || res.status === 403) {
		throw new Error(t("errBadToken"));
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(t("errNetwork"));
	}

	return res.json;
}

/** GET /user → the authenticated user's login and display name. */
export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
	const data = (await apiGet(`${API_BASE}/user`, token)) as {
		login?: unknown;
		name?: unknown;
	};
	return {
		login: typeof data.login === "string" ? data.login : "",
		name: typeof data.name === "string" ? data.name : null,
	};
}

/**
 * GET /user/repos → every repository the token can access (owner, collaborator,
 * organization member), sorted by most recently pushed. Pages through results
 * until a short page arrives or {@link MAX_PAGES} is reached, preserving the
 * server's pushed-desc order.
 */
export async function fetchGitHubRepos(token: string): Promise<GitHubRepo[]> {
	const repos: GitHubRepo[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		const url =
			`${API_BASE}/user/repos?per_page=${PER_PAGE}` +
			`&affiliation=owner,collaborator,organization_member` +
			`&sort=pushed&direction=desc&page=${page}`;

		const data = (await apiGet(url, token)) as Array<{
			full_name?: unknown;
			clone_url?: unknown;
			private?: unknown;
		}>;

		if (!Array.isArray(data)) break;

		for (const r of data) {
			repos.push({
				fullName: typeof r.full_name === "string" ? r.full_name : "",
				cloneUrl: typeof r.clone_url === "string" ? r.clone_url : "",
				private: r.private === true,
			});
		}

		// A short page means there is nothing more to fetch.
		if (data.length < PER_PAGE) break;
	}

	return repos;
}
