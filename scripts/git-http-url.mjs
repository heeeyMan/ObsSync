// Offline check for GitHub smart-HTTP URL canonicalization.
// A repo URL without `.git` 301s, and requestUrl hangs on that POST redirect
// until the sync timeout. Run: node scripts/git-http-url.mjs

import esbuild from "esbuild";
import vm from "node:vm";
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
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(built.outputFiles[0].text, sandbox);
const { canonicalizeGitHttpUrl } = sandbox.module.exports;

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

if (failed) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall url checks passed");
