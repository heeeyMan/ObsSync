import * as git from "isomorphic-git";
import { DataAdapter, Platform } from "obsidian";
import { GitFs } from "./git-fs";
import { obsidianHttpClient } from "./git-http";
import type { GitSyncSettings } from "./settings";
import { t } from "./i18n";

/**
 * History depth pulled by every shallow fetch/clone. On mobile we keep the
 * clone permanently shallow so isomorphic-git never buffers the whole packfile
 * (the entire vault history) into RAM — that OOMs the mobile WebView on large
 * repos. 1 is enough to adopt/track the remote tip; a divergent merge only
 * needs the boundary commit as its base (see {@link DEEPEN_FETCH_DEPTH}).
 */
const SHALLOW_FETCH_DEPTH = 1;

/**
 * Fallback depth used once, on a shallow clone, when a merge fails because its
 * base isn't present locally (the remote advanced more than one commit past the
 * shared boundary, so depth:1 didn't fetch the real merge base). Deepening to
 * this many commits brings the base so the 3-way merge can complete; it's a
 * bounded, one-off cost rather than the full history. Desktop never hits this
 * path (it fetches full history).
 */
const DEEPEN_FETCH_DEPTH = 50;

/**
 * Total changed-byte budget that triggers the mobile chunked-push path. When a
 * single sync would otherwise stage a very large set of adds/edits, building one
 * packfile for it forces isomorphic-git to buffer every new object in the
 * WebView's heap at once — an OOM risk on mobile. Above this threshold we split
 * the changes into batches of (at most) this many bytes, committing + pushing
 * each batch so only one batch's objects ever live in memory.
 *
 * Desktop never chunks (it has plenty of heap and full history); see
 * {@link GitManager.shouldChunkPush}.
 */
const PUSH_CHUNK_THRESHOLD = 8 * 1024 * 1024;

/**
 * isomorphic-git fetch/clone options that control history depth. On mobile we
 * stay shallow + single-branch + no tags; on desktop we pull full history so
 * merges always have every possible base and behave like a normal clone.
 *
 * Pure (no `this`/Platform) so it can be unit-tested against a stubbed
 * `shallow` flag without an Obsidian runtime.
 */
export function depthOptions(
	shallow: boolean,
	depth: number = SHALLOW_FETCH_DEPTH
): { singleBranch: boolean; tags: boolean; depth?: number; relative?: boolean } {
	if (!shallow) {
		// Desktop: full history, but still skip tags and other branches — we
		// only ever sync a single configured branch.
		return { singleBranch: true, tags: false };
	}
	return { singleBranch: true, tags: false, depth, relative: false };
}

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
 * Narrowed view of isomorphic-git's `getRemoteInfo` result. Its own type
 * declares `refs` as `any`, so we re-type just the part we read (the advertised
 * branch heads) to keep the call site type-safe.
 */
interface RemoteInfo {
	refs?: { heads?: Record<string, string> };
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

	/**
	 * Patterns parsed from the repo's root `.gitignore`, cached so the
	 * synchronous {@link excludeMatcher} (called once per file inside a status
	 * scan) needn't re-read/parse the file. Refreshed once per public operation
	 * via {@link refreshGitignore}; `[]` means no `.gitignore` (or it's empty).
	 */
	private gitignorePatterns: string[] = [];

	constructor(
		adapter: DataAdapter,
		private readonly getSettings: () => GitSyncSettings
	) {
		this.fs = new GitFs(adapter);
	}

	/**
	 * Read + parse the repo's root `.gitignore` into {@link gitignorePatterns}.
	 *
	 * `excludeMatcher` is synchronous (it runs as a per-file `statusMatrix`
	 * filter), but the fs adapter is async, so we can't read inside the matcher.
	 * Instead each public entry point that scans status (`countChanges`,
	 * `listChanges`, `sync`, `completeMerge`) calls this once up front; the
	 * matcher then reads the cached patterns synchronously. Missing/empty file →
	 * empty list, so behavior degrades to excludePaths-only.
	 */
	private async refreshGitignore(): Promise<void> {
		const path = `${this.dir}.gitignore`;
		let raw: string;
		try {
			const content = await this.fs.readFile(path, "utf8");
			raw =
				typeof content === "string"
					? content
					: new TextDecoder().decode(content);
		} catch {
			// No .gitignore (or unreadable): behave as before — excludePaths only.
			this.gitignorePatterns = [];
			return;
		}
		this.gitignorePatterns = parseGitignore(raw);
	}

