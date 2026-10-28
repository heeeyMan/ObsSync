import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'i33-conflicts-'));
globalThis.window=globalThis;
try {
 const stub=join(dir,'obsidian.mjs'), out=join(dir,'api.mjs');
 await writeFile(stub,'export const requestUrl = o => globalThis.requestMock(o);');
 await build({entryPoints:['src/github-sync.ts'],outfile:out,bundle:true,format:'esm',platform:'node',alias:{obsidian:stub},logLevel:'error'});
 const {commitResolutions}=await import(out);
 let events=[], hold=null, rejectRef=false;
 const adapter={exists:async()=>true,write:async()=>{},writeBinary:async()=>{}};
 const options={owner:'owner',repo:'repo',branch:'main',token:'SECRET',adapter,baseline:{commitSha:null,shas:{}},resolved:[{path:'private-note.md',content:new TextEncoder().encode('private content')}],diagnose:async e=>events.push(e)};
 globalThis.requestMock=async o=>{
  if(o.url.includes('/git/ref/')) return {status:200,json:{object:{sha:'a'.repeat(40)}}};
  if(o.method==='GET'&&o.url.includes('/git/commits/'))return {status:200,json:{tree:{sha:'b'.repeat(40)}}};
  if(o.method==='GET')return {status:200,json:{tree:[]}};
  if(o.url.endsWith('/git/blobs')&&hold)await hold;
  if(o.method==='PATCH'&&rejectRef)return {status:409,json:{}};
  return {status:200,json:{sha:'c'.repeat(40)}};
 };
 let release;hold=new Promise(r=>release=r);
 const pending=commitResolutions(options);
 for(let i=0;i<20 && !events.some(e=>e.stage==='conflict-upload-blob');i++)await new Promise(r=>setTimeout(r,0));
 assert.equal(events.at(-1).stage,'conflict-upload-blob','pending operation is recorded before it finishes');
 release();await pending;
 assert.equal(events.at(-1).stage,'conflict-remote-complete');
 const stages=events.map(e=>e.stage);
 for(const stage of ['conflict-write-local','conflict-fetch-head','conflict-fetch-tree','conflict-create-tree','conflict-create-commit','conflict-update-ref'])assert.ok(stages.includes(stage));
 assert.ok(!JSON.stringify(events).match(/SECRET|private-note|private content/));
 events=[];rejectRef=true;await assert.rejects(commitResolutions(options));
 assert.equal(events.at(-1).stage,'conflict-update-ref');
 console.log('PASS pending conflict upload, completion, rejected ref, diagnostic privacy');
 // Exercise the actual plugin orchestration with UI/transport boundaries mocked.
 const pluginOut=join(dir,'plugin.mjs');
 await build({entryPoints:['src/main.ts'],outfile:pluginOut,bundle:true,format:'esm',platform:'node',logLevel:'error',plugins:[{name:'boundaries',setup(b){
  b.onResolve({filter:/.*/},a=>{
   if(a.path==='obsidian')return {path:a.path,namespace:'mock'};
   if(a.importer===resolve('src/main.ts')&&!['./i18n','./sync-diagnostics'].includes(a.path))return {path:a.path,namespace:'mock'};
  });
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents: a.path==='obsidian'?`export class Plugin {} export class Modal {} export class Menu {} export const Platform={isMobile:true}; export function setIcon(){} export function setTooltip(){} export class Notice { constructor(message){this.message=message;globalThis.notices.push(this);} setMessage(m){this.message=m;} hide(){this.hidden=true;} }` : a.path==='./github-sync'?`export const commitResolutions=(o)=>globalThis.commitMock(o); export const getBlob=()=>globalThis.blobMock(); export const apiSync=()=>{}; export const getBranchHead=()=>{}; export const getTree=()=>{}; export const parseGitHubRepo=()=>{};` : a.path==='./api-conflict-modal'?`export class ApiConflictModal { constructor(app,files,done){this.done=done;} open(){this.done(new Map([['note.md',new Uint8Array([65])]]));} }` : a.path==='./obsidian-fs'?`export const createSyncAdapter=()=>({readBinary:async()=>new ArrayBuffer(1)});` : a.path==='./settings'?`export const DEFAULT_SETTINGS={}; export class GitSyncSettingTab {}` : a.path==='./git'?`export class MergeConflict extends Error {} export class GitManager {} export const buildUserExcludeMatcher=()=>{}; export const parseGitignore=()=>{};` : a.path==='./conflict-modal'?`export class ConflictModal {}` : a.path==='./review-modal'?`export class ReviewModal {}` : a.path==='./error-modal'?`export class ErrorDetailModal {}` : a.path==='./chunked-sync'?`export class ChunkedSync {}` : `export const downloadInChunks=()=>{};` }));
 }}]});
 const {default:Plugin}=await import(pluginOut);
 const plugin=new Plugin();plugin.manifest={version:'0.2.27-issue33.3'};plugin.settings={diagnosticsEnabled:false,remoteUrl:'repo',token:'SECRET',apiBaseline:{}};plugin.app={};
 globalThis.notices=[];let records=[];plugin.diagnostics={record:async e=>records.push(e)};
 plugin.setStatus=()=>{};plugin.refreshStatus=async()=>{};plugin.saveSettings=async()=>{};plugin.effectiveEngine=()=> 'api';
 plugin.syncApi=()=>plugin.resolveApiConflicts('owner','repo','main','SECRET',[{path:'note.md',remoteSha:'a',localDeleted:false}],'test');
 globalThis.blobMock=async()=>new Uint8Array([1]);globalThis.commitMock=async()=>({newBaseline:{}});
 await plugin.sync();assert.ok(records.some(e=>e.stage==='conflict-complete'));assert.equal(records.at(-1).stage,'sync-returned');assert.equal(plugin.activityTimer,null);assert.ok(notices.every(n=>n.hidden||!n.message.includes('Elapsed')));
 let tick;const originalSetInterval=window.setInterval;
 window.setInterval=(fn,ms)=>{tick=fn;return originalSetInterval(fn,ms);};
 let finish;globalThis.commitMock=()=>new Promise(r=>{finish=r;});records=[];
 const active=plugin.sync();for(let i=0;i<20&&!finish;i++)await new Promise(r=>setTimeout(r,0));
 assert.ok(finish);const before=records.length;plugin.activityAt=Date.now()-125000;tick();
 assert.equal(records.length,before,'UI heartbeat must not overwrite journal evidence');
 assert.ok(notices.some(n=>!n.hidden&&n.message.includes('125s')));
 assert.equal(plugin.activitySnapshot().stage,'conflict-submit');
 finish({newBaseline:{}});await active;window.setInterval=originalSetInterval;
 records=[];globalThis.commitMock=async()=>{throw new Error('mock failure');};
 await plugin.sync();assert.equal(records.at(-1).stage,'sync-failed');assert.equal(plugin.lastSyncError,true);assert.equal(plugin.syncing,false);assert.equal(plugin.activityTimer,null);
 records=[];globalThis.blobMock=async()=>{throw new Error('mock load failure');};await plugin.sync();assert.equal(records.at(-1).stage,'sync-failed');assert.ok(records.some(e=>e.stage==='conflict-load-failed'));
 plugin.manifest.version='0.2.27';assert.equal(plugin.diagnosticsEnabled(),false);
 console.log('PASS automatic test-build diagnostics, success/failure propagation, timer cleanup, stable opt-in');
} finally {await rm(dir,{recursive:true,force:true});}
