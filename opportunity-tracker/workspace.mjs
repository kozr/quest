import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

// These functions mutate the supplied state synchronously. Run one mutation in
// Store.commit / FirestoreStore.mutate so membership and seat checks commit with
// their changes. A verified principal must come from server authentication;
// request bodies and imported backups must never supply it.
const ROLES = new Set(['owner', 'admin', 'member', 'viewer']);
const INVITE_ROLES = new Set(['admin', 'member', 'viewer']);
const REVIEW_FIELDS = new Set(['status', 'note', 'draft', 'assigneeSub']);
export const WORKSPACE_VERSION = 1;
export const INVITE_TTL_MS = 7 * 86400000;
export const SERVER_OWNED_STATE_KEYS = Object.freeze([
  'workspace', 'subscription', 'quota', 'quotaUsage', 'planUsage', 'usage',
  'analysisUsage', 'analysisCycles', 'aiBudget', 'pilotBudget', 'collectedUsage', 'notifications', 'notificationOutbox',
  'integrations', 'billing', 'loginFailures', 'leases', 'analysisLeases',
  'loopSchedules', 'collection', 'ingestion', 'conversationReviewReceipts',
  'conversationReviewFailures', 'qualifications', 'qualificationMigrations',
]);
const fail = (message, status = 400, code = 'workspace_invalid') => {
  throw Object.assign(new Error(message), {status, code});
};
const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const timestamp = value => {
  const at = value ?? Date.now();
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime()) || at < 0) fail('Use a valid time.');
  return at;
};
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const cleanEmail = value => {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) fail('Enter a valid email address.');
  return value.trim().toLowerCase();
};
const cleanName = (value, fallback = '') => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) fail('Use a name from 1 to 120 characters.');
  return value.trim();
};
export function verifiedPrincipal(value) {
  if (!value || typeof value.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(value.sub) || ['__proto__', 'prototype', 'constructor'].includes(value.sub)) fail('A verified account is required.', 401, 'identity_required');
  return {sub: value.sub, email: cleanEmail(value.email), ...(value.name ? {name: cleanName(value.name)} : {}), authoritativeEmail: value.authoritativeEmail === true || value.emailAuthoritative === true || cleanEmail(value.email).endsWith('@gmail.com')};
}
function workspace(data) {
  if (!data?.workspace || data.workspace.version !== WORKSPACE_VERSION || !data.workspace.members || !data.workspace.invites || !data.workspace.clients) fail('This workspace needs an explicit owner setup.', 403, 'workspace_uninitialized');
  return data.workspace;
}
function policy(entitlements) {
  const seats = entitlements?.seats ?? entitlements?.limits?.seats;
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 100000) fail('Workspace plan entitlements are unavailable.', 503, 'entitlements_unavailable');
  return {seats, features: entitlements.features || {}};
}
function shared(entitlements) {
  return policy(entitlements).features.sharedReview === true;
}
function feature(entitlements, name) {
  const features = policy(entitlements).features;
  if (features[name] !== true && !(name === 'clientSeparation' && features.clients === true)) fail('This workspace plan does not include this feature.', 403, 'plan_feature_required');
}
function seatMembers(w) {
  return Object.values(w.members).filter(member => member.status === 'active').sort((a, b) =>
    Number(b.sub === w.bootstrapOwnerSub) - Number(a.sub === w.bootstrapOwnerSub) ||
    Number(b.role === 'owner') - Number(a.role === 'owner') ||
    String(a.createdAt).localeCompare(String(b.createdAt)) || a.sub.localeCompare(b.sub));
}
export function seatUsage(data, now = Date.now()) {
  const w = workspace(data), at = timestamp(now);
  const active = Object.values(w.members).filter(member => member.status === 'active').length;
  const pending = Object.values(w.invites).filter(invite => invite.status === 'pending' && Date.parse(invite.expiresAt) > at).length;
  return {active, pending, reserved: active + pending};
}
function activeMember(data, principal, entitlements) {
  const p = verifiedPrincipal(principal), w = workspace(data), plan = policy(entitlements);
  const member = Object.hasOwn(w.members, p.sub) ? w.members[p.sub] : null;
  if (!member || member.status !== 'active' || !ROLES.has(member.role)) fail('This account does not have access to this workspace.', 403, 'membership_required');
  // Revocation and downgrade checks happen on every request, not only login.
  const admitted = seatMembers(w).slice(0, shared(entitlements) ? plan.seats : 1);
  if (!admitted.some(row => row.sub === member.sub)) fail('This account exceeds the current workspace seat allowance.', 403, 'seat_unavailable');
  return member;
}
function isManager(member) { return member.role === 'owner' || member.role === 'admin'; }
function manager(data, principal, entitlements) {
  const member = activeMember(data, principal, entitlements);
  if (!isManager(member)) fail('Only workspace owners and admins can make this change.', 403, 'role_required');
  return member;
}
function mayManage(actor, targetRole, desiredRole = targetRole) {
  if (actor.role !== 'owner' && (['owner', 'admin'].includes(targetRole) || ['owner', 'admin'].includes(desiredRole))) fail('Only an owner can manage owners or admins.', 403, 'owner_required');
}
function audit(w, actorSub, action, targetId, at, details = {}) {
  w.audit ||= [];
  w.audit.push({id: randomUUID(), at: iso(at), actorSub, action, targetId, ...details});
  if (w.audit.length > 2000) w.audit = w.audit.slice(-2000);
  w.updatedAt = iso(at);
}
function scopes(w, value, role, entitlements) {
  if (role === 'owner' || role === 'admin') {
    if (value !== undefined && value !== 'all') fail('Owners and admins have workspace-wide access.');
    return 'all';
  }
  if (value === undefined || value === 'all') return 'all';
  feature(entitlements, 'clientSeparation');
  if (!Array.isArray(value) || value.length > 100 || value.some(id => !validId(id) || !Object.hasOwn(w.clients, id))) fail('Choose existing client workspaces.');
  return [...new Set(value)];
}
function canSeeClient(member, clientId) {
  return isManager(member) || member.clientIds === 'all' || Boolean(clientId && Array.isArray(member.clientIds) && member.clientIds.includes(clientId));
}
function memberPublic(member, revealEmail = true) {
  return {sub: member.sub, ...(revealEmail ? {email: member.email} : {}), ...(member.name ? {name: member.name} : {}), role: member.role, status: member.status, clientIds: clone(member.clientIds), createdAt: member.createdAt, updatedAt: member.updatedAt};
}
function invitePublic(invite) {
  return {id: invite.id, email: invite.email, role: invite.role, clientIds: clone(invite.clientIds), status: invite.status, expiresAt: invite.expiresAt, createdAt: invite.createdAt, ...(invite.acceptedAt ? {acceptedAt: invite.acceptedAt} : {})};
}
function currentProduct(data, productOrId) {
  const id = typeof productOrId === 'string' ? productOrId : productOrId?.id;
  const product = (data.products || []).find(row => row.id === id);
  if (!product) fail('Product not found.', 404, 'product_not_found');
  return product;
}
function clearInaccessibleAssignments(data, actorSub, at, reason) {
  const w = workspace(data);
  for (const review of Object.values(w.reviews || {})) {
    if (!review.assigneeSub) continue;
    const assignee = Object.hasOwn(w.members, review.assigneeSub) ? w.members[review.assigneeSub] : null;
    const product = (data.products || []).find(row => row.id === review.productId);
    if (assignee?.status === 'active' && assignee.role !== 'viewer' && product && canSeeClient(assignee, product.clientId)) continue;
    review.assigneeSub = null; review.version++; review.updatedAt = iso(at); review.updatedBy = actorSub;
    review.events ||= []; review.events.push({at: iso(at), actorSub, version: review.version, changes: {assigneeSub: null}, reason});
    review.events = review.events.slice(-100);
  }
}
function maintainPrimaryOwner(w) {
  if (w.members[w.bootstrapOwnerSub]?.status === 'active' && w.members[w.bootstrapOwnerSub]?.role === 'owner') return;
  w.bootstrapOwnerSub = seatMembers(w).find(member => member.role === 'owner')?.sub;
}

