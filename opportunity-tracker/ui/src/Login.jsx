import {useEffect,useRef,useState} from 'react';
import {BrandIcon} from '@/components/brand-icon';
import {Button} from '@/components/ui/button';
import {api} from './api';
let googleScript;
function loadGoogle(){
 if(window.google?.accounts?.id)return Promise.resolve(window.google.accounts.id);
 if(!googleScript)googleScript=new Promise((resolve,reject)=>{
  const s=document.createElement('script');const fail=()=>{clearTimeout(timer);s.remove();reject(Error('Google sign-in could not load. Check your connection and try again.'));};
  const timer=setTimeout(fail,15000);s.src='https://accounts.google.com/gsi/client';s.async=true;
  s.onload=()=>{clearTimeout(timer);window.google?.accounts?.id?resolve(window.google.accounts.id):fail();};s.onerror=fail;document.head.append(s);
 }).catch(e=>{googleScript=null;throw e;});return googleScript;
}
export function Login({configuration,onSignedIn}){
 const ref=useRef(null),signing=useRef(false);const [message,setMessage]=useState('Loading Google sign-in…'),[retry,setRetry]=useState(0),[failed,setFailed]=useState(false);
 useEffect(()=>{let alive=true;
  (async()=>{setFailed(false);setMessage('Loading Google sign-in…');try{
   const auth=retry?await api('/auth'):configuration;if(auth.authenticated){await onSignedIn();return;}
   if(!auth.google)throw Error('Google sign-in is unavailable. Try again shortly.');
   const google=await loadGoogle();if(!alive)return;
   google.initialize({client_id:auth.google.clientId,nonce:auth.google.nonce,auto_select:false,callback:async response=>{
    if(!alive||signing.current)return;signing.current=true;setMessage('Signing in…');
    try{await api('/login/google',{method:'POST',headers:{'X-Tracker-Login':auth.google.nonce},body:{credential:response.credential}});if(alive)await onSignedIn();}
    catch(e){if(alive){setMessage(e.message);setFailed(true);}}finally{signing.current=false;}
   }});
   ref.current.replaceChildren();google.renderButton(ref.current,{type:'standard',theme:'outline',size:'large',text:'continue_with',shape:'rectangular',width:Math.min(360,ref.current.clientWidth)});setMessage('');
  }catch(e){if(alive){setMessage(e.message);setFailed(true);}}})();return()=>{alive=false;};
 },[configuration,retry,onSignedIn]);
 return <main className="login-page review-desk"><div className="login-brand"><BrandIcon/><span>HearWhispers</span></div><section><h1>Your conversations,<br/>in one workspace.</h1><p>Sign in to review relevant discussions, keep useful conversations, and prepare your response.</p><div ref={ref} id="google-sign-in"/><p role={failed?'alert':'status'} className={failed?'form-error':'muted'}>{message}</p>{failed&&<Button variant="outline" onClick={()=>setRetry(n=>n+1)}>Retry Google sign-in</Button>}<p className="login-footnote">Access is limited to the Google account allowed for this private workspace.</p></section></main>;
}
