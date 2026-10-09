import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {LocalRecordBackend,LocalRecordAdapter} from '../record-backend.mjs';

const fixture=async t=>{const directory=await mkdtemp(join(tmpdir(),'hearwhispers-record-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;};
const data=value=>({version:1,products:[],items:[{id:'source1',snippet:'Retained source',note:value}],searches:{}});
async function crashedWriter(directory){
  const script='const {LocalRecordAdapter}=await import(process.argv[2]); const adapter=new LocalRecordAdapter(process.argv[1]); await adapter.acquirePublishLock(); process.exit(17);';
  const child=spawn(process.execPath,['--input-type=module','-e',script,directory,new URL('../record-backend.mjs',import.meta.url).href],{stdio:'ignore'});
  const [code]=await once(child,'exit');assert.equal(code,17);return child.pid;
}

test('a writer that exits while owning the local publish lock is recovered by PID liveness, preserving prior records',async t=>{
  const directory=await fixture(t),backend=new LocalRecordBackend(directory);await backend.compareAndSwap(0,data('Prior note'));
  const pid=await crashedWriter(directory);const owner=(await readdir(join(directory,'.record-publish-lock')))[0];assert(owner.startsWith(`owner-${pid}-`));
  assert.equal((await backend.read()).data.items[0].note,'Prior note');
  assert.equal(await backend.compareAndSwap(1,data('Recovered note')),true);assert.equal((await backend.read()).data.items[0].note,'Recovered note');
  await assert.rejects(()=>lstat(join(directory,'.record-publish-lock')),error=>error.code==='ENOENT');
});

test('a live writer is never stolen even when contenders time out; release requires its exact owner marker',async t=>{
  const directory=await fixture(t),owner=new LocalRecordAdapter(directory),contender=new LocalRecordAdapter(directory,{lockTimeoutMs:5});
  const token=await owner.acquirePublishLock();assert.equal(await contender.recoverDeadPublishLock(),false);
  await assert.rejects(()=>contender.acquirePublishLock(),error=>error.status===409);
  await assert.rejects(()=>contender.releasePublishLock(token.replace(/[a-f0-9]$/,last=>last==='a'?'b':'a')),error=>error.code==='ENOENT');
  assert.deepEqual(await readdir(join(directory,'.record-publish-lock')),[token]);await owner.releasePublishLock(token);
  const acquired=await contender.acquirePublishLock();await contender.releasePublishLock(acquired);
});

test('competing recovery contenders cannot remove a new owner or publish the same expected revision twice',async t=>{
  const directory=await fixture(t);await crashedWriter(directory);
  const backends=Array.from({length:8},()=>new LocalRecordBackend(directory));
  const outcomes=await Promise.all(backends.map((backend,index)=>backend.compareAndSwap(0,data(`Writer ${index}`))));assert.equal(outcomes.filter(Boolean).length,1);
  const result=await backends[0].read();assert.equal(result.revision,1);assert.equal(result.data.items[0].snippet,'Retained source');
});

test('ownerless, malformed and foreign-host locks fail closed instead of being stolen based on time',async t=>{
  for(const marker of [null,'not-an-owner','owner-2147483647-000000000000000000000000-00000000-0000-0000-0000-000000000000']){
    const directory=await fixture(t),adapter=new LocalRecordAdapter(directory,{lockTimeoutMs:1});await adapter.init();await mkdir(adapter.lock);if(marker)await mkdir(join(adapter.lock,marker));
    assert.equal(await adapter.recoverDeadPublishLock(),false);await assert.rejects(()=>adapter.acquirePublishLock(),error=>error.status===409);assert.equal((await lstat(adapter.lock)).isDirectory(),true);
  }
});
