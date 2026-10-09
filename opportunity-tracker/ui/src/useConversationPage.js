import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {createRequestGate} from './request-gate.mjs';

export function useConversationPage(state,{enabled,productId,query,platform,status,relevance,page,limit=5}) {
 const key=JSON.stringify([state?._clientRefreshEpoch||0,productId,query,platform,status,relevance,page,limit]);
 const requests=useRef(null);requests.current ||= createRequestGate();
 const [result,setResult]=useState({key:null,items:[],total:0,loading:false,error:''});
 // State polling refreshes this resource, but does not invalidate a slow page.
 // Filter changes and unmounts still cancel it and suppress stale responses.
 useEffect(()=>()=>requests.current.cancel(),[enabled,key]);
 useEffect(()=>{
  if(!enabled)return;
  setResult(old=>old.key===key?{...old,loading:true,error:''}:{key,items:[],total:0,loading:true,error:''});
  const params=new URLSearchParams({productId,query,platform,status,relevance:relevance||'all',offset:String(page*limit),limit:String(limit)});
  requests.current.run(key,async signal=>{
   if(query)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Request canceled','AbortError'));},{once:true});});
   if(signal.aborted)throw new DOMException('Request canceled','AbortError');
   return api(`/conversations?${params}`,{signal});
  },next=>setResult({...next,key,loading:false,error:''}),error=>setResult(old=>({...old,key,loading:false,error:error.message}))).catch(()=>{});
 },[enabled,state,key]);
 return enabled&&result.key!==key?{items:[],total:0,loading:true,error:''}:result;
}
