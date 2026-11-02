// Integrated API pull, repeat scan, transaction recovery and failure semantics.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const fsp = fs.promises;
const temp = await fsp.mkdtemp(join(tmpdir(), 'gitsync-i33-sync-'));
const sha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const ab = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
globalThis.window = globalThis;
try {
 const stub = join(temp, 'obsidian.mjs'), entry = join(temp, 'entry.mjs'), output = join(temp, 'engine.mjs');
 await fsp.writeFile(stub, 'export const requestUrl = o => globalThis.requestMock(o);');
 await fsp.writeFile(entry, ['src/chunked-sync.ts','src/github-sync.ts'].map(p=>`export * from ${JSON.stringify(resolve(p))};`).join('\n'));
 await build({ entryPoints:[entry], outfile:output, bundle:true, format:'esm', platform:'node', alias:{obsidian:stub}, logLevel:'error' });
 const { ChunkedSync, apiSync, hashLocalFile } = await import(output);
 const root = join(temp, 'vault'); await fsp.mkdir(root);
 const absolute = p => join(root, p === '/' ? '' : p);
 let readLarge = 0, streamingReads = 0, ranges = 0, pendingRange = 0, maxRange = 0;
 const adapter = {
  async exists(p) { try { await fsp.access(absolute(p)); return true; } catch { return false; } },
  async stat(p) { try { const s=await fsp.stat(absolute(p)); return {type:s.isDirectory()?'folder':'file',size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs}; } catch(e) {if(e.code==='ENOENT')return null;throw e;} },
  async read(p) { return fsp.readFile(absolute(p),'utf8'); },
  async readBinary(p) {const s=await this.stat(p);if(s.size>1048576){readLarge++;throw new Error('whole-file read forbidden');} return ab(await fsp.readFile(absolute(p)));},
  async write(p,s) { await fsp.writeFile(absolute(p),s); },
  async writeBinary(p,b) { await fsp.writeFile(absolute(p),new Uint8Array(b)); },
  async appendBinary(p,b) { assert.ok(b.byteLength<=1048576);await fsp.appendFile(absolute(p),new Uint8Array(b)); },
  async mkdir(p) { await fsp.mkdir(absolute(p)); },
  async rename(a,b) { await fsp.rename(absolute(a),absolute(b)); },
  async remove(p) { await fsp.unlink(absolute(p)); },
  async rmdir(p) { await fsp.rmdir(absolute(p)); },
  getResourcePath(p) { return 'local-test:'+encodeURIComponent(p); },
  async list(p) {const result={files:[],folders:[]};for(const e of await fsp.readdir(absolute(p),{withFileTypes:true})){
   const name=p==='/'?e.name:p+'/'+e.name;result[e.isDirectory()?'folders':'files'].push(name);
  }return result;},
 };
 globalThis.fetch = async url => {
  assert.ok(url.startsWith('local-test:'));streamingReads++;
  return new Response(Readable.toWeb(fs.createReadStream(absolute(decodeURIComponent(url.slice(11))),{highWaterMark:65536})));
 };
 const excluded=p=>p==='.obsidian'||p.startsWith('.obsidian/');
 const scratch='.obsidian/plugins/git-vault-sync/diagnostics/transfer';
 let events=[], fault=null, concurrent=null;
 const manager=()=>new ChunkedSync({adapter,dir:scratch,owner:'owner',repo:'repo',token:'secret',excluded,
  diagnose:async e=>{events.push(e);if(e.stage==='pull-check-local'&&concurrent){const f=concurrent;concurrent=null;await f();}}});
 let remote=new Map(), commit='a'.repeat(40);
 const big=Buffer.alloc(64931472,0x91);big[4]=0;
 remote.set('attachments/large.bin',big);remote.set('note.md',Buffer.from('hello'));
 globalThis.requestMock=async o=>{
  assert.equal(o.method,'GET','pull/repeat/failure must never push');
  const url=new URL(o.url);
  if(url.hostname==='raw.githubusercontent.com'){
   ranges++;pendingRange++;assert.equal(pendingRange,1);
   const path=url.pathname.split('/').slice(4).map(decodeURIComponent).join('/');
   assert.equal(url.pathname.split('/')[3],commit,'immutable commit URL');
   assert.equal(o.headers.Authorization,'Bearer secret');
   const data=remote.get(path);assert.ok(data);
   const [,start,end]=/^bytes=(\d+)-(\d+)$/.exec(o.headers.Range).map(Number);
   maxRange=Math.max(maxRange,end-start+1);pendingRange--;
   if(fault==='network')throw new Error('network failure');
   const bytes=Buffer.from(data.subarray(start,end+1));if(fault==='corrupt')bytes[0]^=1;
   return {status:fault==='ignored'?200:206,headers:{'content-range':`bytes ${start}-${end}/${data.length}`},arrayBuffer:ab(bytes)};
  }
  if(o.url.includes('/git/ref/'))return {status:200,json:{object:{sha:commit}}};
  if(o.url.includes('/git/commits/'))return {status:200,json:{tree:{sha:'b'.repeat(40)}}};
  if(o.url.includes('/git/trees/'))return {status:200,json:{tree:[...remote].map(([path,data])=>({type:'blob',mode:'100644',path,size:data.length,sha:sha(data)}))}};
  if(o.url.includes('/git/blobs/')){const data=[...remote.values()].find(d=>sha(d)===o.url.split('/').at(-1));assert.ok(data.length<=1048576);return {status:200,headers:{},arrayBuffer:ab(data)};}
  throw new Error('unexpected '+o.url);
 };
 const empty={commitSha:null,shas:{}};
 const run=async baseline=>{const largeFiles=manager();await largeFiles.recover();return apiSync({owner:'owner',repo:'repo',branch:'main',token:'secret',adapter,excluded,baseline,largeFiles,diagnose:async e=>events.push(e)});};
 const first=await run(empty);
 assert.deepEqual(first.pulled,['attachments/large.bin','note.md']);assert.equal(ranges,62);assert.equal(maxRange,1048576);
 assert.equal(await hashLocalFile(adapter,'attachments/large.bin',big.length),sha(big));
 assert.equal(await adapter.exists(scratch+'/transaction.json'),false);
 const again=await run(first.newBaseline);
 assert.deepEqual(again.pulled,[]);assert.deepEqual(again.conflicts,[]);assert.equal(ranges,62);assert.equal(readLarge,0);
 assert.ok(streamingReads>=3);
 console.log('PASS initial 64,931,472-byte pull + repeat Sync; no full-file reads, no push, matching baseline');
 // Shrink fixture for the failure matrix, keeping it above the chunk threshold.
 const old=Buffer.alloc(2*1048576+31,1),next=Buffer.alloc(old.length+19,2);
 await adapter.writeBinary('attachments/large.bin',ab(old));remote.set('attachments/large.bin',next);
 const baseline={commitSha:commit,shas:{'attachments/large.bin':sha(old),'note.md':sha(Buffer.from('hello'))}};
 for(const f of ['network','ignored','corrupt']){
  fault=f;await assert.rejects(run(baseline));fault=null;
  assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),old);
  assert.equal(await adapter.exists(scratch+'/pull.part'),false);
  assert.equal(baseline.shas['attachments/large.bin'],sha(old));
 }
 console.log('PASS HTTP/network/integrity failures preserve old file and baseline');
 const originalAppend=adapter.appendBinary;
 adapter.appendBinary=async()=>{throw new Error('disk full');};await assert.rejects(run(baseline),/TRANSPORT_OR_STORAGE/);adapter.appendBinary=originalAppend;
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),old);
 adapter.appendBinary=async(p,b)=>{const bytes=new Uint8Array(b.slice(0));bytes[0]^=1;await originalAppend(p,bytes.buffer);};
 await assert.rejects(run(baseline),/checksum/);adapter.appendBinary=originalAppend;
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),old);
 console.log('PASS disk-full and same-length corrupted writes never replace old file');
 const edit=Buffer.from('edited while downloading');
 concurrent=()=>adapter.writeBinary('attachments/large.bin',ab(edit));
 await assert.rejects(run(baseline),/local file changed/);
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),edit);
 await adapter.writeBinary('attachments/large.bin',ab(old));
 const originalRename=adapter.rename;
 adapter.rename=async(a,b)=>{if(a===scratch+'/pull.part')throw new Error('rename failed');await originalRename(a,b);};
 await assert.rejects(run(baseline),/rename failed/);adapter.rename=originalRename;
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),old);
 console.log('PASS concurrent edit preserved; failed promotion restores displaced original');
 // Simulate process death in the rename window, independently of the catch path.
 await adapter.write(scratch+'/transaction.json',JSON.stringify({path:'attachments/large.bin',sha:sha(next)}));
 await adapter.rename('attachments/large.bin',scratch+'/previous.bin');
 await adapter.writeBinary(scratch+'/pull.part',ab(next));
 await manager().recover();
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),old);
 const updated=await run(baseline);assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),next);
 assert.equal(updated.newBaseline.shas['attachments/large.bin'],sha(next));
 // Process death after successful promotion: safe cleanup, no rollback of the new file.
 await adapter.write(scratch+'/transaction.json',JSON.stringify({path:'attachments/large.bin',sha:sha(next)}));
 await adapter.writeBinary(scratch+'/previous.bin',ab(old));await manager().recover();
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),next);
 // An edit after the crash must not be overwritten or cause the backup to be deleted.
 await adapter.write(scratch+'/transaction.json',JSON.stringify({path:'attachments/large.bin',sha:sha(next)}));
 await adapter.writeBinary(scratch+'/previous.bin',ab(old));await adapter.writeBinary('attachments/large.bin',ab(edit));
 await assert.rejects(manager().recover(),/interrupted file replacement/);
 assert.deepEqual(await fsp.readFile(absolute('attachments/large.bin')),edit);
 assert.deepEqual(await fsp.readFile(absolute(scratch+'/previous.bin')),old);
 console.log('PASS recovery before/after promotion; ambiguous recovery preserves both copies');
 // No silently buffered local read fallback when the local resource API fails.
 globalThis.fetch=async()=>new Response(null,{status:403});
 await assert.rejects(hashLocalFile(adapter,scratch+'/previous.bin',old.length),/could not stream/);
 assert.equal(readLarge,0);
 console.log('PASS unavailable local stream stops safely without whole-file fallback');
} finally { await fsp.rm(temp,{recursive:true,force:true}); }
