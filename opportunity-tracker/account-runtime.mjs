import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Store} from './store.mjs';
import {planFor, activeProduct, assertSubscriptionActive} from './plans.mjs';
import {accessContext,authorizeProduct,filterWorkspaceState} from './workspace.mjs';
import {accountSnapshot} from './account.mjs';

const denied = (message,status=403,code='workspace_access') => Object.assign(new Error(message),{status,code});
const productMethods = new Set(['deleteProduct','saveSearchPlan','saveDrafts','saveVideos','claimStage','claimAnalysis','beginBackfill','beginCollection','markMonitorAttempt','claimQualificationBatch','claimQualification','claimCollection','claimSearch']);
const managementMethods = new Set(['importData','claimBusinessProfile']);

function authorizeMutation(data,principal,method,args) {
  const plan=planFor(data);
  if(method==='saveProduct') {
    if(args[1])authorizeProduct(data,principal,args[1],{write:true},plan);
    else accessContext(data,principal,{admin:true,write:true},plan);
  } else if(productMethods.has(method)) {
    const product=authorizeProduct(data,principal,['claimQualificationBatch','claimQualification'].includes(method)?args[2]:method==='claimCollection'?args[1]:args[0],{write:true},plan);
    if(!activeProduct(product)&&!['deleteProduct','saveSearchPlan','saveDrafts','saveVideos'].includes(method))throw denied('Activate this product before starting new work.',409,'product_archived');
  } else if(method==='updateItem') {
    const item=data.items.find(row=>row.id===args[0]);
    if(!item)throw denied('Conversation not found.',404,'item_not_found');
    authorizeProduct(data,principal,item.productId,{write:true},plan);
  } else if(managementMethods.has(method)) {
    const access=accessContext(data,principal,{admin:true,write:true},plan);
    if(method==='importData'&&access.member.role!=='owner')throw denied('Only a workspace owner can restore a backup.',403,'owner_required');
  }
}

// Recheck roles and scopes inside the same CAS mutation as the protected write.
// Provider settlement methods are internal continuations of already claimed
// work and must still settle their cost/lease when a member is revoked midway.
function authorizedStore(target,principal) {
  return new Proxy(target,{get(store,key){
    const value=store[key];
    if(typeof value!=='function')return value;
    if(key==='saveProduct'||key==='updateItem'||productMethods.has(key)||managementMethods.has(key))return (...args)=>store.mutate(data=>{
      authorizeMutation(data,principal,key,args);
      if(key==='claimSearch'){
        const now=Date.now(),product=data.products.find(row=>row.id===args[0]);
        if(data.subscription){assertSubscriptionActive(data,now);if(!activeProduct(product)||product.planMonitoringBlocked)throw denied('This product is paused under the current plan.',409,product.planMonitoringBlocked||'product_archived');}
        data.leases ||= {};if(data.leases[args[0]]?.expiresAt>now)return null;
        const token=randomUUID();data.leases[args[0]]={token,expiresAt:now+90000};return token;
      }
      const memory=Object.create(Store.prototype);memory.data=data;
      memory.commit=next=>{for(const name of Object.keys(data))delete data[name];Object.assign(data,next);memory.data=data;};
      return memory[key](...args);
    });
    return value.bind(store);
  }});
}

export function authorizeApiRequest(data,principal,{path,method,body={}}) {
  const plan=planFor(data),write=!['GET','HEAD'].includes(method);
  accessContext(data,principal,{write},plan);
  if(path==='/api/import'||path==='/api/export') {
    const access=accessContext(data,principal,{admin:true},plan);
    if(access.member.role!=='owner')throw denied('Only a workspace owner can manage full backups.',403,'owner_required');
  }
  if(path.startsWith('/api/admin/')||path==='/api/profile'||path==='/api/metadata'||path==='/api/communities/check'||path==='/api/products'&&write)accessContext(data,principal,{admin:true,write},plan);
  const product=path.match(/^\/api\/products\/([^/]+)(?:\/|$)/);
  if(product)authorizeProduct(data,principal,decodeURIComponent(product[1]),{write},plan);
  const item=path.match(/^\/api\/items\/([^/]+)(?:\/|$)/);
  if(item) {
    const record=data.items.find(row=>row.id===decodeURIComponent(item[1]));
    if(!record)throw denied('Conversation not found.',404,'item_not_found');
    authorizeProduct(data,principal,record.productId,{write},plan);
  }
  if(path==='/api/qualification/run')authorizeProduct(data,principal,body.productId,{write:true},plan);
}

export function createAccountRuntime({defaultStore,defaultWorkspace,registry,principalFor,ready=Promise.resolve()}) {
  if(!defaultStore||typeof principalFor!=='function')throw new TypeError('Account runtime requires a store and verified principal resolver.');
  const context=new AsyncLocalStorage();
  const proxy=new Proxy(defaultStore,{get(_target,key){
    const target=context.getStore()?.store||defaultStore,value=target[key];
    return typeof value==='function'?value.bind(target):value;
  }});
  const current=()=>context.getStore();
  async function resolve(id) {
    if(id===defaultWorkspace)return defaultStore;
    if(!registry||typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw denied('Workspace not found.',404,'workspace_not_found');
    return registry.storeFor(id);
  }
  async function middleware(req,_res,next) {
    if(!req.path.startsWith('/api/')||['/api/auth','/api/login/google','/api/logout'].includes(req.path)||['/api/workspaces','/api/monitor/workspaces','/api/billing/webhook'].includes(req.path)||/^\/api\/workspaces\/[^/]+\/invites\/accept$/.test(req.path))return next();
    try {
      await ready;
      const service=req.path==='/api/monitor'||req.path.startsWith('/api/monitor/');
      const principal=service?null:principalFor(req);
      if(!service&&!principal)throw denied('Sign in to choose a workspace.',401,'identity_required');
      let id=req.get('X-Workspace-ID');
      if(!id&&!service&&registry) {
        const workspaces=await registry.list(principal);
        if(workspaces.length===1)id=workspaces[0].id;
        else throw denied(workspaces.length?'Choose a workspace to continue.':'Create or join a workspace to continue.',409,workspaces.length?'workspace_selection_required':'workspace_setup_required');
      }
      id ||= defaultWorkspace;
      const raw=await resolve(id),data=await raw.snapshot();
      if(!data.workspace)throw denied('Create or select your workspace to continue.',409,'workspace_setup_required');
      if(data.workspace.id!==id)throw denied('Workspace identity does not match its storage.',503,'workspace_identity_mismatch');
      if(!service)authorizeApiRequest(data,principal,req);
      const store=service?raw:authorizedStore(raw,principal);
      return context.run({workspaceId:id,principal,service,store,rawStore:raw},next);
    } catch(error){next(error);}
  }
  async function publicSnapshot(now=Date.now()) {
    const active=current();
    if(!active||active.service)throw denied('A member session is required.',401,'identity_required');
    const data=await active.rawStore.snapshot();active.snapshot=data;const scoped=filterWorkspaceState(data,active.principal,planFor(data),now,{itemLimit:100,evidenceLimit:50});
    return {data:scoped,...accountSnapshot(data,active.principal,now)};
  }
  async function runService(id,operation) {
    await ready;
    const raw=await resolve(id),data=await raw.snapshot();
    if(!data.workspace||data.workspace.id!==id)throw denied('Workspace not found.',404,'workspace_not_found');
    return context.run({workspaceId:id,principal:null,service:true,store:raw,rawStore:raw},operation);
  }
  return {store:proxy,current,middleware,publicSnapshot,runService,resolve};
}
