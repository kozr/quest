import {randomBytes, randomUUID} from 'node:crypto';
import {PLAN_CATALOG, planFor, capacityUsage, activeProduct} from './plans.mjs';
import {accessContext} from './workspace.mjs';

// Verified against stripe-node v23.0.0 and its src/apiVersion.ts (2026-10-09).
export const STRIPE_SDK_VERSION = '23.0.0';
export const STRIPE_API_VERSION = '2026-09-30.endive';
const LEASE_MS = 90000, IDEMPOTENCY_RETRY_MS = 23 * 3600000;
const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible']);
const TERMINAL_SUBSCRIPTIONS = new Set(['canceled', 'incomplete_expired']);
const idOf = value => typeof value === 'string' ? value : value?.id;
const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const error = (message, status = 400, code = 'billing_invalid') => Object.assign(new Error(message), {status, code});
const fail = (...args) => { throw error(...args); };
const validId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_]+$`).test(value);
const billing = data => data.billing ||= {version: 1, provider: 'stripe', operations: {}, events: {}};
const randomLetters = () => [...randomBytes(8)].map(n => String.fromCharCode(97 + n % 26)).join('');

export function billingConfiguration(env = process.env) {
  const secretKey = env.STRIPE_RESTRICTED_KEY || env.STRIPE_SECRET_KEY || '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const priceIds = Object.fromEntries(Object.keys(PLAN_CATALOG).map(id => [id, env[`STRIPE_PRICE_${id.toUpperCase()}`] || '']));
  const livemode = env.STRIPE_LIVEMODE === 'true';
  let origin;
  try { const url = new URL(env.TRACKER_PUBLIC_ORIGIN); if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && !livemode && ['localhost', '127.0.0.1'].includes(url.hostname))) throw Error(); origin = url.origin; } catch { origin = null; }
  const keyMode = /^[rs]k_/.test(secretKey) ? secretKey.split('_')[1] : null;
  const portalConfigurationId = env.STRIPE_PORTAL_CONFIGURATION_ID || null;
  const configured = Boolean(origin && /^[rs]k_(test|live)_[A-Za-z0-9]+$/.test(secretKey) && keyMode === (livemode ? 'live' : 'test') && /^whsec_[A-Za-z0-9]+$/.test(webhookSecret) && Object.values(priceIds).every(id => validId(id, 'price')) && new Set(Object.values(priceIds)).size === 3 && (!portalConfigurationId || validId(portalConfigurationId, 'bpc')));
  return {configured, secretKey, webhookSecret, priceIds, livemode, origin, portalConfigurationId, apiVersion: STRIPE_API_VERSION};
}
function requireConfiguration(config) {
  if (!config?.configured) fail('Stripe billing is not configured for this environment.', 503, 'billing_unavailable');
}
export async function createStripeClient(config, {StripeClient} = {}) {
  requireConfiguration(config);
  const Client = StripeClient || (await import('stripe')).default;
  return new Client(config.secretKey, {apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 30000, appInfo: {name: 'HearWhispers', version: '1.0.0'}});
}
function owner(data, principal) {
  const context = accessContext(data, principal, {}, planFor(data));
  if (context.member.role !== 'owner') fail('Only a workspace owner can manage billing.', 403, 'billing_owner_required');
  return context;
}
function environment(data, config) {
  const b = billing(data);
  if (b.livemode !== undefined && b.livemode !== config.livemode) fail('This workspace billing record belongs to another Stripe environment.', 409, 'billing_environment_mismatch');
  b.livemode = config.livemode; return b;
}
function assertMode(object, config) {
  if (!object || object.livemode !== config.livemode) fail('Stripe returned an object from another environment.', 409, 'billing_environment_mismatch');
}
function assertMetadata(object, data) {
  if (object?.metadata?.hearwhispers_workspace_id !== data.workspace.id) fail('Stripe ownership does not match this workspace.', 409, 'billing_binding_mismatch');
}
function currentOperation(data, lease) {
  const operation = data.billing?.operations?.[lease.kind];
  if (!operation || operation.id !== lease.id || operation.leaseToken !== lease.leaseToken) fail('Another billing request is reconciling this operation.', 409, 'billing_lease_changed');
  return operation;
}
function claimOperation(data, kind, params, now) {
  const b = billing(data); b.operations ||= {};
  let operation = b.operations[kind];
  if (operation?.status === 'complete') return {existing: true, result: clone(operation.result)};
  if (operation?.leaseUntil > now) fail('A billing request is already running. Try again shortly.', 409, 'billing_busy');
  if (operation && now - Date.parse(operation.createdAt) >= IDEMPOTENCY_RETRY_MS) fail('The previous billing request needs reconciliation before another can start.', 409, 'billing_reconciliation_required');
  if (!operation) {
    const id = randomUUID();
    operation = {id, kind, params: clone(params), idempotencyKey: `hearwhispers:${data.workspace.id}:${kind}:${id}`, createdAt: iso(now), status: 'pending'};
    b.operations[kind] = operation;
  }
  operation.status = 'running'; operation.leaseToken = randomUUID(); operation.leaseUntil = now + LEASE_MS; operation.attempts = (operation.attempts || 0) + 1;
  return clone(operation);
}
export function claimCustomer(data, principal, config, now = Date.now()) {
  requireConfiguration(config); const context = owner(data, principal), b = environment(data, config);
  if (b.customerId) return {existing: true, result: {customerId: b.customerId}};
  const lease = claimOperation(data, 'customer', {email: context.member.email, name: data.workspace.name, metadata: {hearwhispers_workspace_id: data.workspace.id}}, now);
  if (!lease.existing && !lease.params.metadata.hearwhispers_intent_id) {
    b.operations.customer.params.metadata.hearwhispers_intent_id = lease.id;
    lease.params.metadata.hearwhispers_intent_id = lease.id;
  }
  return lease;
}
export function settleCustomer(data, lease, customer, config, now = Date.now()) {
  const operation = currentOperation(data, lease), b = environment(data, config);
  assertMode(customer, config); assertMetadata(customer, data);
  if (!validId(customer.id, 'cus') || customer.deleted || customer.metadata.hearwhispers_intent_id !== operation.id || b.customerId && b.customerId !== customer.id) fail('Stripe customer ownership could not be verified.', 409, 'billing_binding_mismatch');
  b.customerId = customer.id;
  Object.assign(operation, {status: 'complete', completedAt: iso(now), result: {customerId: customer.id}}); delete operation.leaseToken; delete operation.leaseUntil;
  return clone(operation.result);
}
export function failBillingOperation(data, lease, now = Date.now()) {
  const operation = data.billing?.operations?.[lease.kind];
  if (!operation || operation.id !== lease.id || operation.leaseToken !== lease.leaseToken) return;
  operation.status = 'uncertain'; operation.updatedAt = iso(now); delete operation.leaseToken; delete operation.leaseUntil;
  // Keep immutable params and the same idempotency key. The failed response
  // might follow a successful provider-side create.
}
export function validateStripePrice(price, planId, config, {checkout = false} = {}) {
  const plan = planFor(planId); assertMode(price, config);
  if (price.id !== config.priceIds[planId] || price.currency !== 'usd' || price.unit_amount !== plan.price.amount * 100 || price.type !== 'recurring' || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed' || !validId(idOf(price.product), 'prod') || checkout && price.active !== true) fail('Stripe price does not match the configured monthly plan.', 409, 'billing_price_mismatch');
  return plan;
}
export function claimCheckout(data, principal, {planId} = {}, config, now = Date.now()) {
  requireConfiguration(config); owner(data, principal); if (!Object.hasOwn(PLAN_CATALOG, planId)) fail('Choose a subscription plan.', 400, 'billing_plan_required');
  const plan = planFor(planId), b = environment(data, config);
  if (!b.customerId) fail('A Stripe customer is required before checkout.', 409, 'billing_customer_required');
  if (b.subscriptionId && !TERMINAL_SUBSCRIPTIONS.has(b.stripeStatus)) fail('Manage the existing subscription in the customer portal.', 409, 'billing_portal_required');
  const prior = b.operations?.checkout;
  if (prior?.status === 'complete' && prior.result?.expiresAt <= now) {
    // Expiry is verified against Stripe by the service before this reset.
    if (!prior.expiredVerified) fail('The previous checkout must be reconciled first.', 409, 'billing_checkout_reconcile');
    b.checkoutHistory ||= {}; b.checkoutHistory[prior.id] = {sessionId: prior.result.sessionId, planId: prior.params.metadata.hearwhispers_plan_id, expiredAt: iso(now)};
    delete b.operations.checkout;
  }
  const current = b.operations?.checkout;
  if (current && current.params.metadata.hearwhispers_plan_id !== plan.id) fail('Finish or allow the current checkout to expire before choosing another plan.', 409, 'billing_checkout_in_progress');
  const metadata = {hearwhispers_workspace_id: data.workspace.id, hearwhispers_plan_id: plan.id};
  const lease = claimOperation(data, 'checkout', {mode: 'subscription', customer: b.customerId, client_reference_id: data.workspace.id,
    line_items: [{price: config.priceIds[plan.id], quantity: 1}], metadata, subscription_data: {metadata: {...metadata}},
    integration_identifier: `hearwhispers-hosted-${randomLetters()}`, success_url: `${config.origin}/?billing=returned#settings/billing`, cancel_url: `${config.origin}/#settings/billing`, expires_at: Math.floor(now / 1000) + 1800}, now);
  if (!lease.existing && !lease.params.metadata.hearwhispers_checkout_intent) {
    for (const value of [lease, b.operations.checkout]) {
      value.params.metadata.hearwhispers_checkout_intent = lease.id;
      value.params.subscription_data.metadata.hearwhispers_checkout_intent = lease.id;
    }
  }
  return lease;
}
export function settleCheckout(data, lease, session, config, now = Date.now()) {
  const operation = currentOperation(data, lease), b = environment(data, config);
  assertMode(session, config); assertMetadata(session, data);
  if (!validId(session.id, 'cs') || idOf(session.customer) !== b.customerId || session.mode !== 'subscription' || session.metadata.hearwhispers_checkout_intent !== operation.id || session.client_reference_id !== data.workspace.id || typeof session.url !== 'string' || !Number.isFinite(session.expires_at)) fail('Stripe checkout ownership could not be verified.', 409, 'billing_binding_mismatch');
  const url = new URL(session.url);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') fail('Stripe returned an unexpected checkout address.', 502, 'billing_invalid_redirect');
  const result = {sessionId: session.id, url: session.url, expiresAt: session.expires_at * 1000, planId: operation.params.metadata.hearwhispers_plan_id};
  Object.assign(operation, {status: 'complete', result, completedAt: iso(now)}); delete operation.leaseToken; delete operation.leaseUntil;
  return clone(result);
}

