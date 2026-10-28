import type { DataAdapter } from "obsidian";
import { gitBlobSha, Sha1 } from "./github-sync";
import { CHUNK_BYTES, downloadInChunks } from "./chunked-download";
import type { Diagnose } from "./sync-diagnostics";
import { t } from "./i18n";

export interface ChunkedPull {
	path: string; commit: string; sha: string; size: number; localSha?: string;
}
export interface LargeFileSync {
	threshold: number;
	hash(path: string, size: number): Promise<string>;
	pull(file: ChunkedPull): Promise<void>;
}

/** Local resource fetch only, never a GitHub request. Public DataAdapter has no
 * ranged read API. Unlike readBinary(), a resource response can be consumed with
 * backpressure on Android. No whole-file fallback if the host cannot stream.
 */
export async function hashLocalFile(adapter: DataAdapter, path: string, size: number): Promise<string> {
	if (size <= CHUNK_BYTES) return gitBlobSha(new Uint8Array(await adapter.readBinary(path)));
	const before = await adapter.stat(path);
	if (!before || before.size !== size) throw new Error(t("errChunkLocalChanged"));
	const response = await fetch(adapter.getResourcePath(path), { cache: "no-store" });
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error(t("errChunkLocalStream"));
	}
	const hash = new Sha1();
	hash.update(new TextEncoder().encode(`blob ${size}\0`));
	const reader = response.body.getReader();
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > size) throw new Error(t("errChunkLocalChanged"));
			for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
				hash.update(value.subarray(offset, offset + CHUNK_BYTES));
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		}
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	const after = await adapter.stat(path);
	if (total !== size || !after || after.size !== before.size || after.mtime !== before.mtime || after.ctime !== before.ctime)
		throw new Error(t("errChunkLocalChanged"));
	return hash.hex();
}

function validPath(path: unknown): path is string {
	return typeof path === "string" && !!path && !path.includes("\\") && !path.includes("\0") &&
		path.split("/").every(p => !!p && p !== "." && p !== "..");
}

/** Single-file transaction under the plugin's excluded directory. The old file
 * is retained until a verified staged file has been installed. Recovery runs
 * BEFORE local scanning so a crash in the rename window is not a local deletion.
 */
export class ChunkedSync implements LargeFileSync {
	readonly threshold = CHUNK_BYTES;
	private readonly part: string;
	private readonly backup: string;
	private readonly journal: string;
	constructor(private opts: {
		adapter: DataAdapter; dir: string; owner: string; repo: string; token: string;
		excluded: (path: string) => boolean; diagnose: Diagnose;
		onProgress?: (bytes: number, total: number) => void;
	}) {
		this.part = `${opts.dir}/pull.part`;
		this.backup = `${opts.dir}/previous.bin`;
		this.journal = `${opts.dir}/transaction.json`;
	}
	hash(path: string, size: number): Promise<string> { return hashLocalFile(this.opts.adapter, path, size); }
	private async removeIfPresent(path: string): Promise<void> {
		if (await this.opts.adapter.exists(path)) await this.opts.adapter.remove(path);
	}
	private async mkdirs(path: string): Promise<void> {
		let dir = "";
		for (const part of path.split("/").slice(0, -1)) {
			dir = dir ? `${dir}/${part}` : part;
			if (!(await this.opts.adapter.exists(dir))) await this.opts.adapter.mkdir(dir);
		}
	}
	async recover(): Promise<void> {
		const { adapter, diagnose, excluded } = this.opts;
		if (!(await adapter.exists(this.journal))) {
			if (await adapter.exists(this.backup)) throw new Error(t("errChunkRecovery"));
			await this.removeIfPresent(this.part);
			return;
		}
		await diagnose({ stage: "pull-recovery" });
		const tx = JSON.parse(await adapter.read(this.journal)) as { path: string; sha: string };
		if (!validPath(tx.path) || excluded(tx.path) || !/^[a-f0-9]{40}$/.test(tx.sha))
			throw new Error(t("errChunkRecovery"));
		if (await adapter.exists(this.backup)) {
			if (!(await adapter.exists(tx.path))) {
				await this.mkdirs(tx.path);
				await adapter.rename(this.backup, tx.path);
			} else {
				const stat = await adapter.stat(tx.path);
				// Never overwrite a new edit or discard its backup during recovery.
				if (!stat || await this.hash(tx.path, stat.size) !== tx.sha) throw new Error(t("errChunkRecovery"));
				await adapter.remove(this.backup);
			}
		}
		await this.removeIfPresent(this.part);
		await adapter.remove(this.journal);
		await diagnose({ stage: "pull-recovered" });
	}
	async pull(file: ChunkedPull): Promise<void> {
		const { adapter, dir, owner, repo, token, diagnose, onProgress, excluded } = this.opts;
		if (!validPath(file.path) || excluded(file.path)) throw new Error(t("errChunkRecovery"));
		await this.recover();
		await this.mkdirs(this.part);
		try {
			try {
				await downloadInChunks({ ...file, owner, repo, token, adapter, destination: this.part,
					diagnose, onProgress, keepFile: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				const known = ["INVALID_METADATA", "INVALID_PATH", "DESTINATION_EXISTS", "RANGE_UNSUPPORTED", "RANGE_LENGTH_MISMATCH", "BLOB_HASH_MISMATCH", "DISK_SIZE_MISMATCH"];
				const code = known.includes(message) ? message : "TRANSPORT_OR_STORAGE";
				await diagnose({ stage: "pull-transfer-failed", file: file.sha, code });
				throw new Error(t("errChunkTransfer", { code }));
			}
			await diagnose({ stage: "pull-verify-disk", file: file.sha, total: file.size });
			if (await this.hash(this.part, file.size) !== file.sha) throw new Error(t("errChunkIntegrity"));
			await diagnose({ stage: "pull-check-local", file: file.sha, total: file.size });
			const current = await adapter.stat(file.path);
			if (file.localSha === undefined ? !!current : !current || await this.hash(file.path, current.size) !== file.localSha)
				throw new Error(t("errChunkLocalChanged"));
			await this.mkdirs(file.path);
			// Finish the journal write before moving any user file. A torn pending
			// write is harmless; only the renamed journal permits the swap.
			await adapter.write(`${dir}/transaction.pending`, JSON.stringify({ path: file.path, sha: file.sha }));
			await adapter.rename(`${dir}/transaction.pending`, this.journal);
			await diagnose({ stage: "pull-install", file: file.sha, total: file.size });
			if (current) {
				await adapter.rename(file.path, this.backup);
				const moved = await adapter.stat(this.backup);
				if (!moved || await this.hash(this.backup, moved.size) !== file.localSha)
					throw new Error(t("errChunkLocalChanged"));
			}
			if (await adapter.exists(file.path)) throw new Error(t("errChunkLocalChanged"));
			await adapter.rename(this.part, file.path);
			await this.removeIfPresent(this.backup);
			await adapter.remove(this.journal);
			await diagnose({ stage: "pull-installed", file: file.sha, total: file.size });
		} catch (error) {
			// Restore a displaced original only if its target is still absent. On
			// ambiguous recovery, retain both copies and stop rather than overwrite.
			await this.recover();
			throw error;
		}
	}
}
