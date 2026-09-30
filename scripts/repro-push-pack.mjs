// A merge makes the remote tip the second parent. isomorphic-git then walks
// the whole first-parent history and packs objects the remote already has.
// The patched walker must leave those objects out. Run: node scripts/repro-push-pack.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitsync-push-"));
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

run(["init", "-b", "main"]);
// Ancient blob, deleted before the remote tip. It must not be re-uploaded.
write("ancient.bin", Buffer.alloc(80 * 1024, 7));
run(["add", "ancient.bin"]);
run(["commit", "-m", "c0"]);
run(["rm", "ancient.bin"]);
write("base.txt", "base");
run(["add", "-A"]);
run(["commit", "-m", "c1"]);
write("remote.txt", "remote");
run(["add", "remote.txt"]);
run(["commit", "-m", "c2"]);
const origin = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: gitEnv })
	.toString()
	.trim();
run(["checkout", "-b", "local", "HEAD~1"]);
write("new.txt", "new");
run(["add", "new.txt"]);
run(["commit", "-m", "d1"]);
run(["merge", "main", "-m", "merge"]);

function pkt(text) {
	const body = Buffer.from(text);
	return Buffer.concat([
		Buffer.from((body.length + 4).toString(16).padStart(4, "0")),
		body,
	]);
}

const advertisement = Buffer.concat([
	pkt("# service=git-receive-pack\n"),
	Buffer.from("0000"),
	pkt(
		`${origin} refs/heads/main\0report-status side-band-64k ofs-delta\n`
	),
	Buffer.from("0000"),
]);

let posted = 0;
const http = {
	async request({ method = "GET", body }) {
		if (method === "GET") {
			return {
				url: "",
				method,
				statusCode: 200,
				statusMessage: "OK",
				headers: {
					"content-type": "application/x-git-receive-pack-advertisement",
				},
				body: [new Uint8Array(advertisement)],
			};
		}
		for await (const chunk of body) posted += chunk.byteLength || chunk.length;
		return {
			url: "",
			method,
			statusCode: 200,
			statusMessage: "OK",
			headers: { "content-type": "application/x-git-receive-pack-result" },
			body: [new Uint8Array(pkt("unpack ok\n")), Buffer.from("0000")],
		};
	},
};

try {
	await git.push({
		fs,
		http,
		dir: repo,
		ref: "local",
		url: "https://example.com/repo.git",
		remote: "origin",
	});
} catch (err) {
	// The fake receive-pack reply is only there so push gets as far as
	// building the pack. A parse error after the POST is fine.
	if (!posted) throw err;
}

const limit = 20 * 1024;
const ok = posted > 0 && posted < limit;
console.log(
	`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} push pack is ${posted} bytes (ancient blob excluded, limit ${limit})`
);
fs.rmSync(repo, { recursive: true, force: true });
if (!ok) process.exit(1);
