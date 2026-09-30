// Two isomorphic-git fixes. Idempotent. Applied to both builds esbuild
// (index.js) and Node (index.cjs) resolve.
//
// 1. Push walk. It stops only when a parent commit IS the remote tip. After
//    a merge that tip is often the second parent, so the first-parent chain
//    keeps walking through history the remote already has. Those old objects
//    go into the pack (this vault: 3044 objects / 72 MB instead of the 68 new
//    ones) and the upload hits the sync timeout. Seed the finish set with
//    every ancestor of the remote tip so the walk matches
//    `git rev-list START ^FINISH`.
//
// 2. Fetch haves. singleBranch advertises only the local branch tip. Once
//    that tip is a local commit (or a merge whose first parent the remote has
//    never seen), the server ignores the have and uploads the whole history.
//    Advertise remote-tracking tips and a short walk of every parent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
	"node_modules/isomorphic-git/index.js",
	"node_modules/isomorphic-git/index.cjs",
];

const finishMarker = "obsidian-git-vault-sync: finish ancestors";
const fetchMarker = "obsidian-git-vault-sync: fetch haves";

const anchor = `    } catch (err) {}
  }
  const visited = new Set();
  // Because git commits are named by their hash, there is no
  // way to construct a cycle. Therefore we won't worry about
  // setting a default recursion limit.
  async function walk(oid) {`;

const insert = `    } catch (err) {}
  }
  // ${finishMarker}
  // The finish list is only the remote tip. A merged history walks
  // first-parent through commits the remote already stores, and those
  // objects are packed and uploaded. Mark every ancestor finished too.
  {
    const pending = [...finishingSet];
    const seenFinish = new Set(pending);
    while (pending.length) {
      const finishOid = pending.pop();
      try {
        const { type, object } = await _readObject({
          fs,
          cache,
          gitdir,
          oid: finishOid,
        });
        if (type !== "commit") continue;
        for (const parent of GitCommit.from(object).headers().parent) {
          if (seenFinish.has(parent)) continue;
          seenFinish.add(parent);
          finishingSet.add(parent);
          pending.push(parent);
        }
      } catch (err) {}
    }
  }
  const visited = new Set();
  // Because git commits are named by their hash, there is no
  // way to construct a cycle. Therefore we won't worry about
  // setting a default recursion limit.
  async function walk(oid) {`;

const fetchAnchor = `  haves = [...new Set(haves)];
  const oids = await GitShallowManager.read({ fs, gitdir });`;

const fetchInsert = `  haves = [...new Set(haves)];
  // ${fetchMarker}
  // The local tip is often a commit the remote has never seen. The server
  // then ignores the have and sends the whole history. Add remote-tracking
  // tips and a short walk of every parent (a merge's second parent is the
  // remote tip and is not on the first-parent chain).
  {
    try {
      const remoteTips = await GitRefManager.listRefs({
        fs,
        gitdir,
        filepath: \`refs/remotes\`,
      });
      for (const tip of remoteTips) {
        try {
          const full = await GitRefManager.expand({ fs, gitdir, ref: tip });
          const tipOid = await GitRefManager.resolve({
            fs,
            gitdir,
            ref: full,
          });
          if (await hasObject({ fs, cache, gitdir, oid: tipOid })) {
            haves.push(tipOid);
          }
        } catch (err) {}
      }
    } catch (err) {}
    const pending = [...haves];
    const seen = new Set(haves);
    let budget = 64;
    while (pending.length && budget > 0) {
      const haveOid = pending.shift();
      try {
        const { type, object } = await _readObject({
          fs,
          cache,
          gitdir,
          oid: haveOid,
        });
        if (type !== "commit") continue;
        for (const parent of GitCommit.from(object).headers().parent) {
          if (seen.has(parent) || budget <= 0) continue;
          seen.add(parent);
          if (!(await hasObject({ fs, cache, gitdir, oid: parent }))) continue;
          haves.push(parent);
          pending.push(parent);
          budget -= 1;
        }
      } catch (err) {}
    }
  }
  haves = [...new Set(haves)];
  const oids = await GitShallowManager.read({ fs, gitdir });`;

let failed = false;

function apply(rel, marker, from, to) {
	const file = path.join(root, rel);
	const text = fs.readFileSync(file, "utf8");
	if (text.includes(marker)) {
		console.log(`already patched ${rel} (${marker})`);
		return;
	}
	if (!text.includes(from) || text.split(from).length !== 2) {
		console.error(`patch anchor missing or not unique in ${rel} (${marker})`);
		failed = true;
		return;
	}
	fs.writeFileSync(file, text.replace(from, to));
	console.log(`patched ${rel} (${marker})`);
}

for (const rel of files) {
	apply(rel, finishMarker, anchor, insert);
	apply(rel, fetchMarker, fetchAnchor, fetchInsert);
}
if (failed) process.exit(1);
