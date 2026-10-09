import {join} from 'node:path';
import {Store} from './store.mjs';
import {FirestoreStore,FirestoreBackend} from './firestore-store.mjs';
import {LocalRecordBackend,FirestoreRecordBackend} from './record-backend.mjs';
import {WorkspaceRegistry} from './workspace-registry.mjs';
import {createAccountRuntime} from './account-runtime.mjs';

const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id)&&!['__proto__','prototype','constructor','workspace-directory'].includes(id);
const failure=message=>Object.assign(new Error(message),{status:503,code:'account_configuration'});

// Account storage is explicitly enabled during launch/migration. A previously
// private workspace is never assigned to the first person who signs in.
export function createAccountPlatform({dataDirectory,db,providedStore,workspace,principalFor,env={},registry:providedRegistry,storeFor:providedFactory}) {
  if(!validId(workspace))throw failure('Configure a valid default workspace identifier.');
  const cache=new Map();
  if(providedStore)cache.set(workspace,providedStore);
  function storeFor(id) {
    if(!validId(id))throw Object.assign(new Error('Workspace not found.'),{status:404,code:'workspace_not_found'});
    if(cache.has(id))return cache.get(id);
    let store;
    if(providedFactory)store=providedFactory(id);
    else if(db)store=new FirestoreStore(new FirestoreRecordBackend(db,id,{legacyBackend:new FirestoreBackend(db,id)}));
    else {
      const location=id===workspace?dataDirectory:join(dataDirectory,'workspaces',id);
      const legacy=new Store(location);
      store=new FirestoreStore(new LocalRecordBackend(location,{legacyBackend:{read:async()=>({revision:0,data:legacy.snapshot()})}}));
    }
    cache.set(id,store);return store;
  }
  const defaultStore=storeFor(workspace);
  const directoryBackend=db?new FirestoreRecordBackend(db,'workspace-directory',{empty:()=>({})}):new LocalRecordBackend(join(dataDirectory,'workspace-directory'),{empty:()=>({})});
  const registry=providedRegistry||new WorkspaceRegistry({backend:directoryBackend,storeFor});
  const ready=(async()=>{
    const state=await defaultStore.snapshot();
    const sub=env.TRACKER_WORKSPACE_OWNER_SUB,email=env.TRACKER_WORKSPACE_OWNER_EMAIL;
    if(!state.workspace&&sub&&email) {
      if(!/^\d{1,255}$/.test(sub))throw failure('The migration owner must be an explicit Google subject.');
      await defaultStore.initializeAccount({id:workspace,name:env.TRACKER_WORKSPACE_NAME||'My workspace',owner:{sub,email},planId:env.TRACKER_WORKSPACE_MIGRATION_PLAN||'starter',status:'manual'});
    }
    const current=await defaultStore.snapshot();
    if(current.workspace)for(const member of Object.values(current.workspace.members||{}))if(member.status==='active')await registry.register(workspace,{sub:member.sub,email:member.email});
  })();
  // Save rejected setup for middleware without an unhandled rejection at boot.
  ready.catch(()=>{});
  const runtime=createAccountRuntime({defaultStore,defaultWorkspace:workspace,registry,principalFor,ready});
  return {...runtime,registry,ready,storeFor,defaultStore};
}
