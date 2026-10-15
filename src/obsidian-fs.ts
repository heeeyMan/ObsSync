import { DataAdapter, DataWriteOptions, FileSystemAdapter, TFile, Vault } from "obsidian";

declare function require(module: string): {
	promises: { rmdir(path: string): Promise<void> };
};

/** Notify Obsidian directly when sync changes a known note, so open
 * editors and the cached vault content follow the incoming version. Hidden
 * Git metadata and newly created paths still use the underlying adapter.
 */
export function createSyncAdapter(vault: Vault): DataAdapter {
	const adapter = vault.adapter;
	const writes = {
		async rmdir(path: string, recursive: boolean) {
			// Obsidian 1.14.4's desktop adapter delegates to fs.rm. With
			// recursive:false that rejects even EMPTY directories (ERR_FS_EISDIR).
			// Use the atomic empty-only primitive instead; never fall back to
			// recursive removal, which could delete a concurrently created note.
			// Load Node only for the desktop adapter, never on mobile.
			if (!recursive && adapter instanceof FileSystemAdapter) {
				await require("fs").promises.rmdir(adapter.getFullPath(path));
			} else {
				await adapter.rmdir(path, recursive);
			}
		},
		async write(path: string, data: string, options?: DataWriteOptions) {
			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await vault.modify(file, data, options);
			else await adapter.write(path, data, options);
		},
		async writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions) {
			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await vault.modifyBinary(file, data, options);
			else await adapter.writeBinary(path, data, options);
		},
		async remove(path: string) {
			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await vault.delete(file);
			else await adapter.remove(path);
		},
	};
	return new Proxy(adapter, {
		get(target, key) {
			if (key === "write" || key === "writeBinary" || key === "remove" || key === "rmdir") return writes[key];
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
