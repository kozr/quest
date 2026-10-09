import {createHash, randomUUID} from 'node:crypto';
import {bootstrapWorkspace, accessContext, publicWorkspace} from './workspace.mjs';
import {ensureSubscription, planFor} from './plans.mjs';

const fail = (message, status = 403, code = 'workspace_access') => Object.assign(new Error(message), {status, code});
const identityKey = principal => {
  if (!principal || typeof principal.sub !== 'string' || !principal.sub || typeof principal.email !== 'string') throw fail('Sign in to select a workspace.', 401);
  return createHash('sha256').update(`google:${principal.sub}`).digest('hex');
};
const workspaceId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) || ['__proto__','prototype','constructor','workspace-directory'].includes(value)) throw fail('Workspace not found.', 404, 'workspace_not_found');
  return value;
};

// The index is only a discovery aid. Every resolution reads current membership
// from the selected workspace; stale index entries can never confer access.
export class WorkspaceRegistry {
  constructor({backend, storeFor, now = Date.now}) {
    if (!backend?.read || !backend?.compareAndSwap || typeof storeFor !== 'function') throw new TypeError('A registry backend and workspace store factory are required.');
    this.backend = backend;
    this.storeFor = storeFor;
    this.now = now;
  }
  async mutate(change) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const {revision, data} = await this.backend.read();
      const next = structuredClone(data || {});
      next.registryVersion ||= 1;
      if (next.registryVersion !== 1) throw fail('Unsupported workspace directory.', 503, 'workspace_directory_version');
      next.workspaces ||= {};
      next.identities ||= {};
      const result = change(next);
      if (await this.backend.compareAndSwap(revision, next)) return result;
    }
    throw fail('Another request is updating your workspaces. Try again.', 409, 'workspace_directory_conflict');
  }
  async register(id, principal, {name} = {}) {
    id = workspaceId(id);
    const key = identityKey(principal);
    // Validate membership before publishing a discovery entry, including calls
    // made after invitation acceptance or a legacy workspace migration.
    const store = await this.storeFor(id);
    const state = await store.snapshot();
    accessContext(state, principal, {}, planFor(state));
    return this.mutate(data => {
      data.workspaces[id] = {...data.workspaces[id],id, name: String(name || state.workspace?.name || 'Workspace').slice(0, 120), registeredAt: data.workspaces[id]?.registeredAt || new Date(this.now()).toISOString()};
      data.identities[key] = [...new Set([...(data.identities[key] || []), id])];
      return structuredClone(data.workspaces[id]);
    });
  }
  async resolve(principal, id) {
    identityKey(principal);
    id = workspaceId(id);
    const store = await this.storeFor(id);
    const state = await store.snapshot();
    if (!state.workspace) throw fail('Workspace not found.', 404, 'workspace_not_found');
    const access = accessContext(state, principal, {}, planFor(state));
    return {id, store, access, account: publicWorkspace(state, principal, planFor(state))};
  }
  async list(principal) {
    const key = identityKey(principal);
    const {data} = await this.backend.read();
    const ids = data?.identities?.[key] || [];
    const workspaces = [];
    // A small sequential bound avoids unbounded database fan-out. Revoked
    // members are removed from the response even with an old signed session.
    for (const id of ids.slice(0, 100)) {
      try {
        const result = await this.resolve(principal, id);
        workspaces.push({id, ...result.account});
      } catch (error) {
        if (![401, 403, 404].includes(error.status)) throw error;
      }
    }
    return workspaces;
  }
  async create(principal, {name = 'My workspace', requestId, trialDays = 7} = {}) {
    const key = identityKey(principal);
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw fail('Use a workspace name under 120 characters.', 400, 'workspace_name');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))) throw fail('Invalid workspace creation request.', 400, 'workspace_request');
    if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 30) throw new TypeError('Configure a trial between 1 and 30 days.');
    const at = this.now();
    const priorDirectory = (await this.backend.read()).data;
    const id = requestId ? `ws_${createHash('sha256').update(`${key}:${requestId}`).digest('hex').slice(0, 32)}` : priorDirectory?.provisioning?.[key]?.id || `ws_${randomUUID()}`;
    // Reserve one self-serve workspace per identity. Additional organizations
    // are operator-provisioned, preventing repeated free-trial resets.
    await this.mutate(data => {
      data.provisioning ||= {};
      const prior = data.provisioning[key];
      if (prior && prior.id !== id) throw fail('Your workspace is already provisioned. Open it or contact the workspace owner.', 409, 'workspace_exists');
      if ((data.identities[key] || []).some(existing => data.workspaces[existing]?.selfServeOwner === key && existing !== id)) throw fail('Your workspace is already provisioned.', 409, 'workspace_exists');
      data.provisioning[key] ||= {id, startedAt: new Date(at).toISOString(), name: name.trim()};
    });
    const store = await this.storeFor(id);
    if (typeof store.mutate !== 'function') throw new TypeError('Workspace stores must support atomic mutate.');
    await store.mutate(data => {
      if (data.workspace) {
        const access = accessContext(data, principal, {}, planFor(data));
        if (access.member.role !== 'owner') throw fail('Workspace creation cannot replace an existing workspace.');
        return;
      }
      bootstrapWorkspace(data, {id, name: name.trim(), owner: principal, now: at});
      ensureSubscription(data, {now: at, planId: 'starter', status: 'trial', trialEndsAt: new Date(at + trialDays * 86400000).toISOString()});
    });
    await this.register(id, principal, {name: name.trim()});
    await this.mutate(data => {
      data.workspaces[id].selfServeOwner = key;
      if (data.provisioning?.[key]?.id === id) delete data.provisioning[key];
    });
    return this.resolve(principal, id);
  }
  async serviceWorkspaces() {
    // This method is for an authenticated monitor service, never a user route.
    const {data} = await this.backend.read();
    return Object.keys(data?.workspaces || {}).sort();
  }
  async bindCustomer(id) {
    id=workspaceId(id);
    const state=await (await this.storeFor(id)).snapshot(),customer=state.billing?.customerId;
    if(!customer)return;
    if(!/^cus_[A-Za-z0-9_]+$/.test(customer)||state.workspace?.id!==id)throw fail('Invalid billing workspace binding.',409,'billing_binding_mismatch');
    return this.mutate(data=>{
      data.stripeCustomers ||= {};
      const key=`${state.billing.livemode?'live':'test'}:${customer}`;
      if(data.stripeCustomers[key]&&data.stripeCustomers[key]!==id)throw fail('Customer is already bound to another workspace.',409,'billing_binding_mismatch');
      data.stripeCustomers[key]=id;
    });
  }
  async customerWorkspace(customer,livemode) {
    if(typeof customer!=='string'||!/^cus_[A-Za-z0-9_]+$/.test(customer))return null;
    const {data}=await this.backend.read();
    return data?.stripeCustomers?.[`${livemode?'live':'test'}:${customer}`]||null;
  }
}
