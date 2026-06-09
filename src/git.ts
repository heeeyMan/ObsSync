import * as git from "isomorphic-git";
import { DataAdapter } from "obsidian";
import { GitFs } from "./git-fs";
import { obsidianHttpClient } from "./git-http";
import type { GitSyncSettings } from "./settings";
import { t } from "./i18n";

/**
 * History depth pulled on the very first fetch of a fresh repo. Keeping it
 * shallow avoids loading the whole vault history into memory on mobile;
 * subsequent fetches deepen on demand. 1 is enough to adopt the remote tip.
 */
const INITIAL_FETCH_DEPTH = 1;

export interface SyncResult {
	/** A local commit was created from working-tree changes. */
	committed: boolean;
	/** Remote changes were merged into the local branch. */
	pulled: boolean;
	/** Local commits were pushed to the remote. */
	pushed: boolean;
	/** Files left in a conflicted state (empty when sync succeeded). */
	conflicts: string[];
}

/**
 * Thrown by {@link GitManager.sync} when a merge needs manual resolution.
 * Carries the commit ids of both sides so the resolver can read each version
 * and finish the merge via {@link GitManager.completeMerge}.
 */
export class MergeConflict extends Error {
	constructor(
		readonly files: string[],
		readonly oursOid: string,
		readonly theirsOid: string,
		readonly branch: string,
		/** Deselected local paths that must stay out of the merge commit. */
		readonly skipPaths: string[] = [],
		/** Pre-merge contents of deselected files, to restore after merging. */
		readonly snapshot: Map<string, Uint8Array | null> | null = null
	) {
		super(`Merge conflict in ${files.length} file(s)`);
		this.name = "MergeConflict";
	}
}

/** A single working-tree change, for the commit-preview screen. */
export interface ChangeEntry {
	path: string;
	status: "added" | "modified" | "deleted";
}

/** How the user chose to resolve a single conflicted file. */
export type Resolution =
	| { type: "local" }
	| { type: "remote" }
	| { type: "manual"; content: string };

export type ProgressLog = (message: string) => void;

/**
 * Thin wrapper around isomorphic-git, bound to an Obsidian vault via {@link GitFs}.
 * The whole vault is the working tree; the repo lives in `<vault>/.git`.
 */
export class GitManager {
	private readonly fs: GitFs;
	private readonly dir = "/";

