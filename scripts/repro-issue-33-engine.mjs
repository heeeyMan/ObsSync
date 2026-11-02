// Actual plugin orchestration from stable, prerelease, and working source.
// UI/engine boundaries are mocked; no vault files or network are changed.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'i33-engine-'));
globalThis.window=globalThis;globalThis.notices=[];
async function load(label, source) {
 const pluginOut=join(dir,label+'.mjs');
 await build({stdin:{contents:source,resolveDir:resolve('src'),sourcefile:'main.ts',loader:'ts'},outfile:pluginOut,bundle:true,format:'esm',platform:'node',logLevel:'error',plugins:[{name:'boundaries',setup(b){
  b.onResolve({filter:/.*/},a=>{
   if(a.path==='obsidian')return {path:a.path,namespace:'mock'};
   if(a.importer.endsWith('/main.ts')&&!['./i18n','./sync-diagnostics'].includes(a.path))return {path:a.path,namespace:'mock'};
  });
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents: a.path==='obsidian'?`export class Plugin {} export class Modal {} export class Menu {} export const Platform={isMobile:true}; export function setIcon(){} export function setTooltip(){} export class Notice { constructor(message){this.message=message;globalThis.notices.push(this);} setMessage(m){this.message=m;} hide(){this.hidden=true;} }` : a.path==='./github-sync'?`export const commitResolutions=(o)=>globalThis.commitMock(o); export const getBlob=()=>globalThis.blobMock(); export const apiSync=()=>{}; export const getBranchHead=()=>{}; export const getTree=()=>{}; export const parseGitHubRepo=()=>{};` : a.path==='./api-conflict-modal'?`export class ApiConflictModal { constructor(app,files,done){this.done=done;} open(){this.done(new Map([['note.md',new Uint8Array([65])]]));} }` : a.path==='./obsidian-fs'?`export const createSyncAdapter=()=>({readBinary:async()=>new ArrayBuffer(1)});` : a.path==='./settings'?`export const DEFAULT_SETTINGS={}; export class GitSyncSettingTab {}` : a.path==='./git'?`export class MergeConflict extends Error {} globalThis.MergeConflictMock=MergeConflict; export class GitManager {} export const buildUserExcludeMatcher=()=>{}; export const parseGitignore=()=>{};` : a.path==='./conflict-modal'?`export class ConflictModal { constructor(){globalThis.gitModalCount++;} open(){} }` : a.path==='./review-modal'?`export class ReviewModal {}` : a.path==='./error-modal'?`export class ErrorDetailModal {}` : a.path==='./chunked-sync'?`export class ChunkedSync {}` : `export const downloadInChunks=()=>{};` }));
 }}]});

 const {default:Plugin}=await import(pluginOut);
 const plugin=new Plugin();plugin.manifest={version:label};plugin.settings={syncEngine:'git',diagnosticsEnabled:true,remoteUrl:'repo',token:'SECRET'};plugin.app={};
 plugin.setStatus=()=>{};plugin.refreshStatus=async()=>{};plugin.saveSettings=async()=>{};plugin.closeSettingsTab=()=>{};
 plugin.diagnostics={record:async()=>{}};
 return plugin;
}
try {
 // Historical comparisons are opt-in: release archives/CI shallow clones need no old refs.
 if (process.argv.includes('--history')) for (const [label, ref] of [['stable','c35c4d0'],['prerelease','67813fa']]) {
  const source=execFileSync('git',['show',ref+':src/main.ts'],{encoding:'utf8'});
  const p=await load(label,source);
  p.syncGit=async()=>{throw new globalThis.MergeConflictMock('conflict');};
  await p.sync(true);assert.ok(p.pendingConflict);assert.equal(p.conflictActive,true);
  // This is exactly what the old settings dropdown allowed while conflict was parked.
  p.settings.syncEngine='api';globalThis.gitModalCount=0;
  p.resolvePendingConflict();await new Promise(r=>setTimeout(r,230));
  assert.equal(p.effectiveEngine(),'api');assert.equal(globalThis.gitModalCount,1);
  console.log('REPRO '+label+': parked Git conflict opens Git modal while setting is API');
  p.pendingConflict=null;p.conflictActive=false;p.currentModal=null;p.settings.syncEngine='git';
  p.syncGit=async()=>{const e=new Error('unmerged');e.name='UnmergedPathsError';throw e;};await p.sync();
  const previous=p.lastError;p.settings.syncEngine='api';p.syncApi=async()=>{};await p.sync();
  assert.equal(p.lastError,previous);assert.equal(p.lastSyncError,false);
  console.log('REPRO '+label+': last-error viewer retains prior Git failure after successful API sync');
 }
 const p=await load('working',await readFile('src/main.ts','utf8'));
 p.syncGit=async()=>{throw new globalThis.MergeConflictMock('conflict');};await p.sync(true);
 assert.equal(await p.changeSyncEngine('api'),false);assert.equal(p.settings.syncEngine,'git');
 p.pendingConflict=null;p.conflictActive=false;p.syncing=true;
 assert.equal(await p.changeSyncEngine('api'),false);p.syncing=false;
 assert.equal(await p.changeSyncEngine('api'),true);
 let gitCalls=0,apiCalls=0;p.syncGit=async()=>{gitCalls++;};p.syncApi=async()=>{apiCalls++;};
 // Simulate a direct external settings mutation during awaited diagnostic I/O.
 p.diagnostics={record:async e=>{if(e.stage==='sync-start')p.settings.syncEngine='git';}};
 await p.sync();assert.equal(apiCalls,1);assert.equal(gitCalls,0);assert.equal(p.runEngine,'api');
 p.diagnostics={record:async()=>{}};p.settings.syncEngine='git';
 p.syncGit=async()=>{throw new Error('mock Git failure');};await p.sync();
 assert.equal(p.lastError.engine,'git');assert.equal(p.lastError.selectedEngine,'git');assert.equal(p.lastError.pluginVersion,'working');
 await p.changeSyncEngine('api');p.syncApi=async()=>{};await p.sync();
 assert.equal(p.lastError.engine,'git');assert.equal(p.runEngine,'api');
 console.log('PASS guarded engine changes, captured run engine, failure provenance after successful API run');
} finally {await rm(dir,{recursive:true,force:true});}
