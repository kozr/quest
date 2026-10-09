import * as workspace from './workspace.mjs';
import {PLAN_CATALOG, ensureSubscription, planFor, subscriptionState, capacityUsage, assertWorkspaceCapacity, assertSubscriptionActive, preserveServerOwnedState as preservePolicy} from './plans.mjs';
import {analysisUsageState} from './usage.mjs';
import {restoreSourceProvenance} from './restore-provenance.mjs';

export function initializeAccount(data, {id, name, owner, planId = 'starter', status = 'manual', trialEndsAt, now = Date.now()} = {}) {
  // Called by a trusted provisioner or the authenticated create-workspace flow.
  // The HTTP body must never choose its own effective subscription.
  if (data.workspace) {
    const context = workspace.accessContext(data, owner, {admin:true}, planFor(data));
    if (context.member.role !== 'owner') throw Object.assign(new Error('Only the existing owner can initialize this workspace.'), {status:403,code:'owner_required'});
  } else workspace.bootstrapWorkspace(data, {id, name, owner, now});
  ensureSubscription(data, {planId, status, trialEndsAt, now});
  assertWorkspaceCapacity(data, {now});
  return accountSnapshot(data, owner, now);
}

const actions = Object.freeze({
  'invite.create':workspace.createInvite,
  'invite.accept':workspace.acceptInvite,
  'invite.revoke':workspace.revokeInvite,
  'member.update':workspace.updateMember,
  'member.remove':workspace.removeMember,
  'client.create':workspace.createClient,
  'client.update':workspace.updateClient,
  'client.delete':workspace.deleteClient,
  'product.client':workspace.assignProductClient,
  'review.update':workspace.updateReview,
});
export function changeAccount(data, principal, action, input = {}, now = Date.now()) {
  if (!Object.hasOwn(actions, action)) throw Object.assign(new Error('Unknown account action.'), {status:400,code:'account_action'});
  // Read-only access to stored records survives cancellation. Paid mutations,
  // invitation creation and assignment consume current entitlements.
  if (!['invite.revoke','member.remove','review.update'].includes(action)) assertSubscriptionActive(data, now);
  const result = actions[action](data, principal, {...input, now}, planFor(data));
  // Cleanup operations must remain possible when an account is over capacity.
  if (!['invite.revoke','member.remove','client.delete','review.update'].includes(action)) assertWorkspaceCapacity(data, {now});
  return result;
}
export function accountSnapshot(data, principal, now = Date.now()) {
  const account = workspace.publicWorkspace(data, principal, planFor(data), now);
  const result = {account, entitlements:structuredClone(planFor(data)), subscription:subscriptionState(data, now)};
  // Client-scoped users do not get another client's aggregate usage.
  if (account.permissions.manage) {
    result.usage = {capacity:capacityUsage(data, {now}), analysis:analysisUsageState(data, now)};
    result.plans = Object.values(PLAN_CATALOG).map(plan=>structuredClone(plan));
  }
  return result;
}
export function accountRestore(current, incoming, now = Date.now()) {
  return preservePolicy(current, workspace.preserveServerOwnedState(current, restoreSourceProvenance(current,incoming)), {now});
}
