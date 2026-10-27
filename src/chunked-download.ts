import { DataAdapter, requestUrl } from "obsidian";
import { Sha1 } from "./github-sync";
import type { Diagnose } from "./sync-diagnostics";

const CHUNK_BYTES = 1024 * 1024;

/** Experimental, isolated from sync. Raw endpoint supports Range; Git Blobs does not.
 * requestUrl bypasses CORS but buffers the response: a server ignoring Range can
 * still allocate a whole file before we can reject it. No whole-file fallback.
 * Destination must be a disposable, plugin-owned path, never a user's note.
 */
export async function downloadInChunks(opts: {
	owner: string; repo: string; commit: string; path: string; sha: string;
	size: number; token: string; destination: string; adapter: DataAdapter;
	diagnose: Diagnose;
}): Promise<void> {
	const { adapter, destination, diagnose, size } = opts;
	if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{40}$/.test(opts.sha) ||
		!/^[a-f0-9]{40}$/.test(opts.commit)) throw new Error("INVALID_METADATA");
	// Encoding path components preserves slashes but cannot protect dot segments.
	if (opts.path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("INVALID_PATH");
	if (await adapter.exists(destination)) throw new Error("DESTINATION_EXISTS");
	const url = `https://raw.githubusercontent.com/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/${opts.commit}/${opts.path.split("/").map(encodeURIComponent).join("/")}`;
	const sha = new Sha1();
	sha.update(new TextEncoder().encode(`blob ${size}\0`));
	await diagnose({ stage: "chunk-create", file: opts.sha, total: size });
	await adapter.writeBinary(destination, new ArrayBuffer(0));
	try {
		for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
			const end = Math.min(offset + CHUNK_BYTES, size) - 1;
			await diagnose({ stage: "chunk-request", file: opts.sha, bytes: offset, total: size });
			// Scoped lifetime: response and bytes are released before the next request.
			await (async () => {
				const response = await requestUrl({ url, method: "GET", throw: false,
					headers: { Authorization: `Bearer ${opts.token}`, Range: `bytes=${offset}-${end}` } });
				await diagnose({ stage: "chunk-response", status: response.status, bytes: offset, total: size });
				const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
				if (response.status !== 206 || headers["content-range"] !== `bytes ${offset}-${end}/${size}`)
					throw new Error("RANGE_UNSUPPORTED");
				const bytes = new Uint8Array(response.arrayBuffer);
				if (bytes.byteLength !== end - offset + 1) throw new Error("RANGE_LENGTH_MISMATCH");
				sha.update(bytes);
				await diagnose({ stage: "chunk-append", bytes: offset, total: size });
				await adapter.appendBinary(destination, response.arrayBuffer);
			})();
			await diagnose({ stage: "chunk-written", bytes: end + 1, total: size });
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		await diagnose({ stage: "chunk-verify", total: size });
		if (sha.hex() !== opts.sha) throw new Error("BLOB_HASH_MISMATCH");
		if ((await adapter.stat(destination))?.size !== size) throw new Error("DISK_SIZE_MISMATCH");
		await diagnose({ stage: "chunk-complete", file: opts.sha, bytes: size, total: size });
	} finally {
		// Test bytes are never promoted into the vault or the sync baseline.
		if (await adapter.exists(destination)) await adapter.remove(destination);
	}
}
