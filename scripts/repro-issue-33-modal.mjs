import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'i33-modal-'));
class Node {
 constructor(tag='div',opts={}){this.tag=tag;this.cls=opts.cls;this.children=[];this.events={};this.text=opts.text||'';}
 createEl(tag,opts){const n=new Node(tag,opts);this.appendChild(n);return n;}
 createDiv(opts){return this.createEl('div',opts);}
 appendChild(n){n.remove();this.children.push(n);n.parent=this;}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}}
 empty(){for(const n of [...this.children])n.remove();}
 addClass(){} toggleClass(){} setText(s){this.text=s;}
 addEventListener(e,fn){this.events[e]=fn;}
 all(){return [this,...this.children.flatMap(n=>n.all())];}
}
globalThis.TestNode=Node;globalThis.createDiv=()=>new Node();
try {
 const stub=join(dir,'obsidian.mjs'),out=join(dir,'modal.mjs');
 await writeFile(stub,`export class Modal {constructor(){this.contentEl=new globalThis.TestNode();this.titleEl=new globalThis.TestNode();this.modalEl=new globalThis.TestNode();this.containerEl=new globalThis.TestNode();} open(){this.onOpen();} close(){this.onClose();}} export class Setting {constructor(node){this.node=node;} setName(){return this;} addDropdown(fn){const dd={addOption(){return dd;},setValue(){return dd;},onChange(fn){dd.change=fn;return dd;}};fn(dd);return this;}}`);
 await build({entryPoints:['src/api-conflict-modal.ts'],outfile:out,bundle:true,platform:'node',format:'esm',alias:{obsidian:stub},plugins:[{name:'keyboard',setup(b){b.onResolve({filter:/mobile-keyboard/},()=>({path:'keyboard',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const keepModalAboveKeyboard=()=>()=>{};export const scrollIntoViewOnFocus=()=>{};'}));}}],logLevel:'error'});
 const {ApiConflictModal}=await import(out);
 const NativeDecoder=globalThis.TextDecoder;let decodeCalls=0,maxDecode=0;
 // Module-level text decoder was already created; count every decoder through prototype.
 const originalDecode=NativeDecoder.prototype.decode;
 NativeDecoder.prototype.decode=function(bytes,...args){decodeCalls++;maxDecode=Math.max(maxDecode,bytes?.byteLength||0);return originalDecode.call(this,bytes,...args);};
 try {
 const large=new Uint8Array(64931472);large[0]=0xff;
 const files=Array.from({length:55},(_,i)=>({path:`image${i}.bin`,localContent:large,remoteContent:large}));
 let result=null,cancelled=0;const modal=new ApiConflictModal({},files,r=>result=r,()=>cancelled++);
 const stages=[];modal.onLifecycle=s=>stages.push(s);modal.open();
 assert.equal(modal.contentEl.all().filter(n=>n.cls==='gitsync-conflict-step').length,1);
 assert.equal(modal.contentEl.all().filter(n=>n.tag==='textarea').length,0);
 assert.equal(decodeCalls,0,'NUL-containing binary rejected without text decoding');
 assert.equal(modal.states.filter(s=>s.binary!==undefined).length,1,'unvisited files are not classified');
 modal.resolve();assert.equal(result,null,'unreviewed conflicts cannot be silently submitted');
 modal.showStep(54);assert.equal(modal.contentEl.all().filter(n=>n.cls==='gitsync-conflict-step').length,1);
 modal.selectAll('local');modal.resolve();assert.equal(result.size,55);for(const value of result.values())assert.equal(value,large,'full original binary is preserved');assert.equal(cancelled,0);
 const bytes=new TextEncoder().encode('hello');result=null;
 const textModal=new ApiConflictModal({},[{path:'a',localContent:bytes,remoteContent:bytes},{path:'b',localContent:bytes,remoteContent:null}],r=>result=r,()=>cancelled++);
 textModal.open();const ta=textModal.contentEl.all().find(n=>n.tag==='textarea');ta.value='edited';ta.events.input();
 textModal.showStep(1);textModal.showStep(0);assert.equal(textModal.contentEl.all().find(n=>n.tag==='textarea').value,'edited');
 textModal.resolve();assert.equal(new NativeDecoder().decode(result.get('a')),'edited');assert.equal(result.get('b'),null);
 const boundary=new TextEncoder().encode('a'.repeat(65535)+'€');
 const m=new ApiConflictModal({},[{path:'utf8',localContent:boundary,remoteContent:boundary}],()=>{},()=>{});m.open();assert.equal(m.states[0].binary,false,'split UTF-8 codepoint validates');
 const invalid=new Uint8Array(1048576).fill(0xff);const n=new ApiConflictModal({},[{path:'invalid',localContent:invalid,remoteContent:invalid}],()=>{},()=>cancelled++);maxDecode=0;n.open();assert.equal(n.states[0].binary,true);assert.ok(maxDecode<=65536);n.close();assert.equal(cancelled,1);
 console.log('PASS actual modal: 55 large binary conflicts, one DOM card, no binary editor, bounded detection, explicit bulk, edits/navigation, UTF-8 boundaries, close');
 } finally {NativeDecoder.prototype.decode=originalDecode;}
 const diagOut=join(dir,'diag.mjs');await build({entryPoints:['src/sync-diagnostics.ts'],outfile:diagOut,bundle:true,platform:'node',format:'esm',logLevel:'error'});
 const {SyncDiagnostics}=await import(diagOut);let release;const stalled=new Promise(r=>release=r);let writes=[];
 const d=new SyncDiagnostics({exists:async()=>{await stalled;return true;},write:async(p,s)=>writes.push(JSON.parse(s))},'diag');
 const p=d.record({stage:'conflict-modal-open'},1000);release();await p;await d.record({stage:'conflict-modal-rendered'},53000);
 assert.equal(writes.at(-1)[0].time,new Date(1000).toISOString());assert.equal(writes.at(-1)[1].time,new Date(53000).toISOString());
 console.log('PASS occurrence timestamps survive delayed diagnostic I/O');
} finally {await rm(dir,{recursive:true,force:true});}
