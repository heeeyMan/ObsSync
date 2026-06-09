import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { ChangeEntry, GitManager } from "./git";
import { t } from "./i18n";

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
	/** Optional callback invoked once when the modal closes (used by the plugin
	 *  to drop its reference). */
	onCloseHook?: () => void;

	constructor(
		app: App,
		private readonly git: GitManager,
		private readonly onSync: (paths: string[]) => void
	) {
		super(app);
	}

	async onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText(t("rmTitle"));

		const loading = contentEl.createEl("p", { text: t("rmLoading") });
		try {
			this.entries = await this.git.listChanges();
		} catch (err) {
			loading.setText(t("rmFailed", { msg: (err as Error).message }));
			return;
		}
		loading.remove();

		if (this.entries.length === 0) {
			contentEl.createEl("p", { text: t("rmNothing") });
			new Setting(contentEl).addButton((b) =>
				b.setButtonText(t("rmClose")).onClick(() => this.close())
			);
			return;
		}

		for (const e of this.entries) this.selected.add(e.path);

		new Setting(contentEl)
			.setName(t("rmCount", { n: this.entries.length }))
			.addExtraButton((b) =>
				b
					.setIcon("check-square")
					.setTooltip(t("rmSelectAll"))
					.onClick(() => this.setAll(true))
			)
			.addExtraButton((b) =>
				b
					.setIcon("square")
					.setTooltip(t("rmSelectNone"))
					.onClick(() => this.setAll(false))
			);

		const list = contentEl.createDiv({ cls: "gitsync-review-list" });
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
				b.setButtonText(t("rmCancel")).onClick(() => this.close())
			);
		this.updateSyncButton();
	}

	private renderRow(parent: HTMLElement, entry: ChangeEntry) {
		const row = parent.createDiv({ cls: "gitsync-review-row" });
		const checkbox = row.createEl("input", { type: "checkbox" });
		checkbox.checked = true;
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selected.add(entry.path);
			else this.selected.delete(entry.path);
			this.updateSyncButton();
		});
		row.dataset.path = entry.path;
		row.createSpan({
			cls: `gitsync-badge gitsync-badge--${entry.status}`,
			text: STATUS_LABEL[entry.status],
		});
		row.createSpan({ cls: "gitsync-review-path", text: entry.path });
		row.addEventListener("click", (evt) => {
			if (evt.target === checkbox) return; // checkbox handles its own click
			checkbox.checked = !checkbox.checked;
			if (checkbox.checked) this.selected.add(entry.path);
			else this.selected.delete(entry.path);
			this.updateSyncButton();
		});
	}

	private setAll(value: boolean) {
		this.selected.clear();
		if (value) this.entries.forEach((e) => this.selected.add(e.path));
		this.contentEl
			.querySelectorAll<HTMLInputElement>(".gitsync-review-row input")
			.forEach((cb) => (cb.checked = value));
		this.updateSyncButton();
	}

	private updateSyncButton() {
		const n = this.selected.size;
		this.syncButton?.setButtonText(t("rmSync", { n })).setDisabled(n === 0);
	}

	onClose() {
		this.contentEl.empty();
		this.onCloseHook?.();
	}
}
