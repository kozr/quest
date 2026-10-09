import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {createRequestGate} from './request-gate.mjs';

// Rich tools load on demand. Background summary polls share a pending request;
// a manual post-save refresh supersedes it through the client refresh epoch.
export function useWorkspaceDetails(summary,enabled){
 const key=`${summary.account?.id||'private'}:${summary._clientRefreshEpoch||0}`;
 const gate=useRef(null);gate.current ||= createRequestGate();
 const [result,setResult]=useState(null),[error,setError]=useState('');
 useEffect(()=>()=>gate.current.cancel(),[enabled]);
 useEffect(()=>{
  if(!enabled||!summary.lightweight)return;
  gate.current.run(key,signal=>api('/state',{signal}),data=>{setResult({key,data});setError('');},e=>setError(e.message)).catch(()=>{});
 },[enabled,summary.lightweight,summary.revision,key]);
 const ready=!summary.lightweight||!enabled||result?.key===key;
 return {state:ready&&enabled&&summary.lightweight?{...result.data,_clientRefreshEpoch:summary._clientRefreshEpoch}:summary,loading:!ready,error};
}
