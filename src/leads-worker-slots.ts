import {randomUUID} from 'node:crypto';
import type {Store} from './database.js';
import {QUALIFICATION_CONCURRENCY} from './leads-discovery-config.js';

/** Recovery and immediate dispatch share these slots and per-job budget claims. */
export async function claimLeadSlot(store:Store,kind:'qualify'|'discover',now:number) {
  const token=randomUUID(),count=kind==='qualify'?QUALIFICATION_CONCURRENCY:1;
  return store.atomic(async s=>{
    const ids=Array.from({length:count},(_,i)=>`${kind}-slot-${i}`);
    const rows=await Promise.all(ids.map(id=>s.get<{leaseUntil:number}>('lead_control',id)));
    const index=rows.findIndex(row=>!row||row.leaseUntil<=now);
    if(index<0) return undefined;
    const id=ids[index];
    await s.set('lead_control',id,{leaseToken:token,leaseUntil:now+(kind==='qualify'?90_000:210_000)});
    return {id,token};
  });
}
export async function releaseLeadSlot(store:Store,slot:{id:string;token:string}) {
  await store.atomic(async s=>{
    const row=await s.get<{leaseToken:string}>('lead_control',slot.id);
    if(row?.leaseToken===slot.token) await s.delete('lead_control',slot.id);
  });
}
