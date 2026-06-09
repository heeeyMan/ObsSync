import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { ChangeEntry, GitManager } from "./git";

const STATUS_LABEL: Record<ChangeEntry["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
};

/**
 * Commit-preview screen: lists everything a sync would commit, with a checkbox
 * per file so the user can drop items, then syncs the selected subset.
 */
export class ReviewModal extends Modal {
	private entries: ChangeEntry[] = [];
	private selected = new Set<string>();
	private syncButton?: ButtonComponent;

	constructor(
		app: App,
		private readonly git: GitManager,
		private readonly onSync: (paths: string[]) => void
	) {
		super(app);
	}

	async onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText("Review changes");

		const loading = contentEl.createEl("p", { text: "Loading changes…" });
		try {
			this.entries = await this.git.listChanges();
		} catch (err) {
			loading.setText(`Failed to read changes: ${(err as Error).message}`);
			return;
		}
		loading.remove();

		if (this.entries.length === 0) {
			contentEl.createEl("p", { text: "Nothing to commit — up to date." });
			new Setting(contentEl).addButton((b) =>
				b.setButtonText("Close").onClick(() => this.close())
			);
			return;
		}

		for (const e of this.entries) this.selected.add(e.path);

		new Setting(contentEl)
			.setName(`${this.entries.length} changed file(s)`)
			.addExtraButton((b) =>
				b
					.setIcon("check-square")
					.setTooltip("Select all")
					.onClick(() => this.setAll(true))
			)
			.addExtraButton((b) =>
				b
					.setIcon("square")
					.setTooltip("Select none")
					.onClick(() => this.setAll(false))
			);

		const list = contentEl.createDiv({ cls: "obssync-review-list" });
		for (const e of this.entries) {
			this.renderRow(list, e);
		}

		new Setting(contentEl)
			.addButton((b) => {
				this.syncButton = b;
				b.setCta().onClick(() => {
					const paths = [...this.selected];
					this.close();
					this.onSync(paths);
				});
			})
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => this.close())
			);
		this.updateSyncButton();
	}

	private renderRow(parent: HTMLElement, entry: ChangeEntry) {
		const row = parent.createDiv({ cls: "obssync-review-row" });
		const checkbox = row.createEl("input", { type: "checkbox" });
		checkbox.checked = true;
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selected.add(entry.path);
			else this.selected.delete(entry.path);
			this.updateSyncButton();
		});
		row.dataset.path = entry.path;
		row.createSpan({
			cls: `obssync-badge obssync-badge--${entry.status}`,
			text: STATUS_LABEL[entry.status],
		});
		row.createSpan({ cls: "obssync-review-path", text: entry.path });
		row.addEventListener("click", (evt) => {
			if (evt.target === checkbox) return;
			checkbox.checked = !checkbox.checked;
			checkbox.dispatchEvent(new Event("change"));
		});
	}

	private setAll(value: boolean) {
		this.selected.clear();
		if (value) this.entries.forEach((e) => this.selected.add(e.path));
		this.contentEl
			.querySelectorAll<HTMLInputElement>(".obssync-review-row input")
			.forEach((cb) => (cb.checked = value));
		this.updateSyncButton();
	}

	private updateSyncButton() {
		const n = this.selected.size;
		this.syncButton
			?.setButtonText(`Sync ${n} selected`)
			.setDisabled(n === 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