export function verifyStripeWebhook(stripe, config, rawBody, signature) {
  requireConfiguration(config);
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !signature || rawBody.length > 1024 * 1024) fail('A signed raw Stripe payload is required.', 400, 'billing_signature_invalid');
  let event;
  try { event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret); } catch { fail('Stripe webhook signature could not be verified.', 400, 'billing_signature_invalid'); }
  assertMode(event, config);
  if (event.account || event.context) fail('Connected-account events are not accepted by this billing endpoint.', 400, 'billing_environment_mismatch');
  if (!validId(event.id, 'evt') || !event.data?.object) fail('Stripe event is invalid.', 400, 'billing_event_invalid');
  return event;
}
export function stripeEventCustomerId(event) { return idOf(event?.data?.object?.customer) || null; }
const invoiceSubscription = invoice => idOf(invoice?.parent?.subscription_details?.subscription) || idOf(invoice?.subscription);
export function claimBillingEvent(data, event, config, now = Date.now()) {
  if (!EVENTS.has(event.type)) return {ignored: true};
  assertMode(event, config); const b = environment(data, config);
  if (!b.customerId || stripeEventCustomerId(event) !== b.customerId) fail('Stripe customer is not bound to this workspace.', 409, 'billing_binding_mismatch');
  b.events ||= {};
  if (b.events[event.id]?.status === 'complete') return {duplicate: true};
  if (b.reconcileLease?.expiresAt > now) fail('Billing reconciliation is already running.', 503, 'billing_busy');
  const lease = {token: randomUUID(), eventId: event.id, expiresAt: now + LEASE_MS};
  b.events[event.id] = {...b.events[event.id], id: event.id, type: event.type, stripeCreatedAt: event.created, status: 'processing', receivedAt: b.events[event.id]?.receivedAt || iso(now)};
  b.reconcileLease = lease; return clone(lease);
}
function assertReconciliation(data, lease) {
  if (data.billing?.reconcileLease?.token !== lease.token || data.billing.reconcileLease.eventId !== lease.eventId) fail('A newer billing reconciliation owns this result.', 409, 'billing_lease_changed');
}
export function finishBillingEvent(data, lease, {result = 'reconciled', failed = false} = {}, now = Date.now()) {
  assertReconciliation(data, lease); const b = billing(data);
  Object.assign(b.events[lease.eventId], {status: failed ? 'failed' : 'complete', result, completedAt: iso(now)}); delete b.reconcileLease;
  return {received: true, result};
}
function subscriptionBinding(data, subscription, config) {
  const b = environment(data, config); assertMode(subscription, config); assertMetadata(subscription, data);
  if (!validId(subscription.id, 'sub') || idOf(subscription.customer) !== b.customerId) fail('Subscription customer does not match the workspace.', 409, 'billing_binding_mismatch');
  if (!['active', 'trialing', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'canceled', 'paused'].includes(subscription.status)) fail('Stripe subscription status is unsupported.', 409, 'billing_subscription_invalid');
  if (b.subscriptionId !== subscription.id) {
    const checkout = b.operations?.checkout;
    if (b.subscriptionId && !TERMINAL_SUBSCRIPTIONS.has(b.stripeStatus) || !checkout || subscription.metadata.hearwhispers_checkout_intent !== checkout.id) fail('Subscription was not created by this workspace checkout.', 409, 'billing_binding_mismatch');
  }
  if (subscription.items?.has_more || !Array.isArray(subscription.items?.data) || subscription.items.data.length !== 1) fail('A workspace subscription must contain exactly one plan.', 409, 'billing_price_mismatch');
  const item = subscription.items.data[0];
  if (item.quantity !== 1) fail('Workspace subscriptions use one flat-rate plan.', 409, 'billing_price_mismatch');
  const planId = Object.keys(config.priceIds).find(id => config.priceIds[id] === idOf(item.price));
  if (!planId) fail('Stripe subscription uses an unknown price.', 409, 'billing_price_mismatch');
  validateStripePrice(item.price, planId, config);
  if (!Number.isFinite(item.current_period_end) || !Number.isFinite(item.current_period_start) || item.current_period_end <= item.current_period_start) fail('Stripe billing period is invalid.', 409, 'billing_period_invalid');
  return {item, planId, end: item.current_period_end * 1000};
}
function paidInvoiceEnd(data, subscription, invoice, item, config) {
  if (!invoice) return null;
  assertMode(invoice, config);
  if (idOf(invoice.customer) !== data.billing.customerId || invoiceSubscription(invoice) !== subscription.id) fail('Invoice does not belong to this subscription.', 409, 'billing_binding_mismatch');
  if (invoice.status !== 'paid' || invoice.amount_remaining !== 0 || invoice.currency !== 'usd') return null;
  if (!Array.isArray(invoice.lines?.data) || invoice.lines.has_more) fail('Invoice line items are incomplete.', 502, 'billing_invoice_incomplete');
  const matching = invoice.lines.data.filter(line => idOf(line.pricing?.price_details?.price || line.price) === item.price.id && idOf(line.parent?.subscription_item_details?.subscription_item || line.subscription_item) === item.id && line.quantity === 1 && line.amount >= 0);
  const ends = matching.map(line => line.period?.end).filter(end => Number.isFinite(end) && end > item.current_period_start);
  return ends.length ? Math.min(item.current_period_end, Math.max(...ends)) * 1000 : null;
}
export function refreshBillingCapacity(data, now = Date.now()) {
  const plan = planFor(data), usage = capacityUsage(data, {now});
  const overCapacity = Object.fromEntries(['products', 'keywordSearches', 'longTailThemes', 'seats'].filter(key => usage[key] > plan.limits[key]).map(key => [key, {used: usage[key], limit: plan.limits[key]}]));
  const kept = [];
  for (const product of (data.products || []).filter(activeProduct).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))) {
    const next = capacityUsage(data, {now, products: [...kept, product]});
    if (['products', 'keywordSearches', 'longTailThemes'].some(key => next[key] > plan.limits[key])) product.planMonitoringBlocked = 'plan_capacity';
    else { kept.push(product); delete product.planMonitoringBlocked; }
  }
  billing(data).overCapacity = overCapacity; return clone(overCapacity);
}
export function applyStripeSubscription(data, subscription, invoice, config, {allowPaid = true, now = Date.now()} = {}) {
  const b = environment(data, config), {item, planId, end} = subscriptionBinding(data, subscription, config);
  const paidEnd = allowPaid ? paidInvoiceEnd(data, subscription, invoice, item, config) : null;
  const priorPaidUntil = Date.parse(b.paidUntil || ''), priorPlan = b.paidPlanId && PLAN_CATALOG[b.paidPlanId];
  let entitlementPlan = b.paidPlanId || planId, paidUntil = Number.isFinite(priorPaidUntil) ? priorPaidUntil : null;
  if (paidEnd) { entitlementPlan = planId; paidUntil = paidEnd; b.paidInvoiceId = invoice.id; }
  else if (priorPaidUntil > now && priorPlan && planFor(planId).price.amount <= priorPlan.price.amount) { entitlementPlan = planId; paidUntil = Math.min(priorPaidUntil, end); }
  const terminated = TERMINAL_SUBSCRIPTIONS.has(subscription.status), paused = ['paused', 'unpaid'].includes(subscription.status);
  const active = !terminated && !paused && ['active', 'past_due'].includes(subscription.status) && paidUntil > now;
  b.subscriptionId = subscription.id; b.stripeStatus = subscription.status; b.paidPlanId = entitlementPlan; b.paidUntil = paidUntil ? iso(paidUntil) : null;
  b.cancelAtPeriodEnd = subscription.cancel_at_period_end === true; b.currentPeriodEnd = iso(end); b.lastReconciledAt = iso(now);
  data.subscription = {...data.subscription, planId: entitlementPlan, status: active ? 'active' : terminated ? 'cancelled' : 'past_due', managedBy: 'stripe', paidUntil: b.paidUntil, stripeStatus: subscription.status, cancelAtPeriodEnd: b.cancelAtPeriodEnd, createdAt: data.subscription?.createdAt || iso(now), updatedAt: iso(now)};
  delete data.subscription.trialEndsAt;
  // Stripe is authoritative after portal changes. Never reject a paid downgrade
  // because saved records exceed the new plan; preserve records and flag work.
  refreshBillingCapacity(data, now);
  return publicBillingState(data, now);
}
export function publicBillingState(data, now = Date.now()) {
  const b = data.billing || {}, subscription = data.subscription;
  return {provider: b.provider || null, configuredCustomer: Boolean(b.customerId), hasSubscription: Boolean(b.subscriptionId), stripeStatus: b.stripeStatus || null, planId: subscription?.planId || 'starter', status: subscription?.status || 'manual', paidUntil: b.paidUntil || null, cancelAtPeriodEnd: b.cancelAtPeriodEnd === true, currentPeriodEnd: b.currentPeriodEnd || null, active: subscription?.managedBy === 'stripe' ? subscription.status === 'active' && Date.parse(subscription.paidUntil) > now : undefined, overCapacity: clone(b.overCapacity || {})};
}
export function publicBillingSummary(data, config, now = Date.now()) {
  return {...publicBillingState(data, now), configured: config?.configured === true, environment: config?.livemode === true ? 'live' : 'sandbox'};
}

