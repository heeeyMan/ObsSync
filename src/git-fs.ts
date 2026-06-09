import { DataAdapter } from "obsidian";

/**
 * Bridges Obsidian's vault {@link DataAdapter} to the `fs` interface that
 * isomorphic-git expects. isomorphic-git uses the promise-style API, so we
 * expose every method under a `promises` object (see {@link GitFs.promises}).
 *
 * Paths arrive from isomorphic-git rooted at the configured `dir` ("/"), so we
 * strip the leading slash to get vault-relative paths the adapter understands.
 */
function err(code: string, message: string): NodeJS.ErrnoException {
	const e = new Error(message) as NodeJS.ErrnoException;
	e.code = code;
	return e;
}

function normalize(path: string): string {
	let p = path.replace(/\\/g, "/");
	while (p.startsWith("/")) p = p.slice(1);
	if (p.endsWith("/")) p = p.slice(0, -1);
	// iOS/HFS+ hands back filenames in Unicode NFD (decomposed) form, while
	// desktop and Git store the bytes as typed (typically NFC). Without
	// normalizing, a name like "мой"/"café" looks like two different paths
	// across platforms, producing phantom delete+add commits and duplicates.
	// Canonicalize every path to NFC so statusMatrix and the exclude matcher
	// compare like with like regardless of which device wrote the file.
	return p.normalize("NFC");
}

function basename(path: string): string {
	const p = normalize(path);
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}

class StatLike {
	constructor(
		private readonly _isDir: boolean,
		readonly size: number,
		readonly mtimeMs: number,
		readonly ctimeMs: number
	) {}

	readonly ino = 0;
	readonly uid = 1;
	readonly gid = 1;
	readonly dev = 1;
	get mode(): number {
		return this._isDir ? 0o40000 : 0o100644;
	}
	get type(): string {
		return this._isDir ? "dir" : "file";
	}
	isFile(): boolean {
		return !this._isDir;
	}
	isDirectory(): boolean {
		return this._isDir;
	}
	isSymbolicLink(): boolean {
		return false;
	}
}

export class GitFs {
	readonly promises: GitFs;

	constructor(private readonly adapter: DataAdapter) {
		this.promises = this;
	}

	async readFile(
		path: string,
		options?: { encoding?: string } | string
	): Promise<string | Uint8Array> {
		const p = normalize(path);
		const encoding =
			typeof options === "string" ? options : options?.encoding;
		if (!(await this.adapter.exists(p))) {
			throw err("ENOENT", `ENOENT: no such file, open '${p}'`);
		}
		if (encoding === "utf8" || encoding === "utf-8") {
			return await this.adapter.read(p);
		}
		const buf = await this.adapter.readBinary(p);
		return new Uint8Array(buf);
	}

	async writeFile(
		path: string,
		data: string | Uint8Array,
		_options?: unknown
	): Promise<void> {
		const p = normalize(path);
		await this.ensureParent(p);
		if (typeof data === "string") {
			await this.adapter.write(p, data);
		} else {
			const ab = data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.byteLength
			) as ArrayBuffer;
			await this.adapter.writeBinary(p, ab);
		}
	}

	async unlink(path: string): Promise<void> {
		const p = normalize(path);
		if (await this.adapter.exists(p)) {
			await this.adapter.remove(p);
		}
	}

	async readdir(path: string): Promise<string[]> {
		const p = normalize(path);
		if (p !== "" && !(await this.adapter.exists(p))) {
			throw err("ENOENT", `ENOENT: no such dir, scandir '${p}'`);
		}
		const listing = await this.adapter.list(p === "" ? "/" : p);
		return [...listing.files, ...listing.folders].map(basename);
	}

	async mkdir(path: string, _options?: unknown): Promise<void> {
		const p = normalize(path);
		if (await this.adapter.exists(p)) return;
		await this.ensureParent(p);
		await this.adapter.mkdir(p);
	}

	async rmdir(path: string): Promise<void> {
		const p = normalize(path);
		if (await this.adapter.exists(p)) {
			await this.adapter.rmdir(p, true);
		}
	}

	async stat(path: string): Promise<StatLike> {
		const p = normalize(path);
		const s = await this.adapter.stat(p === "" ? "/" : p);
		if (!s) {
			throw err("ENOENT", `ENOENT: no such file, stat '${p}'`);
		}
		return new StatLike(
			s.type === "folder",
			s.size ?? 0,
			s.mtime ?? 0,
			s.ctime ?? 0
		);
	}

	async lstat(path: string): Promise<StatLike> {
		return this.stat(path);
	}

	// Vaults don't carry real symlinks; stub these so isomorphic-git can probe.
	async readlink(path: string): Promise<string> {
		throw err("EINVAL", `EINVAL: not a symlink, readlink '${path}'`);
	}

	async symlink(): Promise<void> {
		throw err("ENOSYS", "symlink is not supported in an Obsidian vault");
	}

	/**
	 * Ensure every ancestor directory of `p` exists, creating the whole chain
	 * top-down. A checkout into a deeply nested new folder (a/b/c/d/file.md
	 * where a/b/c don't yet exist) would otherwise fail on the missing
	 * intermediate levels.
	 */
	private async ensureParent(p: string): Promise<void> {
		const i = p.lastIndexOf("/");
		if (i <= 0) return;
		const parent = p.slice(0, i);
		const segments = parent.split("/");
		let prefix = "";
		for (const seg of segments) {
			if (!seg) continue;
			prefix = prefix ? `${prefix}/${seg}` : seg;
			if (!(await this.adapter.exists(prefix))) {
				await this.adapter.mkdir(prefix);
			}
		}
	}
}
