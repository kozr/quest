import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapWorkspace, accessContext, authorizeProduct, seatUsage, publicWorkspace,
  createInvite, acceptInvite, revokeInvite, updateMember, removeMember,
  createClient, updateClient, deleteClient, assignProductClient,
  updateReview, reviewFor, filterWorkspaceState, preserveServerOwnedState,
} from '../workspace.mjs';

const now = Date.parse('2026-10-09T12:00:00Z');
const owner = {sub: '1001', email: 'owner@gmail.com'};
const alice = {sub: '1002', email: 'alice@gmail.com'};
const bob = {sub: '1003', email: 'bob@gmail.com'};
const other = {sub: '1004', email: 'other@gmail.com'};
const starter = {limits: {seats: 1}, features: {sharedReview: false, assignments: false, clientSeparation: false}};
const growth = {limits: {seats: 3}, features: {sharedReview: true, assignments: true, clientSeparation: false}};
const team = {limits: {seats: 10}, features: {sharedReview: true, assignments: true, clientSeparation: true}};
function fixture(id = 'fixture') {
  const data = {version: 1, products: [], items: [], searches: {}};
  bootstrapWorkspace(data, {id, name: 'Fixture workspace', owner, now});
  return data;
}
function join(data, principal, {role = 'member', clientIds, plan = team, actor = owner} = {}) {
  const invite = createInvite(data, actor, {email: principal.email, role, clientIds, now}, plan);
  return acceptInvite(data, principal, {token: invite.token, now: now + 1}, plan);
}
function scopedFixture() {
  const data = fixture();
  const a = createClient(data, owner, {name: 'Client A', now}, team);
  const b = createClient(data, owner, {name: 'Client B', now}, team);
  data.products = [{id: 'pa', name: 'Product A', clientId: a.id}, {id: 'pb', name: 'SECRET_PRODUCT_B', clientId: b.id}, {id: 'pu', name: 'Unassigned'}];
  data.items = [{id: 'ia', productId: 'pa', status: 'new', note: '', draft: ''}, {id: 'ib', productId: 'pb', status: 'new', note: 'SECRET_NOTE_B', draft: ''}];
  join(data, alice, {clientIds: [a.id]});
  join(data, bob, {clientIds: [b.id]});
  return {data, a, b};
}
function code(expected) { return error => error.code === expected; }

test('an explicit configured owner bootstrap is required and cannot run twice', () => {
  const data = {products: [], items: []};
  assert.throws(() => accessContext(data, alice, {}, team), code('workspace_uninitialized'));
  assert.equal(data.workspace, undefined);
  assert.throws(() => bootstrapWorkspace(data, {id: 'fixture', owner: {email: owner.email}, now}), code('identity_required'));
  bootstrapWorkspace(data, {id: 'fixture', name: 'Company', owner, now});
  assert.equal(accessContext(data, owner, {}, starter).member.role, 'owner');
  assert.throws(() => accessContext(data, alice, {}, team), code('membership_required'));
  assert.throws(() => bootstrapWorkspace(data, {id: 'fixture', owner: alice, now}), code('workspace_exists'));
  assert.equal(data.workspace.members[owner.sub].role, 'owner');
});

test('pending invites reserve seats and stored/public data never retains the secret', () => {
  const data = fixture();
  const invite = createInvite(data, owner, {email: alice.email, now}, growth);
  const secret = invite.token.split('.')[1];
  assert.equal(seatUsage(data, now).reserved, 2);
  assert.equal(data.workspace.invites[invite.invite.id].tokenHash.length, 64);
  assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal(JSON.stringify(publicWorkspace(data, owner, growth, now)).includes('tokenHash'), false);
  acceptInvite(data, alice, {token: invite.token, now: now + 1}, growth);
  assert.deepEqual(seatUsage(data, now + 1), {active: 2, pending: 0, reserved: 2});
  assert.equal(data.workspace.invites[invite.invite.id].tokenHash, undefined);
  assert.throws(() => acceptInvite(data, alice, {token: invite.token, now: now + 2}, growth), code('invite_invalid'));
});