export function bootstrapWorkspace(data, {id, name = 'My workspace', owner, now} = {}) {
  if (data.workspace) fail('The workspace already has an owner.', 409, 'workspace_exists');
  if (!validId(id)) fail('Use a valid workspace ID.');
  const principal = verifiedPrincipal(owner), at = timestamp(now), displayName = cleanName(name);
  const member = {sub: principal.sub, email: principal.email, ...(principal.name ? {name: principal.name} : {}), role: 'owner', status: 'active', clientIds: 'all', createdAt: iso(at), updatedAt: iso(at)};
  data.workspace = {version: WORKSPACE_VERSION, id, name: displayName, bootstrapOwnerSub: member.sub, members: {[member.sub]: member}, invites: {}, clients: {}, reviews: {}, audit: [], createdAt: iso(at), updatedAt: iso(at)};
  audit(data.workspace, member.sub, 'workspace.created', id, at);
  return {id, name: displayName, member: memberPublic(member)};
}

export function authorizeProduct(data, principal, productOrId, {write = false} = {}, entitlements) {
  const member = activeMember(data, principal, entitlements), product = currentProduct(data, productOrId);
  if (!canSeeClient(member, product.clientId)) fail('Product not found.', 404, 'product_not_found');
  if (write && member.role === 'viewer') fail('Your workspace role has read-only access.', 403, 'read_only');
  return clone(product);
}
export function accessContext(data, principal, {productId, clientId, write = false, admin = false} = {}, entitlements) {
  const member = admin ? manager(data, principal, entitlements) : activeMember(data, principal, entitlements), w = workspace(data);
  if (write && member.role === 'viewer') fail('Your workspace role has read-only access.', 403, 'read_only');
  if (clientId !== undefined && (!Object.hasOwn(w.clients, clientId) || !canSeeClient(member, clientId))) fail('Client not found.', 404, 'client_not_found');
  if (productId !== undefined) authorizeProduct(data, principal, productId, {write}, entitlements);
  return {workspaceId: w.id, member: memberPublic(member), canManage: isManager(member), canWrite: member.role !== 'viewer', productIds: (data.products || []).filter(product => canSeeClient(member, product.clientId)).map(product => product.id)};
}

