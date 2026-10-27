import type { DataAdapter } from "obsidian";

/** No paths, URLs, tokens, content, response headers or exception messages. */
export interface DiagnosticEvent {
	stage: string;
	file?: string;
	bytes?: number;
	total?: number;
	status?: number;
	code?: string;
}
export type Diagnose = (event: DiagnosticEvent) => Promise<void>;
interface RecordEntry extends DiagnosticEvent { time: string; sequence: number; }

/** Two bounded snapshots: a torn write leaves the other slot readable. */
export class SyncDiagnostics {
	private records: RecordEntry[] = [];
	private sequence = 0;
	private interrupted: RecordEntry[] = [];
	constructor(private adapter: DataAdapter, readonly dir: string) {}
	async load(): Promise<void> {
		for (const slot of [0, 1]) {
			try {
				const parsed = JSON.parse(await this.adapter.read(`${this.dir}/journal-${slot}.json`));
				if (Array.isArray(parsed) && parsed.length && parsed.length <= 80 &&
					parsed.every((r: RecordEntry) => typeof r.stage === "string" && Number.isSafeInteger(r.sequence)) &&
					parsed[parsed.length - 1].sequence > this.sequence) {
					this.records = parsed;
					this.sequence = parsed[parsed.length - 1].sequence;
				}
			} catch { /* Missing or interrupted snapshot; try the other slot. */ }
		}
		try { this.interrupted = JSON.parse(await this.adapter.read(`${this.dir}/interrupted.json`)); } catch { /* First run. */ }
		const last = this.records[this.records.length - 1];
		if (last && !["sync-returned", "sync-failed", "prototype-complete", "prototype-failed"].includes(last.stage)) {
			this.interrupted = [...this.records];
			// Preserve the crash context even if automatic sync runs on startup.
			await this.adapter.write(`${this.dir}/interrupted.json`, JSON.stringify(this.interrupted)).catch(() => {
				// A full/read-only disk must not prevent the plugin from loading.
			});
		}
	}
	async record(event: DiagnosticEvent): Promise<void> {
		if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
		this.records.push({ ...event, time: new Date().toISOString(), sequence: ++this.sequence });
		this.records = this.records.slice(-80);
		await this.adapter.write(`${this.dir}/journal-${this.sequence % 2}.json`, JSON.stringify(this.records));
	}
	report(): string { return JSON.stringify({ interrupted: this.interrupted, recent: this.records }, null, 2); }
}