test('serial CAS mutations cannot reserve more seats than the plan allows', async () => {
  const data = fixture();
  // Store CAS calls each pure mutation against the current state. Three callers
  // race for two free seats, including invites which have not been accepted.
  const attempts = await Promise.allSettled([alice, bob, other].map(principal => Promise.resolve().then(() => createInvite(data, owner, {email: principal.email, now}, growth))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'seat_limit');
  assert.deepEqual(seatUsage(data, now), {active: 1, pending: 2, reserved: 3});
});

test('expired, revoked, modified and wrongly identified invites cannot be accepted', () => {
  const data = fixture();
  const invite = createInvite(data, owner, {email: alice.email, now, ttlMs: 60000}, growth);
  assert.throws(() => acceptInvite(data, bob, {token: invite.token, now}, growth), code('invite_identity_mismatch'));
  assert.throws(() => acceptInvite(data, alice, {token: invite.token.slice(0, -2) + 'xx', now}, growth), code('invite_invalid'));
  assert.throws(() => acceptInvite(data, alice, {token: invite.token, now: now + 60000}, growth), code('invite_invalid'));
  assert.equal(seatUsage(data, now + 60000).pending, 0);
  const again = createInvite(data, owner, {email: alice.email, now: now + 60001}, growth);
  revokeInvite(data, owner, {id: again.invite.id, now: now + 60002}, growth);
  assert.throws(() => acceptInvite(data, alice, {token: again.token, now: now + 60003}, growth), code('invite_invalid'));
});

test('email invitations require authoritative identity; pinned invitations require the pinned subject', () => {
  const data = fixture(), external = {sub: 'corp1', email: 'person@company.example'};
  const invite = createInvite(data, owner, {email: external.email, now}, growth);
  assert.throws(() => acceptInvite(data, external, {token: invite.token, now}, growth), code('invite_identity_mismatch'));
  acceptInvite(data, {...external, authoritativeEmail: true}, {token: invite.token, now}, growth);
  const pinned = createInvite(data, owner, {email: 'pinned@outside.example', invitedSub: 'pinned1', now}, growth);
  assert.throws(() => acceptInvite(data, {sub: 'pinned2', email: 'pinned@outside.example', authoritativeEmail: true}, {token: pinned.token, now}, growth), code('invite_identity_mismatch'));
  acceptInvite(data, {sub: 'pinned1', email: 'pinned@outside.example'}, {token: pinned.token, now}, growth);
});

test('duplicate invitations and already active identities do not consume additional seats', () => {
  const data = fixture();
  const invite = createInvite(data, owner, {email: ' ALICE@GMAIL.COM ', now}, growth);
  assert.throws(() => createInvite(data, owner, {email: alice.email, now}, growth), code('invite_exists'));
  acceptInvite(data, alice, {token: invite.token, now}, growth);
  assert.throws(() => createInvite(data, owner, {email: alice.email, now}, growth), code('member_exists'));
  assert.deepEqual(seatUsage(data, now), {active: 2, pending: 0, reserved: 2});
});

test('membership is checked on every request so existing signed principals lose revoked access', () => {
  const data = fixture(); join(data, alice, {plan: growth});
  assert.equal(accessContext(data, alice, {}, growth).member.sub, alice.sub);
  removeMember(data, owner, {sub: alice.sub, now}, growth);
  assert.throws(() => accessContext(data, alice, {}, growth), code('membership_required'));
  assert.equal(data.workspace.members[alice.sub].status, 'revoked');
  assert.equal(seatUsage(data, now).active, 1);
});

test('downgrades deny excess seats without making client scopes broader', () => {
  const {data} = scopedFixture();
  assert.equal(accessContext(data, owner, {}, starter).member.role, 'owner');
  assert.throws(() => accessContext(data, alice, {}, starter), code('seat_unavailable'));
  assert.throws(() => authorizeProduct(data, alice, 'pb', {}, growth), code('product_not_found'));
});

test('owner/admin/member/viewer roles cannot escalate or revoke the last owner', () => {
  const data = fixture(); join(data, alice, {role: 'admin'}); join(data, bob); join(data, other, {role: 'viewer'});
  assert.throws(() => updateMember(data, alice, {sub: alice.sub, role: 'owner', now}, team), code('owner_required'));
  assert.throws(() => updateMember(data, alice, {sub: bob.sub, role: 'admin', now}, team), code('owner_required'));
  assert.throws(() => removeMember(data, alice, {sub: owner.sub, now}, team), code('owner_required'));
  assert.throws(() => updateMember(data, bob, {sub: bob.sub, role: 'owner', now}, team), code('role_required'));
  assert.throws(() => createInvite(data, other, {email: 'new@gmail.com', now}, team), code('role_required'));
  assert.throws(() => removeMember(data, owner, {sub: owner.sub, now}, team), code('last_owner'));
  assert.throws(() => updateMember(data, owner, {sub: owner.sub, role: 'member', now}, team), code('last_owner'));
  updateMember(data, alice, {sub: bob.sub, role: 'viewer', now}, team);
  assert.equal(data.workspace.members[bob.sub].role, 'viewer');
});

test('explicit ownership transfer retains an accessible primary owner after a downgrade', () => {
  const data = fixture(); join(data, alice);
  updateMember(data, owner, {sub: alice.sub, role: 'owner', now}, team);
  updateMember(data, owner, {sub: owner.sub, role: 'member', now}, team);
  assert.equal(data.workspace.bootstrapOwnerSub, alice.sub);
  assert.equal(accessContext(data, alice, {}, starter).member.role, 'owner');
  assert.throws(() => accessContext(data, owner, {}, starter), code('seat_unavailable'));
});

test('client authorization uses persisted products and returns no existence hint outside scope', () => {
  const {data, a, b} = scopedFixture();
  assert.equal(authorizeProduct(data, alice, 'pa', {write: true}, team).id, 'pa');
  assert.throws(() => authorizeProduct(data, alice, {id: 'pb', clientId: a.id}, {}, team), code('product_not_found'));
  assert.throws(() => authorizeProduct(data, alice, 'does-not-exist', {}, team), code('product_not_found'));
  assert.throws(() => authorizeProduct(data, alice, 'pu', {}, team), code('product_not_found'));
  assert.throws(() => accessContext(data, alice, {clientId: b.id}, team), code('client_not_found'));
  assert.deepEqual(accessContext(data, alice, {}, team).productIds, ['pa']);
  updateMember(data, owner, {sub: alice.sub, role: 'viewer', now}, team);
  assert.equal(authorizeProduct(data, alice, 'pa', {}, team).id, 'pa');
  assert.throws(() => authorizeProduct(data, alice, 'pa', {write: true}, team), code('read_only'));
});

test('client CRUD requires Team and manager; deletion cannot orphan products or invitations', () => {
  const {data, a, b} = scopedFixture();
  assert.throws(() => createClient(data, owner, {name: 'Another', now}, growth), code('plan_feature_required'));
  assert.throws(() => updateClient(data, alice, {id: a.id, name: 'Changed', now}, team), code('role_required'));
  assert.equal(updateClient(data, owner, {id: a.id, name: 'Renamed', now}, team).name, 'Renamed');
  assert.throws(() => deleteClient(data, owner, {id: a.id, now}, team), code('client_has_products'));
  assignProductClient(data, owner, {productId: 'pa', clientId: b.id, now}, team);
  assert.throws(() => authorizeProduct(data, alice, 'pa', {}, team), code('product_not_found'));
  const pending = createInvite(data, owner, {email: other.email, clientIds: [a.id], now}, team);
  assert.throws(() => deleteClient(data, owner, {id: a.id, now}, team), code('client_has_invites'));
  revokeInvite(data, owner, {id: pending.invite.id, now}, team);
  deleteClient(data, owner, {id: a.id, now}, team);
  assert.deepEqual(data.workspace.members[alice.sub].clientIds, []);
});

test('public state includes only authorized clients/products/evidence and no private server data', () => {
  const {data, a, b} = scopedFixture();
  for (const key of ['searches', 'research', 'pipelineStages', 'conversationEvidence', 'conversationReviewQueue', 'conversationReviewFailures', 'conversationReviewReceipts', 'discovery']) data[key] = {pa: {message: 'visible'}, pb: {message: 'SECRET_B'}};
  data.qualifications = {one: {productId: 'pa', token: 'SECRET_JOB_TOKEN'}, two: {productId: 'pb', reason: 'SECRET_B'}};
  data.collection = {cycles: {pa: {status: 'running'}, pb: {message: 'SECRET_B'}}, backfills: {pb: {message: 'SECRET_B'}}, budget: {spent: 99}, active: {token: 'SECRET_ACTIVE_TOKEN'}};
  data.subscription = {billingCustomer: 'SECRET_BILLING'};
  data.aiBudget = {spent: 999}; data.newUnknownSubsystem = {secret: 'SECRET_UNKNOWN'};
  const projection = filterWorkspaceState(data, alice, team, now);
  assert.deepEqual(projection.products.map(row => row.id), ['pa']);
  assert.deepEqual(projection.items.map(row => row.id), ['ia']);
  assert.deepEqual(projection.workspace.clients.map(row => row.id), [a.id]);
  assert.equal(projection.workspace.members.some(row => row.sub === bob.sub), false);
  assert.equal(projection.workspace.members.find(row => row.sub === owner.sub).email, undefined);
  assert.equal(projection.workspace.invites, undefined);
  assert.equal(projection.workspace.seats, undefined);
  assert.equal(JSON.stringify(projection).includes('SECRET'), false);
  assert.equal(JSON.stringify(projection).includes(b.id), false);
  assert.equal(projection.aiBudget, undefined);
  assert.equal(projection.subscription, undefined);
});

test('safe summaries omit invite secrets even for owners and hide coworker unrelated client scopes', () => {
  const {data, a, b} = scopedFixture();
  updateMember(data, owner, {sub: bob.sub, clientIds: [a.id, b.id], now}, team);
  createInvite(data, owner, {email: other.email, now}, team);
  const summary = publicWorkspace(data, alice, team, now);
  assert.deepEqual(summary.members.find(row => row.sub === bob.sub).clientIds, [a.id]);
  assert.equal(JSON.stringify(summary).includes(b.id), false);
  const managed = publicWorkspace(data, owner, team, now);
  assert.equal(managed.invites.length, 3);
  assert.equal(JSON.stringify(managed).includes('tokenHash'), false);
});

test('assignment and review metadata retain stable identity, audit actor and optimistic versions', () => {
  const {data} = scopedFixture();
  const first = updateReview(data, alice, {itemId: 'ia', expectedVersion: 0, patch: {status: 'saved', note: 'Helpful source', assigneeSub: alice.sub}, now}, team);
  assert.equal(first.item.id, 'ia'); assert.equal(first.review.version, 1);
  assert.equal(first.review.updatedBy, alice.sub); assert.equal(first.review.assigneeSub, alice.sub);
  assert.equal(first.review.events[0].changes.note.edited, true);
  assert.equal(JSON.stringify(first.review.events).includes('Helpful source'), false);
  assert.throws(() => updateReview(data, owner, {itemId: 'ia', expectedVersion: 0, patch: {note: 'stale'}, now}, team), code('review_conflict'));
  assert.equal(data.items[0].note, 'Helpful source');
  const second = updateReview(data, owner, {itemId: 'ia', expectedVersion: 1, patch: {draft: 'Draft text'}, now: now + 1}, team);
  assert.equal(second.review.version, 2); assert.equal(second.review.events.length, 2);
  assert.equal(second.item.note, 'Helpful source'); assert.equal(second.item.draft, 'Draft text');
  assert.throws(() => reviewFor(data, bob, 'ia', team), code('product_not_found'));
});

test('assignment rejects inaccessible clients, viewers, unknown or revoked identities without partial edits', () => {
  const {data, a} = scopedFixture(); join(data, other, {role: 'viewer', clientIds: [a.id]});
  for (const assigneeSub of [bob.sub, other.sub, 'missing']) {
    assert.throws(() => updateReview(data, alice, {itemId: 'ia', expectedVersion: 0, patch: {note: 'Do not save', assigneeSub}, now}, team), code('assignee_invalid'));
    assert.equal(data.items[0].note, ''); assert.equal(data.workspace.reviews.ia, undefined);
  }
  removeMember(data, owner, {sub: alice.sub, now}, team);
  assert.throws(() => updateReview(data, owner, {itemId: 'ia', expectedVersion: 0, patch: {assigneeSub: alice.sub}, now}, team), code('assignee_invalid'));
});

test('scope changes and revocation clear assignments and advance review versions', () => {
  const {data, b} = scopedFixture();
  updateReview(data, alice, {itemId: 'ia', expectedVersion: 0, patch: {assigneeSub: alice.sub}, now}, team);
  updateMember(data, owner, {sub: alice.sub, clientIds: [b.id], now: now + 1}, team);
  assert.equal(data.workspace.reviews.ia.assigneeSub, null);
  assert.equal(data.workspace.reviews.ia.version, 2);
  updateReview(data, bob, {itemId: 'ib', expectedVersion: 0, patch: {assigneeSub: bob.sub}, now}, team);
  removeMember(data, owner, {sub: bob.sub, now: now + 1}, team);
  assert.equal(data.workspace.reviews.ib.assigneeSub, null);
  assert.equal(data.workspace.reviews.ib.version, 2);
});

test('Starter personal review is available but team invitations and assignments are gated', () => {
  const data = fixture(); data.products = [{id: 'p'}]; data.items = [{id: 'i', productId: 'p', status: 'new', note: ''}];
  assert.throws(() => createInvite(data, owner, {email: alice.email, now}, starter), code('plan_feature_required'));
  assert.throws(() => updateReview(data, owner, {itemId: 'i', expectedVersion: 0, patch: {assigneeSub: owner.sub}, now}, starter), code('plan_feature_required'));
  const result = updateReview(data, owner, {itemId: 'i', expectedVersion: 0, patch: {note: 'Personal note'}, now}, starter);
  assert.equal(result.item.note, 'Personal note'); assert.equal(result.review.version, 1);
});

test('missing expected review version and unsupported fields are rejected; no-ops do not add events', () => {
  const {data} = scopedFixture();
  assert.throws(() => updateReview(data, owner, {itemId: 'ia', patch: {note: 'x'}, now}, team), code('review_version_required'));
  assert.throws(() => updateReview(data, owner, {itemId: 'ia', expectedVersion: 0, patch: {productId: 'pb'}, now}, team), code('workspace_invalid'));
  const result = updateReview(data, owner, {itemId: 'ia', expectedVersion: 0, patch: {status: 'new'}, now}, team);
  assert.equal(result.review.version, 0); assert.deepEqual(result.review.events, []);
});

test('restores cannot replace members, privileges, subscription, quota or client assignments', () => {
  const {data, a, b} = scopedFixture();
  data.subscription = {plan: 'growth', customer: 'trusted'}; data.quota = {spent: 500};
  const imported = {version: 1, products: [{id: 'pa', clientId: b.id}, {id: 'new', clientId: a.id}], items: [], workspace: {members: {[other.sub]: {role: 'owner'}}}, subscription: {plan: 'team'}, quota: {spent: 0}, integrations: {token: 'ATTACK'}};
  const restored = preserveServerOwnedState(data, imported);
  assert.deepEqual(restored.workspace, data.workspace); assert.deepEqual(restored.subscription, data.subscription); assert.deepEqual(restored.quota, data.quota);
  assert.equal(restored.products[0].clientId, a.id); assert.equal(restored.products[1].clientId, undefined);
  assert.equal(restored.integrations, undefined); assert.equal(imported.products[0].clientId, b.id);
});

test('another workspace does not inherit memberships from the same identity or source IDs', () => {
  const a = fixture('first'), b = fixture('second');
  join(a, alice);
  for (const data of [a, b]) {data.products = [{id: 'same-product'}]; data.items = [{id: 'same-item', productId: 'same-product', note: ''}];}
  assert.equal(authorizeProduct(a, alice, 'same-product', {}, team).id, 'same-product');
  assert.throws(() => authorizeProduct(b, alice, 'same-product', {}, team), code('membership_required'));
  assert.throws(() => updateReview(b, alice, {itemId: 'same-item', expectedVersion: 0, patch: {note: 'attack'}, now}, team), code('membership_required'));
  assert.equal(b.items[0].note, '');
});

test('restores cannot rebind stable item identity to expose another client’s review history', () => {
  const {data} = scopedFixture();
  updateReview(data, bob, {itemId: 'ib', expectedVersion: 0, patch: {assigneeSub: bob.sub}, now}, team);
  assert.throws(() => preserveServerOwnedState(data, {products: data.products, items: [{id: 'ib', productId: 'pa'}]}), code('item_identity_conflict'));
  // Defensive projection also refuses mismatched metadata from older bad state.
  data.items[1].productId = 'pa';
  assert.equal(filterWorkspaceState(data, alice, team, now).reviews.ib, undefined);
  assert.equal(reviewFor(data, alice, 'ib', team).assigneeSub, null);
  assert.equal(reviewFor(data, alice, 'ib', team).version, 0);
});

test('untrusted IDs cannot mutate object prototypes', () => {
  const data = fixture();
  assert.throws(() => updateClient(data, owner, {id: '__proto__', name: 'polluted', now}, team), code('client_not_found'));
  assert.throws(() => deleteClient(data, owner, {id: 'constructor', now}, team), code('client_not_found'));
  assert.equal(Object.prototype.name, undefined);
  assert.throws(() => bootstrapWorkspace({}, {id: '__proto__', owner, now}), code('workspace_invalid'));
});