export function createInvite(data, principal, {email, role = 'member', clientIds, invitedSub = null, now, ttlMs = INVITE_TTL_MS} = {}, entitlements) {
  feature(entitlements, 'sharedReview');
  const actor = manager(data, principal, entitlements), w = workspace(data), at = timestamp(now), targetEmail = cleanEmail(email);
  if (!INVITE_ROLES.has(role)) fail('Invite an admin, member or viewer.');
  mayManage(actor, role);
  if (invitedSub !== null && (typeof invitedSub !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(invitedSub) || ['__proto__', 'prototype', 'constructor'].includes(invitedSub))) fail('Use a valid invited account ID.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60000 || ttlMs > INVITE_TTL_MS) fail('Invitations can last from one minute to seven days.');
  const scope = scopes(w, clientIds, role, entitlements);
  if (Object.values(w.members).some(member => member.status === 'active' && (member.email === targetEmail || invitedSub && member.sub === invitedSub))) fail('This account is already a workspace member.', 409, 'member_exists');
  if (Object.values(w.invites).some(invite => invite.status === 'pending' && Date.parse(invite.expiresAt) > at && (invite.email === targetEmail || invitedSub && invite.invitedSub === invitedSub))) fail('An invitation is already pending for this account.', 409, 'invite_exists');
  if (seatUsage(data, at).reserved >= policy(entitlements).seats) fail('All workspace seats are occupied or reserved by pending invitations.', 409, 'seat_limit');
  const secret = randomBytes(32).toString('base64url'), id = randomUUID();
  const invite = {id, email: targetEmail, role, clientIds: scope, invitedSub, status: 'pending', tokenHash: createHash('sha256').update(secret).digest('hex'), expiresAt: iso(at + ttlMs), createdAt: iso(at), createdBy: actor.sub};
  w.invites[id] = invite;
  audit(w, actor.sub, 'invite.created', id, at);
  // This is the only response containing the invitation secret. Persist only its hash.
  return {invite: invitePublic(invite), token: `${id}.${secret}`};
}
export function acceptInvite(data, principal, {token, now} = {}, entitlements) {
  feature(entitlements, 'sharedReview');
  const p = verifiedPrincipal(principal), w = workspace(data), at = timestamp(now);
  if (typeof token !== 'string' || token.length > 200) fail('This invitation is invalid or expired.', 403, 'invite_invalid');
  const [id, secret, extra] = token.split('.'), invite = validId(id) ? w.invites[id] : null;
  if (extra || !secret || !/^[a-zA-Z0-9_-]{43}$/.test(secret) || !invite || invite.status !== 'pending' || Date.parse(invite.expiresAt) <= at) fail('This invitation is invalid or expired.', 403, 'invite_invalid');
  const actual = createHash('sha256').update(secret).digest(), expected = Buffer.from(invite.tokenHash || '', 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('This invitation is invalid or expired.', 403, 'invite_invalid');
  if (invite.invitedSub ? invite.invitedSub !== p.sub || invite.email !== p.email : !p.authoritativeEmail || invite.email !== p.email) fail('Sign in with the account invited to this workspace.', 403, 'invite_identity_mismatch');
  if (w.members[p.sub]?.status === 'active' || Object.values(w.members).some(member => member.status === 'active' && member.email === p.email)) fail('This account is already a workspace member.', 409, 'member_exists');
  if (seatUsage(data, at).reserved > policy(entitlements).seats) fail('The workspace no longer has a seat available for this invitation.', 409, 'seat_limit');
  const scope = scopes(w, invite.clientIds, invite.role, entitlements);
  const member = {sub: p.sub, email: p.email, ...(p.name ? {name: p.name} : {}), role: invite.role, status: 'active', clientIds: scope, createdAt: iso(at), updatedAt: iso(at)};
  w.members[p.sub] = member;
  Object.assign(invite, {status: 'accepted', acceptedAt: iso(at), acceptedBy: p.sub});
  delete invite.tokenHash;
  audit(w, p.sub, 'invite.accepted', id, at);
  return memberPublic(member);
}
export function revokeInvite(data, principal, {id, now} = {}, entitlements) {
  const actor = manager(data, principal, entitlements), w = workspace(data), at = timestamp(now), invite = Object.hasOwn(w.invites, id) ? w.invites[id] : null;
  if (!invite) fail('Invitation not found.', 404, 'invite_not_found');
  mayManage(actor, invite.role);
  if (invite.status !== 'pending') fail('Only pending invitations can be revoked.', 409, 'invite_inactive');
  invite.status = 'revoked'; invite.revokedAt = iso(at); delete invite.tokenHash;
  audit(w, actor.sub, 'invite.revoked', id, at);
  return invitePublic(invite);
}
export function updateMember(data, principal, {sub, role, clientIds, now} = {}, entitlements) {
  const actor = manager(data, principal, entitlements), w = workspace(data), target = Object.hasOwn(w.members, sub) ? w.members[sub] : null, at = timestamp(now);
  if (!target || target.status !== 'active') fail('Member not found.', 404, 'member_not_found');
  const nextRole = role ?? target.role;
  if (!ROLES.has(nextRole)) fail('Choose a supported workspace role.');
  mayManage(actor, target.role, nextRole);
  if (actor.sub === sub && nextRole !== target.role && actor.role !== 'owner') fail('You cannot change your own role.', 403, 'role_escalation');
  if (target.role === 'owner' && nextRole !== 'owner' && seatMembers(w).filter(member => member.role === 'owner').length <= 1) fail('Keep at least one active workspace owner.', 409, 'last_owner');
  const scope = scopes(w, clientIds ?? (nextRole === target.role ? target.clientIds : nextRole === 'owner' || nextRole === 'admin' ? 'all' : target.clientIds), nextRole, entitlements);
  Object.assign(target, {role: nextRole, clientIds: scope, updatedAt: iso(at)});
  maintainPrimaryOwner(w);
  clearInaccessibleAssignments(data, actor.sub, at, 'member_scope_changed');
  audit(w, actor.sub, 'member.updated', sub, at, {role: nextRole});
  return memberPublic(target);
}
export function removeMember(data, principal, {sub, now} = {}, entitlements) {
  const actor = manager(data, principal, entitlements), w = workspace(data), target = Object.hasOwn(w.members, sub) ? w.members[sub] : null, at = timestamp(now);
  if (!target || target.status !== 'active') fail('Member not found.', 404, 'member_not_found');
  mayManage(actor, target.role);
  if (target.role === 'owner' && seatMembers(w).filter(member => member.role === 'owner').length <= 1) fail('Keep at least one active workspace owner.', 409, 'last_owner');
  target.status = 'revoked'; target.updatedAt = iso(at); target.revokedAt = iso(at);
  maintainPrimaryOwner(w);
  clearInaccessibleAssignments(data, actor.sub, at, 'member_revoked');
  audit(w, actor.sub, 'member.revoked', sub, at);
  return memberPublic(target);
}

export function createClient(data, principal, {name, now} = {}, entitlements) {
  feature(entitlements, 'clientSeparation');
  const actor = manager(data, principal, entitlements), w = workspace(data), at = timestamp(now), id = randomUUID();
  const client = {id, name: cleanName(name), createdAt: iso(at), updatedAt: iso(at)};
  w.clients[id] = client; audit(w, actor.sub, 'client.created', id, at);
  return clone(client);
}
export function updateClient(data, principal, {id, name, now} = {}, entitlements) {
  feature(entitlements, 'clientSeparation');
  const actor = manager(data, principal, entitlements), w = workspace(data), client = Object.hasOwn(w.clients, id) ? w.clients[id] : null, at = timestamp(now);
  if (!client) fail('Client not found.', 404, 'client_not_found');
  client.name = cleanName(name); client.updatedAt = iso(at); audit(w, actor.sub, 'client.updated', id, at);
  return clone(client);
}
export function deleteClient(data, principal, {id, now} = {}, entitlements) {
  feature(entitlements, 'clientSeparation');
  const actor = manager(data, principal, entitlements), w = workspace(data), at = timestamp(now);
  if (!Object.hasOwn(w.clients, id)) fail('Client not found.', 404, 'client_not_found');
  if ((data.products || []).some(product => product.clientId === id)) fail('Move or remove this client’s products before deleting the client.', 409, 'client_has_products');
  if (Object.values(w.invites).some(invite => invite.status === 'pending' && Date.parse(invite.expiresAt) > at && Array.isArray(invite.clientIds) && invite.clientIds.includes(id))) fail('Revoke pending invitations for this client before deleting it.', 409, 'client_has_invites');
  delete w.clients[id];
  for (const member of Object.values(w.members)) if (Array.isArray(member.clientIds)) member.clientIds = member.clientIds.filter(value => value !== id);
  audit(w, actor.sub, 'client.deleted', id, at); return {id, deleted: true};
}
export function assignProductClient(data, principal, {productId, clientId, now} = {}, entitlements) {
  feature(entitlements, 'clientSeparation');
  const actor = manager(data, principal, entitlements), w = workspace(data), product = currentProduct(data, productId), at = timestamp(now);
  if (clientId !== null && !Object.hasOwn(w.clients, clientId)) fail('Client not found.', 404, 'client_not_found');
  product.clientId = clientId; product.updatedAt = iso(at);
  clearInaccessibleAssignments(data, actor.sub, at, 'client_scope_changed');
  audit(w, actor.sub, 'product.client_changed', productId, at, {clientId});
  return clone(product);
}

export function reviewFor(data, principal, itemId, entitlements) {
  const item = (data.items || []).find(row => row.id === itemId);
  if (!item) fail('Conversation not found.', 404, 'item_not_found');
  authorizeProduct(data, principal, item.productId, {}, entitlements);
  const stored = workspace(data).reviews?.[itemId], saved = stored?.productId === item.productId ? stored : null;
  return clone(saved || {itemId, productId: item.productId, version: 0, assigneeSub: null, updatedAt: null, updatedBy: null, events: []});
}
export function updateReview(data, principal, {itemId, expectedVersion, patch, now} = {}, entitlements) {
  const member = activeMember(data, principal, entitlements), w = workspace(data), at = timestamp(now);
  const item = (data.items || []).find(row => row.id === itemId);
  if (!item) fail('Conversation not found.', 404, 'item_not_found');
  const product = authorizeProduct(data, principal, item.productId, {write: true}, entitlements);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('Refresh the conversation before saving.', 409, 'review_version_required');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !REVIEW_FIELDS.has(key))) fail('Choose a supported review update.');
  const stored = w.reviews?.[itemId], existing = stored?.productId === item.productId ? stored : null;
  if ((existing?.version || 0) !== expectedVersion) fail('This conversation was updated by someone else. Refresh before saving.', 409, 'review_conflict');
  const changes = {};
  if (Object.hasOwn(patch, 'status')) {
    if (!['new', 'saved', 'dismissed'].includes(patch.status)) fail('Choose New, Saved or Dismissed.');
    if (item.status !== patch.status) changes.status = patch.status;
  }
  for (const [key, limit] of [['note', 3000], ['draft', 5000]]) if (Object.hasOwn(patch, key)) {
    if (typeof patch[key] !== 'string' || patch[key].length > limit) fail(`${key === 'note' ? 'Notes' : 'Drafts'} must be under ${limit.toLocaleString('en-US')} characters.`);
    if ((item[key] || '') !== patch[key]) changes[key] = patch[key];
  }
  if (Object.hasOwn(patch, 'assigneeSub')) {
    feature(entitlements, 'assignments');
    const assignee = patch.assigneeSub === null ? null : w.members[patch.assigneeSub];
    if (patch.assigneeSub !== null && (!assignee || assignee.status !== 'active' || assignee.role === 'viewer' || !canSeeClient(assignee, product.clientId))) fail('Assign this conversation to an active member with access to this client.', 400, 'assignee_invalid');
    if (assignee) activeMember(data, {sub: assignee.sub, email: assignee.email}, entitlements);
    if ((existing?.assigneeSub || null) !== patch.assigneeSub) changes.assigneeSub = patch.assigneeSub;
  }
  if (!Object.keys(changes).length) return {item: clone(item), review: reviewFor(data, principal, itemId, entitlements)};
  const review = clone(existing || {itemId, productId: item.productId, version: 0, assigneeSub: null, events: []});
  review.version++; review.updatedAt = iso(at); review.updatedBy = member.sub;
  if (Object.hasOwn(changes, 'assigneeSub')) review.assigneeSub = changes.assigneeSub;
  // Audit records identify edited fields without retaining historical note/draft
  // contents after the user edits or removes them.
  const eventChanges = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, ['note', 'draft'].includes(key) ? {edited: true} : value]));
  review.events.push({at: iso(at), actorSub: member.sub, version: review.version, changes: eventChanges});
  review.events = review.events.slice(-100);
  for (const key of ['status', 'note', 'draft']) if (Object.hasOwn(changes, key)) item[key] = changes[key];
  w.reviews ||= {}; w.reviews[itemId] = review;
  audit(w, member.sub, 'review.updated', itemId, at, {fields: Object.keys(changes)});
  return {item: clone(item), review: clone(review)};
}