	/**
	 * On mobile, keep the clone/fetch shallow so isomorphic-git never buffers
	 * the whole packfile into the WebView's heap (OOM risk on large repos).
	 * Desktop pulls full history for robust, base-complete merges.
	 */
	private get shallow(): boolean {
		return Platform.isMobile;
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

	/**
	 * Run a mutating git operation, recovering once from a corrupt/unsupported
	 * `.git/index`.
	 *
	 * isomorphic-git only reads dircache v2; a `.git/index` written by system git
	 * in v3/v4 (index extensions) makes it throw "Unsupported dircache version".
	 * The index is a rebuildable cache over HEAD + the working tree — deleting it
	 * is safe in this plugin's model (objects/refs/history untouched), and the
	 * next statusMatrix/git.add in `fn` repopulates it in v2.
	 *
	 * Recovery happens INSIDE the inner method (callers pass an already-unlocked
	 * `fn`), so re-running never re-enters the public mutex and deadlocks. At most
	 * one rebuild+retry; a second failure propagates.
	 */
	private async withIndexRecovery<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (!isUnsupportedIndexError(err)) throw err;
			console.warn(
				"Git Vault Sync: .git/index in an unsupported format — rebuilding it"
			);
			await this.recoverIndex();
			// Retry exactly once. If it still fails with the same index error,
			// map it to a friendly "rebuilt — retry" message; any other failure
			// propagates as-is (syncInner/initializeInner already mapped theirs).
			try {
				return await fn();
			} catch (retryErr) {
				if (isUnsupportedIndexError(retryErr)) {
					throw friendlyError(retryErr);
				}
				throw retryErr;
			}
		}
	}

	/** Delete `.git/index` so the next staging op rebuilds it as v2. */
	private async recoverIndex(): Promise<void> {
		// dir is "/", so the index lives at "/.git/index"; GitFs.unlink normalizes
		// it to the vault-relative "·.git/index" and no-ops if already gone.
		await this.fs.unlink(`${this.dir}.git/index`);
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
	 * True when an `origin` remote with a non-empty URL is configured. A repo can
	 * exist (HEAD resolves) yet have no origin bound — e.g. `git init` ran but the
	 * remote was never linked — in which case the sync flow's `git.fetch` would
	 * fail (no refspec / a null URL → the `parseRemoteUrl` "null.startsWith"
	 * crash). We treat a missing/empty origin URL as "not ready".
	 */
	private async isOriginConfigured(): Promise<boolean> {
		try {
			const url: unknown = await git.getConfig({
				fs: this.fs,
				dir: this.dir,
				path: "remote.origin.url",
			});
			return typeof url === "string" && url.trim().length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Make sure the repo is initialized AND bound to origin before the sync flow
	 * runs any fetch/merge (which assume a ready repo). Idempotent: if both
	 * conditions already hold this is a no-op; otherwise it runs the same
	 * un-guarded {@link initializeInner} (init if needed + addRemote force + fetch
	 * + checkout) used by the public {@link initialize}.
	 *
	 * MUST be called from inside the mutex (it invokes the *Inner helper directly,
	 * never the public `initialize`, which would re-take the mutex and deadlock).
	 * Throws a localized {@link t} `errNoRemote` when no remote URL is set, so the
	 * user gets a clear message instead of an opaque null dereference.
	 */
	private async ensureInitialized(log: ProgressLog): Promise<void> {
		const ready = (await this.isRepo()) && (await this.isOriginConfigured());
		if (ready) return;
		const remoteUrl = (this.getSettings().remoteUrl || "").trim();
		if (!remoteUrl) throw new Error(t("errNoRemote"));
		// Un-guarded: we're already under runExclusive + withIndexRecovery.
		// initializeInner is idempotent and honors this.shallow internally.
		await this.initializeInner(log);
	}

	/**
	 * Verify remote URL + token + connectivity without touching the working
	 * tree. Returns the list of remote branch names.
	 */
	async testConnection(): Promise<string[]> {
		const s = this.getSettings();
		const info = (await git.getRemoteInfo({
			http: obsidianHttpClient,
			url: s.remoteUrl,
			onAuth: () => ({
				username: s.username || s.token,
				password: s.token,
			}),
		})) as RemoteInfo;
		const heads = info.refs?.heads;
		const branches = heads ? Object.keys(heads) : [];
		return branches;
	}

	/** Number of files that differ from HEAD, ignoring excluded paths. */
	async countChanges(): Promise<number> {
		await this.refreshGitignore();
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
		await this.refreshGitignore();
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

	/**
	 * Build a predicate matching excluded paths from BOTH the user's
	 * `excludePaths` setting AND the repo's root `.gitignore` (cached in
	 * {@link gitignorePatterns}, populated by {@link refreshGitignore} at the
	 * start of the current operation). A path is excluded if it matches any
	 * pattern from either source, so a single committed `.gitignore` excludes
	 * files on every device and stays consistent with other git clients.
	 */
	private excludeMatcher(): (path: string) => boolean {
		const settingPatterns = (this.getSettings().excludePaths || "")
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		const patterns = [...settingPatterns, ...this.gitignorePatterns];
		if (patterns.length === 0) return () => false;
		const regexes = patterns.map(globToRegExp);
		return (path) => regexes.some((re) => re.test(path));
	}

	private author() {
		const s = this.getSettings();
		return { name: s.authorName || "Git Vault Sync", email: s.authorEmail || "" };
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
		return this.runExclusive(() =>
			this.withIndexRecovery(() => this.syncInner(log, only))
		);
	}

	private async syncInner(
		log: ProgressLog,
		only?: string[]
	): Promise<SyncResult> {
		const branch = this.getSettings().branch || "main";
		// Load .gitignore once for this whole operation; excludeMatcher (sync)
		// reads the cached patterns for every staging/status scan below.
		await this.refreshGitignore();

		// On a fresh/unbound vault the rest of this method (fetch/merge) assumes a
		// ready repo and would crash inside isomorphic-git (e.g. parseRemoteUrl's
		// "null.startsWith"). Auto-initialize first — init + link origin + fetch +
		// checkout the remote tip — so the normal flow below runs incrementally.
		// Idempotent and un-guarded (we're already inside the mutex), so no deadlock.
		await this.ensureInitialized(log);

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

		let caught: Error | undefined;
		let isConflict = false;
		try {
			// On mobile, a very large changeset would build one giant packfile
			// (OOM risk). When that's the case, hand off to the chunked path,
			// which pulls first then commits + pushes in size-bounded batches so
			// only one batch's objects ever live in the WebView heap. Otherwise
			// run the normal single-commit flow below. shouldChunkPush is false
			// on desktop and on small changesets, so behavior is unchanged there.
			if (await this.shouldChunkPush(only, skip)) {
				await this.syncChunked(
					branch,
					result,
					log,
					only,
					skip,
					snapshot
				);
			} else {
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
				// MergeConflict carrying the snapshot; the resolver restores it.
				await this.fetchAndMerge(branch, result, log, skip, snapshot);

				// 3. Push, retrying once if the remote moved after our fetch.
				await this.pushLoop(branch, result, log, skip, snapshot);
			}
		} catch (err) {
			// An unsupported-index error must escape RAW so withIndexRecovery can
			// detect it (by message) and rebuild+retry. friendlyError would remap
			// it to the localized errIndexVersion text, which the detector won't
			// match — defeating recovery. Everything else is mapped here as usual.
			if (isUnsupportedIndexError(err)) {
				caught = err as Error;
			} else {
				caught = friendlyError(err);
				isConflict = caught instanceof MergeConflict;
			}
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
	 * Decide whether this sync should take the chunked-push path. True only when
	 * ALL of:
	 *  - we're on mobile (`this.shallow`) — desktop has heap + full history and
	 *    always uses the single-commit flow;
	 *  - the changeset is non-empty (nothing to chunk otherwise);
	 *  - the total changed-byte size exceeds {@link PUSH_CHUNK_THRESHOLD}.
	 *
	 * Honors `only`/`skip` so the size is measured over exactly the paths the
	 * normal flow would stage. Deletes contribute ~0 bytes (no new blob), so a
	 * pure-delete sync never trips the threshold.
	 */
	private async shouldChunkPush(
		only: string[] | undefined,
		skip: string[]
	): Promise<boolean> {
		if (!this.shallow) return false;
		const changes = await this.stageableChanges(only, skip);
		if (changes.length === 0) return false;
		let total = 0;
		for (const c of changes) {
			total += c.size;
			if (total > PUSH_CHUNK_THRESHOLD) return true;
		}
		return false;
	}

	/**
	 * Chunked-push sync (mobile, large changeset). Pulls the remote FIRST so our
	 * batch commits land on the current remote tip and each push is a plain
	 * fast-forward; then commits + pushes the change in size-bounded batches so
	 * isomorphic-git only ever buffers one batch's objects.
	 *
	 * Ordering rationale: there are no local commits yet when we fetch+merge, so
	 * a divergent remote simply fast-forwards (no conflict possible from our
	 * side). A genuine remote/remote conflict can still arise only if the remote
	 * conflicts with *already-committed* local history — that path is identical
	 * to the normal flow and still throws {@link MergeConflict} for the resolver
	 * (snapshot/skip carried through unchanged).
	 *
	 * `skip` (deselected) and excluded paths are never added to any batch, and
	 * `snapshot` restores their merge-clobbered edits via the caller's finally.
	 * Each batch pushes through {@link pushLoop}, so a remote that moves between
	 * batches triggers the usual re-fetch+merge+retry.
	 */
	private async syncChunked(
		branch: string,
		result: SyncResult,
		log: ProgressLog,
		only: string[] | undefined,
		skip: string[],
		snapshot: Map<string, Uint8Array | null> | null
	): Promise<void> {
		// 1. Pull remote first (onto a tip with no new local commits) so our
		// batch commits append cleanly. May throw MergeConflict if the remote
		// conflicts with existing committed history — same contract as usual.
		await this.fetchAndMerge(branch, result, log, skip, snapshot);

		// 2. Recompute the changeset AFTER the merge (the checkout may have
		// rewritten the working tree), then split into size-bounded batches.
		const changes = await this.stageableChanges(only, skip);
		if (changes.length === 0) {
			// The merge already absorbed everything (or it was all deselected).
			await this.pushLoop(branch, result, log, skip, snapshot);
			return;
		}
		const batches = chunkChanges(changes, PUSH_CHUNK_THRESHOLD);

		// 3. Commit + push each batch. Staging is restricted to the batch's
		// paths, so each commit (and its push packfile) carries only that batch.
		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i];
			const batchPaths = new Set(batch.map((c) => c.path));
			log(
				t("progPushingBatch", {
					n: i + 1,
					total: batches.length,
				})
			);
			const staged = await this.stageAll(batchPaths);
			if (staged > 0) {
				await git.commit({
					fs: this.fs,
					dir: this.dir,
					message: this.commitMessage(),
					author: this.author(),
				});
				result.committed = true;
			}
			// Push this batch (re-fetch+merge+retry on a non-fast-forward).
			await this.pushLoop(branch, result, log, skip, snapshot);
		}
	}

	/**
	 * The adds/edits/deletes a sync would stage, with each path's on-disk byte
	 * size (deletes/absent → 0). Mirrors {@link stageAll}'s selection: honors the
	 * exclude matcher, the optional `only` allow-list, and the `skip` deny-list,
	 * so chunk sizing and chunk membership match what actually gets committed.
	 */
	private async stageableChanges(
		only: string[] | undefined,
		skip: string[]
	): Promise<{ path: string; size: number }[]> {
		const excluded = this.excludeMatcher();
		const onlySet = only ? new Set(only) : undefined;
		const skipSet = new Set(skip);
		const matrix = await git.statusMatrix({
			fs: this.fs,
			dir: this.dir,
			filter: (filepath) => !excluded(filepath),
		});
		const out: { path: string; size: number }[] = [];
		for (const [filepath, head, workdir, stage] of matrix) {
			if (head === 1 && workdir === 1 && stage === 1) continue; // unchanged
			if (onlySet && !onlySet.has(filepath)) continue;
			if (skipSet.has(filepath)) continue;
			let size = 0;
			if (workdir !== 0) {
				// An add/edit: weigh it by its current on-disk size. A deleted
				// file (workdir === 0) is absent, so it stays at 0 bytes.
				try {
					size = (await this.fs.stat(filepath)).size;
				} catch {
					size = 0;
				}
			}
			out.push({ path: filepath, size });
		}
		return out;
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
		// Mobile fetches stay shallow (depth:1) so we only pull the branch tip,
		// never the whole history; desktop fetches full history.
		await git.fetch({
			...this.base(),
			remote: "origin",
			url: s.remoteUrl,
			ref: branch,
			...depthOptions(this.shallow),
		});

		const remoteRef = `refs/remotes/origin/${branch}`;
		const remoteOid = await this.tryResolve(remoteRef);
		const localOid = await this.tryResolve(branch);
		if (!remoteOid || !localOid || localOid === remoteOid) return;

		log(t("progMerging"));
		await this.mergeRemote(
			branch,
			remoteRef,
			localOid,
			remoteOid,
			result,
			log,
			skip,
			snapshot,
			// On mobile, allow a single deepening retry if the shallow clone is
			// missing the merge base; desktop already has full history.
			this.shallow
		);
	}

	/**
	 * Merge `remoteRef` into `branch`, checking out the merged tree on success.
	 *
	 * On a shallow clone the merge base is normally the shallow boundary commit
	 * (the shared parent), so depth:1 is enough. But if the remote advanced more
	 * than one commit past that boundary, depth:1 never fetched the real base and
	 * isomorphic-git can't do a 3-way merge — it throws MergeNotSupportedError
	 * (NOT a real conflict). When `allowDeepen` is set we deepen the fetch once
	 * and retry; a genuine MergeConflictError is re-thrown as {@link MergeConflict}
	 * for the resolver, untouched. Verified in the Node sandbox.
	 */
	private async mergeRemote(
		branch: string,
		remoteRef: string,
		localOid: string,
		remoteOid: string,
		result: SyncResult,
		log: ProgressLog,
		skip: string[],
		snapshot: Map<string, Uint8Array | null> | null,
		allowDeepen: boolean
	): Promise<void> {
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
			// Missing merge base on a shallow clone: deepen once, then retry.
			if (allowDeepen && isMissingBaseError(err)) {
				log(t("progDeepening"));
				const s = this.getSettings();
				await git.fetch({
					...this.base(),
					remote: "origin",
					url: s.remoteUrl,
					ref: branch,
					...depthOptions(true, DEEPEN_FETCH_DEPTH),
				});
				// Retry without allowing a further deepen: if the base is still
				// missing the divergence is deeper than DEEPEN_FETCH_DEPTH, and
				// we surface a clear, localized error rather than looping.
				return this.mergeRemote(
					branch,
					remoteRef,
					localOid,
					remoteOid,
					result,
					log,
					skip,
					snapshot,
					false
				);
			}
			// A missing base that we couldn't (or weren't allowed to) deepen past:
			// explain it instead of leaking the raw "Merges with conflicts are not
			// supported" internals, and never mistake it for a resolvable conflict.
			// Checked before mergeConflictFiles, which also matches this error code.
			if (isMissingBaseError(err)) {
				throw new Error(t("errShallowMerge"));
			}
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
		return this.runExclusive(() =>
			this.withIndexRecovery(() => this.initializeInner(log))
		);
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
			// Mobile clones shallow (depth:1, single-branch, no tags) so we never
			// buffer the vault's whole history into the WebView heap (OOM risk).
			// Every later fetch in fetchAndMerge stays shallow too, deepening only
			// as a one-off fallback when a divergent merge needs an older base.
			// Desktop pulls full history for base-complete, robust merges.
			await git.fetch({
				...this.base(),
				remote: "origin",
				url: s.remoteUrl,
				ref: branch,
				...depthOptions(this.shallow),
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
			// Let an unsupported-index error escape raw so withIndexRecovery can
			// detect it by message and rebuild+retry (friendlyError would remap it).
			if (isUnsupportedIndexError(err)) throw err;
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
			this.withIndexRecovery(() =>
				this.completeMergeInner(
					resolutions,
					oursOid,
					theirsOid,
					branch,
					log,
					skipPaths,
					restore
				)
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
		// stageAll below relies on excludeMatcher; load .gitignore first.
		await this.refreshGitignore();
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
 * Parse the text of a `.gitignore` into the same glob patterns
 * {@link globToRegExp} consumes, so `.gitignore` semantics match `excludePaths`.
 *
 * Per line: trim, drop blanks and `#` comments. Lines beginning with `!`
 * (negations / re-includes) are SKIPPED — re-include is not supported yet, but
 * we never crash on them. Everything else is forwarded verbatim to the existing
 * glob→RegExp converter (a trailing `/` keeps folder semantics, a `/`-less name
 * matches at any depth, `*`/`**` behave as in `excludePaths`).
 */
function parseGitignore(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue; // blank
		if (trimmed.startsWith("#")) continue; // comment
		if (trimmed.startsWith("!")) continue; // negation: unsupported, skip
		out.push(trimmed);
	}
	return out;
}

/**
 * Split a list of sized changes into batches whose accumulated byte size stays
 * at or below `limit`. Pure (no `this`) so it's unit-testable.
 *
 * Greedy first-fit in list order: keep adding to the current batch until the
 * next file would push it over `limit`, then start a new batch. A file LARGER
 * than `limit` becomes its own single-item batch — a blob can't be split, so
 * that lone batch necessarily exceeds the limit (a known, unavoidable cap: one
 * huge file still builds one packfile for itself). An empty input yields no
 * batches; a single small change yields exactly one batch.
 */
export function chunkChanges<T extends { size: number }>(
	changes: T[],
	limit: number
): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	let currentSize = 0;
	for (const change of changes) {
		// Start a new batch when the current one is non-empty and adding this
		// file would exceed the limit. (An over-limit file on an empty batch
		// still goes in alone — see the doc comment.)
		if (current.length > 0 && currentSize + change.size > limit) {
			batches.push(current);
			current = [];
			currentSize = 0;
		}
		current.push(change);
		currentSize += change.size;
	}
	if (current.length > 0) batches.push(current);
	return batches;
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
	// If an unsupported-index error survived auto-recovery (rebuild + one retry
	// both failed), tell the user it was rebuilt and to retry, rather than
	// surfacing the raw "dircache version" internals.
	if (isUnsupportedIndexError(err)) {
		return new Error(t("errIndexVersion"));
	}
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

/**
 * True when isomorphic-git failed to parse `.git/index` because it was written
 * in a dircache version it doesn't support (v3/v4 from system git). The message
 * looks like "Unsupported dircache version: 3"; match it loosely since the
 * exact wording/code (often InternalError) can vary across versions.
 */
function isUnsupportedIndexError(err: unknown): boolean {
	const msg = String((err as Error)?.message ?? err);
	return /unsupported dircache version|dircache/i.test(msg);
}

/**
 * True when a merge failed because the merge base isn't present locally — the
 * symptom of a too-shallow clone whose remote advanced past the shared
 * boundary. isomorphic-git reports this as `MergeNotSupportedError` ("Merges
 * with conflicts are not supported yet"), distinct from a real
 * `MergeConflictError`. Match the code (with a message fallback) so a deepening
 * retry can recover. Verified in the Node sandbox (deep-divergence scenario).
 */
function isMissingBaseError(err: unknown): boolean {
	const e = err as { code?: string; message?: string };
	if (e?.code === "MergeNotSupportedError") return true;
	return /merges with conflicts are not supported/i.test(
		String(e?.message ?? "")
	);
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