	/**
	 * Serializes all mutating public operations against the shared `.git/index`.
	 * Concurrent commits would otherwise race and silently drop one of them.
	 */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		adapter: DataAdapter,
		private readonly getSettings: () => GitSyncSettings
	) {
		this.fs = new GitFs(adapter);
	}

	/**
	 * Run `fn` exclusively, queued behind any in-flight mutating operation.
	 * A failure in one operation must not break the lock for the next, so the
	 * chain is advanced with the rejection swallowed (the caller still sees it).
	 *
	 * Public mutating methods funnel through here and delegate to private,
	 * un-guarded `*Inner` helpers; internal calls use the inner helpers directly
	 * so re-entrancy never deadlocks on the same lock.
	 */
	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.then(
			() => {},
			() => {}
		);
		return run;
	}

	private base() {
		const s = this.getSettings();
		return {
			fs: this.fs,
			http: obsidianHttpClient,
			dir: this.dir,
			onAuth: () => ({
				username: s.username || s.token,
				password: s.token,
			}),
		};
	}

	/** True if `<vault>/.git` already holds a repository. */
	async isRepo(): Promise<boolean> {
		try {
			await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Verify remote URL + token + connectivity without touching the working
	 * tree. Returns the list of remote branch names.
	 */
	async testConnection(): Promise<string[]> {
		const s = this.getSettings();
		const info = await git.getRemoteInfo({
			http: obsidianHttpClient,
			url: s.remoteUrl,
			onAuth: () => ({
				username: s.username || s.token,
				password: s.token,
			}),
		});
		const branches = info.refs?.heads ? Object.keys(info.refs.heads) : [];
		return branches;
	}

	/** Number of files that differ from HEAD, ignoring excluded paths. */
	async countChanges(): Promise<number> {
		const excluded = this.excludeMatcher();
		// `filter` drops excluded paths *before* statusMatrix hashes them, so we
		// never read/SHA the content of files the user excluded. countChanges
		// runs on the status-bar timer (~every 1.5s); hashing the whole vault
		// each tick caused freezes and battery drain on mobile.
		const matrix = await git.statusMatrix({
			fs: this.fs,
			dir: this.dir,
			filter: (filepath) => !excluded(filepath),
		});
		// [filepath, HEAD, workdir, stage]; unchanged === [1,1,1].
		return matrix.filter(
			([, head, workdir, stage]) =>
				!(head === 1 && workdir === 1 && stage === 1)
		).length;
	}

	/** List the changes that a sync would commit (excluded paths omitted). */
	async listChanges(): Promise<ChangeEntry[]> {
		const excluded = this.excludeMatcher();
		const matrix = await git.statusMatrix({
			fs: this.fs,
			dir: this.dir,
			filter: (filepath) => !excluded(filepath),
		});
		const out: ChangeEntry[] = [];
		for (const [filepath, head, workdir, stage] of matrix) {
			if (head === 1 && workdir === 1 && stage === 1) continue; // unchanged
			const status =
				head === 0 ? "added" : workdir === 0 ? "deleted" : "modified";
			out.push({ path: filepath, status });
		}
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Build a predicate matching the user's excluded glob patterns. */
	private excludeMatcher(): (path: string) => boolean {
		const patterns = (this.getSettings().excludePaths || "")
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		if (patterns.length === 0) return () => false;
		const regexes = patterns.map(globToRegExp);
		return (path) => regexes.some((re) => re.test(path));
	}

	private author() {
		const s = this.getSettings();
		return { name: s.authorName || "GitSync", email: s.authorEmail || "" };
	}

	/**
	 * One-click sync: stage everything, commit local changes, fetch + merge the
	 * remote branch, then push (retrying once if the remote moved underneath us).
	 * Throws {@link MergeConflict} when the merge needs manual resolution.
	 */
	async sync(
		log: ProgressLog = () => {},
		only?: string[]
	): Promise<SyncResult> {
		return this.runExclusive(() => this.syncInner(log, only));
	}

	private async syncInner(
		log: ProgressLog,
		only?: string[]
	): Promise<SyncResult> {
		const branch = this.getSettings().branch || "main";
		const result: SyncResult = {
			committed: false,
			pulled: false,
			pushed: false,
			conflicts: [],
		};

		// Deselected local changes must stay out of any merge commit, and their
		// on-disk edits must survive the merge (which rewrites the working tree).
		const skip = only ? await this.deselectedPaths(only) : [];

		// The merge-checkout rewrites the working tree from the merged tree, so
		// it clobbers on-disk edits to *tracked* files that aren't part of the
		// merge. Deselected files (`skip`) are one such set; the other is files
		// that are tracked but excluded from staging — their edits never get
		// committed, so they'd silently vanish after a merge. Snapshot both so
		// restoreSnapshotSafely can put them back. (Untracked excluded files,
		// e.g. data.json with the token, are left out: git never writes them.)
		const protectedPaths = new Set(skip);
		for (const p of await this.trackedExcludedModified()) {
			protectedPaths.add(p);
		}
		const snapshot = protectedPaths.size
			? await this.snapshotPaths([...protectedPaths])
			: null;

		let caught: unknown;
		let isConflict = false;
		try {
			// 1. Stage the chosen changes (or all of them), then commit.
			log(t("progStaging"));
			const changed = await this.stageAll(
				only ? new Set(only) : undefined
			);
			if (changed > 0) {
				log(t("progCommitting", { n: changed }));
				await git.commit({
					fs: this.fs,
					dir: this.dir,
					message: this.commitMessage(),
					author: this.author(),
				});
				result.committed = true;
			}

			// 2. Fetch + merge remote into local. On conflict this throws a
			// MergeConflict carrying the snapshot, and the resolver restores it.
			await this.fetchAndMerge(branch, result, log, skip, snapshot);

			// 3. Push, retrying once if the remote advanced after our fetch.
			await this.pushLoop(branch, result, log, skip, snapshot);
		} catch (err) {
			caught = friendlyError(err);
			isConflict = caught instanceof MergeConflict;
		} finally {
			// Restore deselected edits the merge may have overwritten — even if
			// fetch/merge/push threw (e.g. mobile lost the network between
			// commit and push), or those edits are lost irrecoverably.
			//
			// A MergeConflict is the one exception: the snapshot travels with it
			// to the resolver, which restores after completeMerge/abortMerge.
			// Restoring here would clobber the conflict markers the UI needs.
			if (snapshot && !isConflict) {
				await this.restoreSnapshotSafely(snapshot);
			}
		}
		if (caught) throw caught;

		return result;
	}

	/**
	 * Paths that are excluded from staging yet tracked in HEAD and edited on
	 * disk. Their edits never get committed (they're excluded), so a merge
	 * checkout would silently discard them unless we snapshot + restore them.
	 * We deliberately scan only the excluded set (filter inverts the usual
	 * exclude predicate), so when nothing is excluded this hashes nothing.
	 */
	private async trackedExcludedModified(): Promise<string[]> {
		const excluded = this.excludeMatcher();
		const matrix = await git.statusMatrix({
			fs: this.fs,
			dir: this.dir,
			filter: (filepath) => excluded(filepath),
		});
		const out: string[] = [];
		for (const [filepath, head, workdir] of matrix) {
			// head === 1: tracked in HEAD. workdir !== 1: edited or deleted on
			// disk relative to HEAD. Untracked excluded files (head === 0) are
			// skipped — git never touches them during a merge.
			if (head === 1 && workdir !== 1) out.push(filepath);
		}
		return out;
	}

	/** Changed local paths the user left unselected (relative complement of `only`). */
	private async deselectedPaths(only: string[]): Promise<string[]> {
		const onlySet = new Set(only);
		const changes = await this.listChanges();
		return changes.map((c) => c.path).filter((p) => !onlySet.has(p));
	}

	/** Capture current on-disk bytes of the given paths (null = absent). */
	private async snapshotPaths(
		paths: string[]
	): Promise<Map<string, Uint8Array | null>> {
		const snap = new Map<string, Uint8Array | null>();
		for (const p of paths) {
			try {
				const content = await this.fs.readFile(p);
				snap.set(
					p,
					typeof content === "string"
						? new TextEncoder().encode(content)
						: content
				);
			} catch {
				snap.set(p, null);
			}
		}
		return snap;
	}

	/**
	 * Restore the snapshot, attempting every file even if some fail (so a single
	 * bad path doesn't strand the rest). If anything fails — e.g. the phone's
	 * disk is full — surface a clear error rather than silently dropping the
	 * user's deselected edits.
	 */
	private async restoreSnapshotSafely(
		snap: Map<string, Uint8Array | null>
	): Promise<void> {
		const failed: string[] = [];
		for (const [p, content] of snap) {
			try {
				if (content === null) await this.fs.unlink(p);
				else await this.fs.writeFile(p, content);
			} catch {
				failed.push(p);
			}
		}
		if (failed.length) {
			// Surfacing the raw paths is far better than silently dropping edits.
			throw new Error(
				t("errRestoreFailed", { files: failed.join(", ") })
			);
		}
	}

	/** Fetch the remote branch and merge it into the local branch. */
	private async fetchAndMerge(
		branch: string,
		result: SyncResult,
		log: ProgressLog,
		skip: string[] = [],
		snapshot: Map<string, Uint8Array | null> | null = null
	): Promise<void> {
		const s = this.getSettings();
		log(t("progFetching"));
		await git.fetch({
			...this.base(),
			remote: "origin",
			url: s.remoteUrl,
			ref: branch,
			singleBranch: true,
			tags: false,
		});

		const remoteRef = `refs/remotes/origin/${branch}`;
		const remoteOid = await this.tryResolve(remoteRef);
		const localOid = await this.tryResolve(branch);
		if (!remoteOid || !localOid || localOid === remoteOid) return;

		log(t("progMerging"));
		try {
			const merge = await git.merge({
				fs: this.fs,
				dir: this.dir,
				ours: branch,
				theirs: remoteRef,
				author: this.author(),
				// Write non-conflicting merges + conflict markers to the working
				// tree, then throw so we can resolve interactively.
				abortOnConflict: false,
			});
			if (merge.oid && merge.oid !== localOid) {
				await git.checkout({
					fs: this.fs,
					dir: this.dir,
					ref: branch,
					force: true,
				});
				result.pulled = true;
			}
		} catch (err) {
			const files = mergeConflictFiles(err);
			if (files) {
				throw new MergeConflict(
					files,
					localOid,
					remoteOid,
					branch,
					skip,
					snapshot
				);
			}
			throw err;
		}
	}

	/** Push, and on a non-fast-forward rejection re-sync once and retry. */
	private async pushLoop(
		branch: string,
		result: SyncResult,
		log: ProgressLog,
		skip: string[] = [],
		snapshot: Map<string, Uint8Array | null> | null = null
	): Promise<void> {
		const remoteRef = `refs/remotes/origin/${branch}`;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const localOid = await this.tryResolve(branch);
			const remoteOid = await this.tryResolve(remoteRef);
			if (!localOid || localOid === remoteOid) return; // nothing to push
			try {
				log(t("progPushing"));
				await this.doPush(branch);
				result.pushed = true;
				return;
			} catch (err) {
				if (err instanceof PushRejected && attempt < 2) {
					log(t("progRemoteMoved"));
					// May throw MergeConflict, which bubbles to the UI.
					await this.fetchAndMerge(
						branch,
						result,
						log,
						skip,
						snapshot
					);
					continue;
				}
				if (err instanceof PushRejected) {
					throw new Error(t("errPushRejected"));
				}
				throw err;
			}
		}
	}

	/** Push the branch to origin, normalizing rejections to {@link PushRejected}. */
	private async doPush(branch: string): Promise<void> {
		const s = this.getSettings();
		let push;
		try {
			push = await git.push({
				...this.base(),
				remote: "origin",
				url: s.remoteUrl,
				ref: branch,
			});
		} catch (err) {
			if ((err as { code?: string })?.code === "PushRejectedError") {
				throw new PushRejected("non-fast-forward");
			}
			throw err;
		}
		if (!push.ok) {
			const refErrs = push.refs
				? Object.entries(push.refs)
						.filter(([, r]) => r && (r as { error?: string }).error)
						.map(
							([ref, r]) =>
								`${ref}: ${(r as { error?: string }).error}`
						)
				: [];
			const msg = refErrs.join("; ") || push.error || "push rejected";
			if (/fast-forward|non-fast|fetch first/i.test(msg)) {
				throw new PushRejected(msg);
			}
			throw new Error(msg);
		}
	}

	/**
	 * Set up Git in this vault: init if needed, link the remote, fetch, and (on a
	 * fresh repo with no local commits) check out the remote branch.
	 */
	async initialize(log: ProgressLog = () => {}): Promise<void> {
		return this.runExclusive(() => this.initializeInner(log));
	}

	private async initializeInner(log: ProgressLog): Promise<void> {
		const s = this.getSettings();
		const branch = s.branch || "main";
		try {
			if (!(await this.isRepo())) {
				log(t("progInit"));
				await git.init({
					fs: this.fs,
					dir: this.dir,
					defaultBranch: branch,
				});
			}

			log(t("progLinking"));
			await git.addRemote({
				fs: this.fs,
				dir: this.dir,
				remote: "origin",
				url: s.remoteUrl,
				force: true,
			});

			log(t("progFetching"));
			await git.fetch({
				...this.base(),
				remote: "origin",
				url: s.remoteUrl,
				ref: branch,
				singleBranch: true,
				tags: false,
				// Shallow + single-branch on the first fetch so we don't pull the
				// vault's entire history into memory on a phone (OOM risk). Later
				// fetches in fetchAndMerge omit `depth`, so isomorphic-git deepens
				// the shallow clone on demand when a merge needs older commits.
				depth: INITIAL_FETCH_DEPTH,
			});

			const remoteOid = await this.tryResolve(
				`refs/remotes/origin/${branch}`
			);
			const localOid = await this.tryResolve(branch);
			if (remoteOid && !localOid) {
				// Fresh repo: adopt the remote branch as our starting point.
				log(t("progCheckout"));
				await git.writeRef({
					fs: this.fs,
					dir: this.dir,
					ref: `refs/heads/${branch}`,
					value: remoteOid,
					force: true,
				});
				await git.checkout({
					fs: this.fs,
					dir: this.dir,
					ref: branch,
					force: true,
				});
			}
		} catch (err) {
			throw friendlyError(err);
		}
	}

	private async tryResolve(ref: string): Promise<string | undefined> {
		try {
			return await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
		} catch {
			return undefined;
		}
	}

	/**
	 * Stage adds/edits/deletes (excluding configured paths). When `only` is
	 * given, restrict staging to those paths; when `skip` is given, omit those
	 * paths (used to keep deselected local changes out of a merge commit).
	 * Returns the count staged.
	 */
	private async stageAll(
		only?: Set<string>,
		skip?: Set<string>
	): Promise<number> {
		const excluded = this.excludeMatcher();
		const matrix = await git.statusMatrix({
			fs: this.fs,
			dir: this.dir,
			filter: (filepath) => !excluded(filepath),
		});
		let changed = 0;
		for (const [filepath, head, workdir, stage] of matrix) {
			if (head === 1 && workdir === 1 && stage === 1) continue; // unchanged
			if (only && !only.has(filepath)) continue;
			if (skip && skip.has(filepath)) continue;
			if (workdir === 0) {
				await git.remove({ fs: this.fs, dir: this.dir, filepath });
			} else {
				await git.add({ fs: this.fs, dir: this.dir, filepath });
			}
			changed++;
		}
		return changed;
	}

	/** Decode a file's content at a given commit; null if absent there. */
	async readVersion(oid: string, filepath: string): Promise<string | null> {
		try {
			const { blob } = await git.readBlob({
				fs: this.fs,
				dir: this.dir,
				oid,
				filepath,
			});
			return new TextDecoder().decode(blob);
		} catch {
			return null;
		}
	}

	/** Current on-disk content (carries conflict markers after a merge). */
	async readWorkingFile(filepath: string): Promise<string> {
		const content = await this.fs.readFile(filepath, "utf8");
		return typeof content === "string"
			? content
			: new TextDecoder().decode(content);
	}

	/**
	 * Finish a conflicted merge: apply the user's per-file resolutions, stage
	 * the whole merged tree, create the two-parent merge commit, and push.
	 */
	async completeMerge(
		resolutions: Map<string, Resolution>,
		oursOid: string,
		theirsOid: string,
		branch: string,
		log: ProgressLog = () => {},
		skipPaths: string[] = [],
		restore: Map<string, Uint8Array | null> | null = null
	): Promise<SyncResult> {
		return this.runExclusive(() =>
			this.completeMergeInner(
				resolutions,
				oursOid,
				theirsOid,
				branch,
				log,
				skipPaths,
				restore
			)
		);
	}

	private async completeMergeInner(
		resolutions: Map<string, Resolution>,
		oursOid: string,
		theirsOid: string,
		branch: string,
		log: ProgressLog,
		skipPaths: string[],
		restore: Map<string, Uint8Array | null> | null
	): Promise<SyncResult> {
		log(t("progApplying"));
		for (const [filepath, res] of resolutions) {
			if (res.type === "manual") {
				await this.fs.writeFile(filepath, res.content);
			} else {
				const oid = res.type === "local" ? oursOid : theirsOid;
				const { blob } = await safeReadBlob(this.fs, this.dir, oid, filepath);
				if (blob === null) {
					// The chosen side deleted this file.
					await this.fs.unlink(filepath);
				} else {
					await this.fs.writeFile(filepath, blob);
				}
			}
		}

		// Stage resolved files + merge-brought files, but keep deselected local
		// changes out. Resolved conflict files are always staged, even if the
		// user had deselected them, since they're part of the merge.
		log(t("progStagingMerge"));
		const resolved = new Set(resolutions.keys());
		const skip = new Set(skipPaths.filter((p) => !resolved.has(p)));
		await this.stageAll(undefined, skip);

		log(t("progMergeCommit"));
		await git.commit({
			fs: this.fs,
			dir: this.dir,
			message: `Merge origin/${branch} into ${branch}`,
			author: this.author(),
			parent: [oursOid, theirsOid],
		});

		// Restore deselected edits the merge overwrote in the working tree.
		// Done before the push so it survives a push failure (mobile network
		// loss); a restore failure throws rather than dropping edits silently.
		if (restore) await this.restoreSnapshotSafely(restore);

		log(t("progPushing"));
		try {
			await this.doPush(branch);
		} catch (err) {
			if (err instanceof PushRejected) {
				throw new Error(t("errPushRejected"));
			}
			throw friendlyError(err);
		}

		return { committed: true, pulled: true, pushed: true, conflicts: [] };
	}

	/**
	 * Discard an in-progress conflicted merge, restoring the branch tip. If a
	 * snapshot of deselected files is given, re-apply it afterwards — the merge
	 * (and this checkout) overwrote those uncommitted edits in the working tree.
	 */
	async abortMerge(
		branch: string,
		snapshot: Map<string, Uint8Array | null> | null = null
	): Promise<void> {
		return this.runExclusive(() => this.abortMergeInner(branch, snapshot));
	}

	private async abortMergeInner(
		branch: string,
		snapshot: Map<string, Uint8Array | null> | null
	): Promise<void> {
		await git.checkout({
			fs: this.fs,
			dir: this.dir,
			ref: branch,
			force: true,
		});
		if (snapshot) await this.restoreSnapshotSafely(snapshot);
	}

	private commitMessage(): string {
		const s = this.getSettings();
		const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
		return (s.commitMessage || "vault sync {{date}}").replace(
			"{{date}}",
			stamp
		);
	}
}

/**
 * Convert a gitignore-ish glob to a RegExp tested against vault-relative paths.
 * `*` matches within a path segment, `**` across segments, a trailing `/`
 * matches a folder and everything under it, and a pattern without `/` matches
 * by basename at any depth.
 */
function globToRegExp(pattern: string): RegExp {
	let pat = pattern;
	const dirOnly = pat.endsWith("/");
	if (dirOnly) pat = pat.slice(0, -1);
	const anchored = pat.includes("/");

	// Tokenize char-by-char so literal spaces and regex specials in filenames
	// pass through safely, while *, **, **/ and ? get glob semantics.
	let body = "";
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i];
		if (c === "*") {
			if (pat[i + 1] === "*") {
				i++;
				if (pat[i + 1] === "/") {
					i++;
					body += "(?:.*/)?"; // **/ -> zero or more folders
				} else {
					body += ".*"; // ** -> anything incl. /
				}
			} else {
				body += "[^/]*"; // * -> within one segment
			}
		} else if (c === "?") {
			body += "[^/]";
		} else if (/[.+^${}()|[\]\\]/.test(c)) {
			body += "\\" + c;
		} else {
			body += c;
		}
	}

	// Always allow a trailing-path match so a bare name (e.g. "node_modules" or
	// ".obsidian") excludes the folder *and everything under it*, matching
	// gitignore semantics — not just an entry literally named that.
	const prefix = anchored ? "^" : "(^|/)";
	return new RegExp(`${prefix}${body}(/|$)`);
}