export function publicWorkspace(data, principal, entitlements, now = Date.now()) {
  const member = activeMember(data, principal, entitlements), w = workspace(data), managed = isManager(member);
  const visibleClients = new Set(Object.keys(w.clients).filter(id => canSeeClient(member, id)));
  const visibleMembers = Object.values(w.members).filter(row => managed || row.status === 'active' && (row.sub === member.sub || row.clientIds === 'all' || isManager(row) || Array.isArray(row.clientIds) && row.clientIds.some(id => visibleClients.has(id))));
  const response = {id: w.id, name: w.name, member: memberPublic(member), clients: Object.values(w.clients).filter(client => visibleClients.has(client.id)).map(clone), members: visibleMembers.map(row => {
    const result = memberPublic(row, managed || row.sub === member.sub);
    // Do not disclose clients outside a restricted member's scope via coworkers.
    if (!managed && member.clientIds !== 'all' && Array.isArray(result.clientIds)) result.clientIds = result.clientIds.filter(id => visibleClients.has(id));
    return result;
  }), permissions: {manage: managed, write: member.role !== 'viewer', assignments: policy(entitlements).features.assignments === true}};
  if (managed) Object.assign(response, {seats: {...seatUsage(data, now), limit: policy(entitlements).seats}, invites: Object.values(w.invites).map(invitePublic)});
  return response;
}

