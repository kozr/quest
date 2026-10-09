// Coalesce repeated refreshes while one request is pending. Only a changed
// resource key or explicit cancellation supersedes the current response.
export function createRequestGate(){
 let active=null;
 const cancel=()=>{const prior=active;active=null;prior?.controller.abort();};
 return {cancel,run(key,load,accept,reject=()=>{}){
  if(active?.key===key)return active.promise;
  cancel();
  const request={key,controller:new AbortController()};active=request;
  const current=()=>active===request&&!request.controller.signal.aborted;
  request.promise=Promise.resolve().then(()=>load(request.controller.signal)).then(value=>{if(current())accept(value);return value;},error=>{if(current())reject(error);throw error;}).finally(()=>{if(active===request)active=null;});
  return request.promise;
 }};
}