export function createBillingService({store, stripe, config, now = Date.now, onCustomerBound = async()=>{}}) {
  const mutate = change => store.mutate(change);
  async function customer(principal) {
    const lease = await mutate(data => claimCustomer(data, principal, config, now()));
    if (lease.existing) return lease.result.customerId;
    try { const result = await stripe.customers.create(lease.params, {idempotencyKey: lease.idempotencyKey}); return (await mutate(data => settleCustomer(data, lease, result, config, now()))).customerId; }
    catch (cause) { await mutate(data => failBillingOperation(data, lease, now())); throw cause?.code?.startsWith('billing_') ? cause : error('Stripe customer setup could not be confirmed. Retry to reconcile the same request.', 502, 'billing_provider_unavailable'); }
  }
  async function checkout(principal, {planId} = {}) {
    requireConfiguration(config); const snapshot = await store.snapshot(); owner(snapshot, principal); if (!Object.hasOwn(PLAN_CATALOG, planId)) fail('Choose a subscription plan.', 400, 'billing_plan_required');
    if (snapshot.billing?.subscriptionId && !TERMINAL_SUBSCRIPTIONS.has(snapshot.billing.stripeStatus)) fail('Manage the existing subscription in the customer portal.', 409, 'billing_portal_required');
    let prices;
    try { prices = await Promise.all(Object.keys(PLAN_CATALOG).map(async id => {const price = await stripe.prices.retrieve(config.priceIds[id]); validateStripePrice(price, id, config, {checkout: true}); return price;})); }
    catch (cause) { throw cause?.code?.startsWith('billing_') ? cause : error('Stripe pricing is temporarily unavailable.', 502, 'billing_provider_unavailable'); }
    if (new Set(prices.map(price => idOf(price.product))).size !== 3) fail('Each subscription tier must use its own Stripe Product.', 409, 'billing_price_mismatch');
    await customer(principal);
    await onCustomerBound();
    const saved = await store.snapshot(), prior = saved.billing.operations?.checkout;
    const retiredSubscription = saved.billing.subscriptionId && TERMINAL_SUBSCRIPTIONS.has(saved.billing.stripeStatus);
    if (prior?.status === 'complete' && (prior.result.expiresAt <= now() || retiredSubscription)) {
      let current;
      try { current = await stripe.checkout.sessions.retrieve(prior.result.sessionId); }
      catch { fail('The previous checkout could not be reconciled. Try again shortly.', 502, 'billing_provider_unavailable'); }
      assertMode(current, config);
      assertMetadata(current, saved);
      if (idOf(current.customer) !== saved.billing.customerId || current.metadata.hearwhispers_checkout_intent !== prior.id) fail('The previous checkout has an unexpected owner.', 409, 'billing_binding_mismatch');
      const finishedSubscription = retiredSubscription && current.status === 'complete' && idOf(current.subscription) === saved.billing.subscriptionId;
      if (!finishedSubscription && current.status !== 'expired') fail('The previous checkout is awaiting reconciliation.', 409, 'billing_checkout_reconcile');
      await mutate(data => {
        const operation = data.billing.operations.checkout;
        if (operation?.id !== prior.id) return;
        if (finishedSubscription && data.billing.subscriptionId === saved.billing.subscriptionId && TERMINAL_SUBSCRIPTIONS.has(data.billing.stripeStatus)) {
          data.billing.checkoutHistory ||= {}; data.billing.checkoutHistory[prior.id] = {sessionId: prior.result.sessionId, planId: prior.result.planId, retiredAt: iso(now())};
          delete data.billing.operations.checkout;
        } else operation.expiredVerified = true;
      });
    }
    const lease = await mutate(data => claimCheckout(data, principal, {planId}, config, now()));
    if (lease.existing) return lease.result;
    try { const session = await stripe.checkout.sessions.create(lease.params, {idempotencyKey: lease.idempotencyKey}); return await mutate(data => settleCheckout(data, lease, session, config, now())); }
    catch (cause) { await mutate(data => failBillingOperation(data, lease, now())); throw cause?.code?.startsWith('billing_') ? cause : error('Checkout could not be confirmed. Retry to reconcile the same request.', 502, 'billing_provider_unavailable'); }
  }
  async function portal(principal) {
    requireConfiguration(config); const data = await store.snapshot(); owner(data, principal);
    const b = environment(data, config); if (!b.customerId) fail('Complete checkout before opening the customer portal.', 409, 'billing_customer_required');
    let session;
    try { session = await stripe.billingPortal.sessions.create({customer: b.customerId, return_url: `${config.origin}/#settings/billing`, ...(config.portalConfigurationId ? {configuration: config.portalConfigurationId} : {})}); }
    catch { fail('The customer portal is temporarily unavailable.', 502, 'billing_provider_unavailable'); }
    const url = new URL(session.url);
    if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com') fail('Stripe returned an unexpected portal address.', 502, 'billing_invalid_redirect');
    return {url: session.url};
  }
  async function completeInvoice(invoice) {
    if (!invoice?.lines?.has_more) return invoice;
    const lines = []; let after;
    for (let page = 0; page < 5; page++) {
      const result = await stripe.invoices.listLineItems(invoice.id, {limit: 100, ...(after ? {starting_after: after} : {})});
      lines.push(...result.data);
      if (!result.has_more) return {...invoice, lines: {data: lines, has_more: false}};
      after = result.data.at(-1)?.id; if (!after) break;
    }
    fail('Stripe invoice line items are incomplete.', 502, 'billing_invoice_incomplete');
  }
  async function processEvent(event) {
    requireConfiguration(config);
    const lease = await mutate(data => claimBillingEvent(data, event, config, now()));
    if (lease.ignored || lease.duplicate) return {received: true, ...lease};
    try {
      let subscriptionId, allowPaid = true;
      if (event.type.startsWith('checkout.')) {
        const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
        const data = await store.snapshot(); assertMode(session, config); assertMetadata(session, data);
        if (idOf(session.customer) !== data.billing.customerId || session.mode !== 'subscription' || session.metadata.hearwhispers_checkout_intent !== data.billing.operations?.checkout?.id) fail('Checkout does not belong to this workspace intent.', 409, 'billing_binding_mismatch');
        subscriptionId = idOf(session.subscription); allowPaid = ['paid', 'no_payment_required'].includes(session.payment_status);
      } else if (event.type.startsWith('invoice.')) {
        const eventInvoice = await stripe.invoices.retrieve(event.data.object.id); assertMode(eventInvoice, config);
        const data = await store.snapshot(); if (idOf(eventInvoice.customer) !== data.billing.customerId) fail('Invoice customer does not match the workspace.', 409, 'billing_binding_mismatch');
        subscriptionId = invoiceSubscription(eventInvoice);
      } else subscriptionId = event.data.object.id;
      if (!validId(subscriptionId, 'sub')) return await mutate(data => finishBillingEvent(data, lease, {result: 'no_subscription'}, now()));
      const prior = await store.snapshot();
      if (prior.billing.subscriptionId && prior.billing.subscriptionId !== subscriptionId && !TERMINAL_SUBSCRIPTIONS.has(prior.billing.stripeStatus)) return await mutate(data => finishBillingEvent(data, lease, {result: 'unrelated_subscription'}, now()));
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {expand: ['items.data.price', 'latest_invoice']});
      let invoice = subscription.latest_invoice;
      if (typeof invoice === 'string') invoice = await stripe.invoices.retrieve(invoice);
      if (invoice) invoice = await completeInvoice(invoice);
      return await mutate(data => { assertReconciliation(data, lease); const result = applyStripeSubscription(data, subscription, invoice, config, {allowPaid, now: now()}); finishBillingEvent(data, lease, {}, now()); return {received: true, billing: result}; });
    } catch (cause) {
      try { await mutate(data => finishBillingEvent(data, lease, {failed: true, result: cause?.code?.startsWith('billing_') ? cause.code : 'provider_unavailable'}, now())); } catch { /* A newer lease owns settlement. */ }
      throw cause?.code?.startsWith('billing_') ? cause : error('Stripe reconciliation is temporarily unavailable. The event can be retried.', 503, 'billing_provider_unavailable');
    }
  }
  return {checkout, portal, processEvent, webhook: (rawBody, signature) => processEvent(verifyStripeWebhook(stripe, config, rawBody, signature))};
}