// A projection starts from an allowlist, never from {...data}. Adding another
// persisted subsystem cannot silently make its records visible to client users.
export function filterWorkspaceState(data, principal, entitlements, now = Date.now(), {itemLimit=Infinity,evidenceLimit=Infinity}={}) {
  const context = accessContext(data, principal, {}, entitlements), ids = new Set(context.productIds);
  const products = (data.products || []).filter(row => ids.has(row.id));
  const allItems = (data.items || []).filter(row => ids.has(row.productId));
  const items = allItems.slice(0,itemLimit);
  const itemProducts = new Map(items.map(row => [row.id, row.productId]));
  const result = {version: data.version || 1, products: clone(products), items: clone(items), workspace: publicWorkspace(data, principal, entitlements, now), ...(Number.isFinite(itemLimit)?{itemPage:{total:allItems.length,limit:itemLimit,hasMore:allItems.length>itemLimit}}:{})};
  for (const key of ['searches', 'research', 'pipelineStages', 'conversationEvidence', 'conversationReviewQueue', 'conversationReviewFailures', 'conversationReviewReceipts', 'discovery']) {
    if (data[key] !== undefined) result[key] = Object.fromEntries(Object.entries(data[key] || {}).filter(([id]) => ids.has(id)).map(([id, value]) => [id, clone(['conversationEvidence','conversationReviewQueue'].includes(key)&&Array.isArray(value)?value.slice(0,evidenceLimit):key==='conversationReviewFailures'&&Number.isFinite(evidenceLimit)?Object.fromEntries(Object.entries(value).slice(-evidenceLimit)):value)]));
  }
  if (data.qualifications) result.qualifications = Object.fromEntries(Object.entries(data.qualifications).filter(([, row]) => ids.has(row.productId)).map(([id, value]) => {
    const safe = clone(value); delete safe.token; return [id, safe];
  }));
  result.reviews = Object.fromEntries(Object.entries(workspace(data).reviews || {}).filter(([id, value]) => itemProducts.has(id) && itemProducts.get(id) === value.productId).map(([id, value]) => [id, clone(value)]));
  if (data.collection) {
    result.collection = {};
    for (const key of ['cycles', 'backfills']) if (data.collection[key]) result.collection[key] = Object.fromEntries(Object.entries(data.collection[key]).filter(([id]) => ids.has(id)).map(([id, value]) => [id, clone(value)]));
  }
  // All subscription changes, provider credentials and complete quota ledgers
  // remain server-owned. Public usage/plan summaries are built by their modules.
  return result;
}

export function preserveServerOwnedState(current, imported) {
  const result = clone(imported);
  const existingItems = new Map((current.items || []).map(item => [item.id, item]));
  for (const item of result.items || []) if (existingItems.has(item.id) && existingItems.get(item.id).productId !== item.productId) fail('A restored conversation cannot change its product identity.', 409, 'item_identity_conflict');
  for (const key of SERVER_OWNED_STATE_KEYS) {
    delete result[key];
    if (Object.hasOwn(current, key)) result[key] = clone(current[key]);
  }
  // Product client membership is managed by server-authorized client actions.
  const existing = new Map((current.products || []).map(product => [product.id, product]));
  for (const product of result.products || []) {
    delete product.clientId;
    const prior = existing.get(product.id);
    if (prior && Object.hasOwn(prior, 'clientId')) product.clientId = prior.clientId;
  }
  return result;
}
