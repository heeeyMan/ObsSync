import { DataAdapter } from "obsidian";

/** Git tracks files, so remove empty ancestors left behind by a deletion.
 * Never prune the vault root or hidden metadata/configuration directories.
 * Non-recursive removal also protects files created after the listing.
 */
export async function removeVaultFile(adapter: DataAdapter, path: string): Promise<void> {
	if (await adapter.exists(path)) await adapter.remove(path);
	const segments = path.split("/");
	segments.pop();
	while (segments.length > 0) {
		if (segments.some((segment) => segment.startsWith("."))) return;
		const parent = segments.join("/");
		if (!(await adapter.exists(parent))) {
			segments.pop();
			continue;
		}
		const listing = await adapter.list(parent);
		if (listing.files.length || listing.folders.length) return;
		await adapter.rmdir(parent, false);
		segments.pop();
	}
}
