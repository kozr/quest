import {useEffect,useState} from 'react';
import {api} from './api';

export function useConversationPage(state,{enabled,productId,query,platform,status,relevance,page,limit=5}) {
 const key=JSON.stringify([productId,query,platform,status,relevance,page,limit]);
 const [result,setResult]=useState({key:null,items:[],total:0,loading:false,error:''});
 useEffect(()=>{
  if(!enabled)return;
  const controller=new AbortController();
  setResult(old=>old.key===key?{...old,loading:true,error:''}:{key,items:[],total:0,loading:true,error:''});
  const params=new URLSearchParams({productId,query,platform,status,relevance:relevance||'all',offset:String(page*limit),limit:String(limit)});
  const timer=setTimeout(()=>api(`/conversations?${params}`,{signal:controller.signal}).then(next=>{if(!controller.signal.aborted)setResult({...next,key,loading:false,error:''});}).catch(error=>{if(!controller.signal.aborted)setResult(old=>({...old,key,loading:false,error:error.message}));}),query?200:0);
  return()=>{clearTimeout(timer);controller.abort();};
 },[enabled,state,key]);
 return enabled&&result.key!==key?{items:[],total:0,loading:true,error:''}:result;
}