/** Internal marker for a non-fast-forward push rejection. */
class PushRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushRejected";
	}
}

/** Map low-level git/HTTP errors to a clear, actionable message. */
function friendlyError(err: unknown): Error {
	if (err instanceof MergeConflict) return err;
	const code = (err as { code?: string })?.code;
	const msg = String((err as Error)?.message ?? err);
	// Rate limiting also returns 403 — surface its real message, not "bad token".
	if (/rate limit/i.test(msg)) {
		return err instanceof Error ? err : new Error(msg);
	}
	if (
		/\b401\b|\b403\b|Unauthorized|Bad credentials|authentication|invalid.*token/i.test(
			msg
		) ||
		(code === "HttpError" && /\b40[13]\b/.test(msg))
	) {
		return new Error(t("errAuth"));
	}
	if (
		/network|fetch failed|Failed to fetch|ENOTFOUND|getaddrinfo|ECONNRESET|ETIMEDOUT|ERR_|socket|aborted|timed? ?out|timeout/i.test(
			msg
		) ||
		/^ERR_/.test(code ?? "")
	) {
		return new Error(t("errNetwork"));
	}
	if (/could not find|NotFoundError/i.test(msg) && /remote|ref/i.test(msg)) {
		return new Error(t("errNotFound"));
	}
	return err instanceof Error ? err : new Error(msg);
}

/** Read a blob's raw bytes at a commit; `{ blob: null }` if the path is absent. */
async function safeReadBlob(
	fs: GitFs,
	dir: string,
	oid: string,
	filepath: string
): Promise<{ blob: Uint8Array | null }> {
	try {
		const res = await git.readBlob({ fs, dir, oid, filepath });
		return { blob: res.blob };
	} catch {
		return { blob: null };
	}
}

/** Extract conflicted file paths from an isomorphic-git merge error, if any. */
function mergeConflictFiles(err: unknown): string[] | null {
	const e = err as { code?: string; data?: { filepaths?: string[] } };
	if (
		e?.code === "MergeConflictError" ||
		e?.code === "MergeNotSupportedError"
	) {
		return e.data?.filepaths ?? [];
	}
	return null;
}
