// Offline check for GitHub smart-HTTP URL canonicalization.
// A repo URL without `.git` 301s, and requestUrl hangs on that POST redirect
// until the sync timeout. Run: node scripts/git-http-url.mjs

import esbuild from "esbuild";
import vm from "node:vm";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const built = await esbuild.build({
	entryPoints: ["src/git-http.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	write: false,
	plugins: [
		{
			name: "stub-obsidian",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({
					path: "obsidian",
					namespace: "stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: "exports.requestUrl = async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) });",
					loader: "js",
				}));
			},
		},
	],
});

const sandbox = {
	exports: {},
	module: { exports: {} },
	require,
	URL,
	setTimeout,
	clearTimeout,
	Date,
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(built.outputFiles[0].text, sandbox);
const { canonicalizeGitHttpUrl, prepareGitHttpHeaders, nodeGitHttpRequest } =
	sandbox.module.exports;

let failed = 0;
function ok(cond, label) {
	if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
	else {
		failed++;
		console.log(`  \x1b[31m✗ ${label}\x1b[0m`);
	}
}

const cases = [
	[
		"https://github.com/owner/repo/info/refs?service=git-upload-pack",
		"https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
	],
	[
		"https://github.com/owner/repo/git-upload-pack",
		"https://github.com/owner/repo.git/git-upload-pack",
	],
	[
		"https://github.com/owner/repo/git-receive-pack",
		"https://github.com/owner/repo.git/git-receive-pack",
	],
	[
		"https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
		"https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
	],
	[
		"https://github.com/owner/repo.git/git-receive-pack",
		"https://github.com/owner/repo.git/git-receive-pack",
	],
	[
		"https://gitlab.com/group/repo/info/refs?service=git-upload-pack",
		"https://gitlab.com/group/repo/info/refs?service=git-upload-pack",
	],
	[
		"https://user:token@github.com/owner/repo/git-upload-pack",
		"https://user:token@github.com/owner/repo.git/git-upload-pack",
	],
	["https://github.com/owner/repo", "https://github.com/owner/repo"],
	["not a url", "not a url"],
];

console.log("\n\x1b[1mGitHub smart-HTTP URL canonicalization\x1b[0m");
for (const [input, expected] of cases) {
	const got = canonicalizeGitHttpUrl(input);
	ok(got === expected, `${input} → ${got}`);
}

console.log("\n\x1b[1mrequestUrl header filtering\x1b[0m");
const gitHeaders = {
	"content-type": "application/x-git-upload-pack-request",
	Accept: "application/x-git-upload-pack-result",
	Host: "github.com",
	"Content-Length": "999999",
	"Transfer-Encoding": "chunked",
};
const desktop = prepareGitHttpHeaders(gitHeaders);
ok(desktop["Content-Length"] === undefined, "desktop drops Content-Length");
ok(desktop["Transfer-Encoding"] === undefined, "desktop drops Transfer-Encoding");
ok(desktop["Host"] === undefined, "desktop drops Host");
ok(
	desktop["content-type"] === "application/x-git-upload-pack-request",
	"content-type is kept"
);
ok(
	desktop["User-Agent"] === "git/obsidian-git-vault-sync",
	"User-Agent is filled in when missing"
);
ok(gitHeaders["Content-Length"] === "999999", "input headers are not mutated");

const mobile = prepareGitHttpHeaders(gitHeaders, { contentLength: 42 });
ok(mobile["Content-Length"] === "42", "mobile sets Content-Length from the body");
ok(mobile["Host"] === undefined, "mobile still drops Host");

const customUa = prepareGitHttpHeaders({ "User-Agent": "git/isomorphic-git" });
ok(customUa["User-Agent"] === "git/isomorphic-git", "existing User-Agent is kept");

console.log("\n\x1b[1mdesktop Node HTTP — Content-Length and POST redirect\x1b[0m");
const seen = [];
const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const body = Buffer.concat(chunks);
		seen.push({
			url: req.url,
			method: req.method,
			len: req.headers["content-length"],
			te: req.headers["transfer-encoding"] ?? "",
			body: body.toString("utf8"),
		});
		if (req.url === "/git-upload-pack") {
			res.writeHead(301, { Location: "/git-upload-pack-2" });
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
try {
	const payload = new TextEncoder().encode("want-line");
	const body = payload.buffer.slice(
		payload.byteOffset,
		payload.byteOffset + payload.byteLength
	);
	const headers = prepareGitHttpHeaders(
		{ "content-type": "application/x-git-upload-pack-request" },
		{ contentLength: payload.byteLength }
	);
	const res = await nodeGitHttpRequest({
		url: `http://127.0.0.1:${port}/git-upload-pack`,
		method: "POST",
		headers,
		body,
		timeoutMs: 5000,
	});
	ok(res.statusCode === 200, `POST redirect followed (${res.statusCode})`);
	ok(res.url.endsWith("/git-upload-pack-2"), `final url ${res.url}`);
	ok(seen.length === 2, `two hops, got ${seen.length}`);
	ok(
		seen.every((s) => s.method === "POST"),
		"POST preserved across the redirect"
	);
	ok(
		seen.every((s) => s.len === String(payload.byteLength)),
		`Content-Length ${seen.map((s) => s.len).join(",")}`
	);
	ok(
		seen.every((s) => s.te === ""),
		"body is not chunked"
	);
	ok(
		seen.every((s) => s.body === "want-line"),
		"body bytes resent intact"
	);
	ok(
		new TextDecoder().decode(res.body) === "ok",
		"response body returned"
	);
} finally {
	await new Promise((resolve) => server.close(resolve));
}

const hungSockets = new Set();
const hung = http.createServer();
hung.on("connection", (socket) => {
	hungSockets.add(socket);
	socket.on("close", () => hungSockets.delete(socket));
});
await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
const hungPort = hung.address().port;
try {
	let msg = "";
	try {
		await nodeGitHttpRequest({
			url: `http://127.0.0.1:${hungPort}/hang`,
			method: "GET",
			headers: {},
			timeoutMs: 300,
		});
	} catch (err) {
		msg = err instanceof Error ? err.message : String(err);
	}
	ok(/ERR_TIMEOUT/.test(msg), `hung request surfaces ERR_TIMEOUT (${msg})`);
} finally {
	for (const socket of hungSockets) socket.destroy();
	await new Promise((resolve) => hung.close(resolve));
}

if (failed) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall url checks passed");
