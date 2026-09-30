// singleBranch fetch used to advertise only the local tip. After a merge that
// tip is unknown to the remote, so upload-pack sends the whole history.
// The patched fetch must also advertise the remote-tracking tip.
// Run: node scripts/repro-fetch-haves.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitsync-fetch-"));
const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

function run(args) {
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd: repo,
		env: gitEnv,
		stdio: "pipe",
	});
}

function write(name, data) {
	fs.writeFileSync(path.join(repo, name), data);
}

function oid(args) {
	return execFileSync("git", args, { cwd: repo, env: gitEnv }).toString().trim();
}

run(["init", "-b", "main"]);
write("base.txt", "base");
run(["add", "base.txt"]);
run(["commit", "-m", "c0"]);
write("local.txt", "local");
run(["add", "local.txt"]);
run(["commit", "-m", "local"]);
const localTip = oid(["rev-parse", "HEAD"]);
run(["checkout", "-b", "remote", "HEAD~1"]);
write("remote.txt", "remote");
run(["add", "remote.txt"]);
run(["commit", "-m", "remote"]);
const originTip = oid(["rev-parse", "HEAD"]);
run(["checkout", "main"]);
run(["merge", "remote", "-m", "merge"]);
const mergeTip = oid(["rev-parse", "HEAD"]);
fs.mkdirSync(path.join(repo, ".git/refs/remotes/origin"), { recursive: true });
fs.writeFileSync(path.join(repo, ".git/refs/remotes/origin/main"), originTip + "\n");

function pkt(text) {
	const body = Buffer.from(text);
	return Buffer.concat([
		Buffer.from((body.length + 4).toString(16).padStart(4, "0")),
		body,
	]);
}

const advertisement = Buffer.concat([
	pkt("# service=git-upload-pack\n"),
	Buffer.from("0000"),
	pkt(`${originTip} HEAD\0multi_ack_detailed no-done side-band-64k ofs-delta\n`),
	pkt(`${originTip} refs/heads/main\n`),
	Buffer.from("0000"),
]);

let posted = Buffer.alloc(0);
const http = {
	async request({ method = "GET", body }) {
		if (method === "GET") {
			return {
				url: "",
				method,
				statusCode: 200,
				statusMessage: "OK",
				headers: {
					"content-type": "application/x-git-upload-pack-advertisement",
				},
				body: [new Uint8Array(advertisement)],
			};
		}
		const chunks = [];
		for await (const chunk of body) chunks.push(Buffer.from(chunk));
		posted = Buffer.concat(chunks);
		return {
			url: "",
			method,
			statusCode: 200,
			statusMessage: "OK",
			headers: { "content-type": "application/x-git-upload-pack-result" },
			body: [new Uint8Array(pkt("NAK\n")), Buffer.from("0000")],
		};
	},
};

try {
	await git.fetch({
		fs,
		http,
		dir: repo,
		url: "https://example.com/repo.git",
		remote: "origin",
		ref: "main",
		singleBranch: true,
		tags: false,
	});
} catch (err) {
	if (!posted.length) throw err;
}

const text = posted.toString("utf8");
const hasOrigin = text.includes(`have ${originTip}`);
const hasMerge = text.includes(`have ${mergeTip}`);
const ok = posted.length > 0 && hasOrigin && hasMerge;
console.log(
	`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} fetch advertises remote tip ${originTip.slice(0, 8)} (${posted.length} bytes, local ${localTip.slice(0, 8)}, merge ${mergeTip.slice(0, 8)})`
);
if (!ok) console.log(text.replace(/\n/g, "\\n"));
fs.rmSync(repo, { recursive: true, force: true });
if (!ok) process.exit(1);
