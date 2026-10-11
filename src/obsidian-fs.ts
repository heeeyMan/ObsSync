import { DataAdapter, DataWriteOptions, TFile, Vault } from "obsidian";

/** Notify Obsidian directly when sync changes a known note, so open
 * editors and the cached vault content follow the incoming version. Hidden
 * Git metadata and newly created paths still use the underlying adapter.
 */
export function createSyncAdapter(vault: Vault): DataAdapter {
	const adapter = vault.adapter;
	const writes = {
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
			if (key === "write" || key === "writeBinary" || key === "remove") return writes[key];
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
