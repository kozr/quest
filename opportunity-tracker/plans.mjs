// Server-owned plan policy. Call mutation helpers within the store transaction.
const minute = 60000;
const commonFeatures = {historicalSearch:true,basicFilters:true,manualReview:true,allPurposes:true,personalReview:true,digest:true};
const tierFeatures = {sharedReview:false,assignments:false,configurableAlerts:false,clients:false,clientSeparation:false,reports:false,routing:false,integrations:false};
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }
function plan(id,name,amount,products,keywordSearches,longTailThemes,keyword,discovery,analysis,monthlyAiAnalyses,seats,features={}) {
  const monthlyCollectedMentions={starter:2000,growth:10000,team:50000}[id];
  return {id,name,price:{amount,currency:'USD',interval:'month'},limits:{products,keywordSearches,longTailThemes,monthlyAiAnalyses,monthlyCollectedMentions,seats},intervals:{keyword:keyword*minute,long_tail:discovery*minute,analysis:analysis*minute},history:{days:365,allowancePerProduct:monthlyAiAnalyses,collectedAllowancePerProduct:monthlyCollectedMentions},features:{...commonFeatures,...tierFeatures,...features}};
}
export const PLAN_CATALOG = freeze({
  starter:plan('starter','Starter',39,1,10,3,60,1440,1440,1000,1),
  growth:plan('growth','Growth',99,3,30,10,15,360,60,5000,3,{sharedReview:true,assignments:true,configurableAlerts:true}),
  team:plan('team','Team',249,10,100,30,5,60,15,20000,10,{sharedReview:true,assignments:true,configurableAlerts:true,clients:true,clientSeparation:true,reports:true,routing:true,integrations:true}),
});
const plans = Object.values(PLAN_CATALOG);
const subscriptionStatuses = new Set(['manual','trial','active','past_due','cancelled']);
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function timestamp(value,label) { const at=typeof value==='number'?value:Date.parse(value);if(!Number.isFinite(at)||!Number.isFinite(new Date(at).getTime()))throw planError(`Invalid ${label}.`,{status:400,code:'invalid_subscription'});return new Date(at).toISOString(); }
export function planError(message,{status=403,code='plan_limit',limit=null,used=null,resetAt=null,requiredPlan=null,...details}={}) {
  return Object.assign(new Error(message),{status,code,limit,used,resetAt,requiredPlan,...details});
}
export function planFor(data) {
  const id = typeof data === 'string' ? data : data?.subscription?.planId ?? 'starter';
  if (!own(PLAN_CATALOG,id)) throw planError('Choose a valid subscription plan.',{status:400,code:'invalid_plan'});
  return PLAN_CATALOG[id];
}
export function subscriptionState(data,now=Date.now()) {
  const p=planFor(data), subscription=data?.subscription;
  const status=subscription?.status ?? 'manual';
  if (!subscriptionStatuses.has(status)) throw planError('The subscription status is invalid.',{status:409,code:'invalid_subscription'});
  const trialEndsAt=status==='trial'?subscription?.trialEndsAt:null;
  if(status==='trial'&&!Number.isFinite(Date.parse(trialEndsAt)))throw planError('A trial must have a valid expiry.',{status:409,code:'invalid_subscription'});
  const paidUntil=subscription?.managedBy==='stripe'?subscription.paidUntil:null;
  const effectiveStatus=status==='trial'&&Date.parse(trialEndsAt)<=now||status==='active'&&subscription?.managedBy==='stripe'&&(!Number.isFinite(Date.parse(paidUntil))||Date.parse(paidUntil)<=now)?'expired':status;
  return {planId:p.id,status,effectiveStatus,trialEndsAt:trialEndsAt||null,paidUntil:paidUntil||null,active:['manual','active','trial'].includes(effectiveStatus),managedBy:subscription?.managedBy||'manual'};
}
export function assertSubscriptionActive(data,now=Date.now()) {
  const state=subscriptionState(data,now);
  if(!state.active)throw planError('An active subscription is required for this action.',{status:402,code:'subscription_inactive',subscriptionStatus:state.effectiveStatus});
  return planFor(data);
}
export function ensureSubscription(data,{now=Date.now(),planId='starter',status='manual',trialEndsAt}={}) {
  if(data.subscription) { subscriptionState(data,now); return structuredClone(data.subscription); }
  const at=timestamp(now,'subscription timestamp');
  const candidate={planId,status,managedBy:'manual',createdAt:at,updatedAt:at,...(trialEndsAt?{trialEndsAt:timestamp(trialEndsAt,'trial expiry')}:{})};
  subscriptionState({subscription:candidate},now);
  data.subscription=candidate;
  return structuredClone(candidate);
}
export function activeProduct(product) { return product?.archived!==true && product?.status!=='archived'; }
function values(value) { return Array.isArray(value)?value:object(value)?Object.values(value):[]; }
export function capacityUsage(data,{now=Date.now(),products=data.products||[],members=data.workspace?.members,invites=data.workspace?.invites}={}) {
  let keywordSearches=0,longTailThemes=0;
  const active=products.filter(activeProduct);
  for(const product of active) {
    const themes=product.searchPlanV2?.themes;
    if(Array.isArray(themes)&&themes.length) {
      for(const theme of themes) {
        const queries=Array.isArray(theme.queries)?theme.queries:[];
        keywordSearches+=queries.filter(query=>query.loop!=='long_tail').length;
        // Legacy longTail was descriptive but already represented a monitored theme.
        if(queries.some(query=>query.loop==='long_tail')||theme.legacyLongTail===true||queries.every(query=>query.loop===undefined)&&Array.isArray(theme.longTail)&&theme.longTail.length)longTailThemes++;
      }
    } else keywordSearches+=(Array.isArray(product.keywordSearches)?product.keywordSearches:Array.isArray(product.keywords)?product.keywords:[]).length;
  }
  const activeMembers=values(members).filter(member=>member.status==='active');
  const pendingInvites=values(invites).filter(invite=>invite.status==='pending'&&Date.parse(invite.expiresAt)>now);
  return {products:active.length,keywordSearches,longTailThemes,seats:activeMembers.length+pendingInvites.length,members:activeMembers.length,pendingInvites:pendingInvites.length};
}
const capacityNames={products:'active products',keywordSearches:'tracked keyword searches',longTailThemes:'long-tail themes',seats:'members and pending invitations'};
export function requiredPlanFor(resource,used) { return plans.find(p=>(p.limits[resource]??-1)>=used)?.id ?? null; }
export function assertWorkspaceCapacity(data,options={}) {
  const p=options.planId?planFor(options.planId):planFor(data),usage=capacityUsage(data,options);
  for(const [resource,label] of Object.entries(capacityNames))if(usage[resource]>p.limits[resource])throw planError(`${p.name} includes up to ${p.limits[resource]} ${label}.`,{status:403,code:'plan_capacity_exceeded',resource,limit:p.limits[resource],used:usage[resource],requiredPlan:requiredPlanFor(resource,usage[resource])});
  return usage;
}
export function assertFeature(data,feature,{now=Date.now()}={}) {
  const p=assertSubscriptionActive(data,now);
  if(!own(p.features,feature))throw planError('Unknown plan feature.',{status:400,code:'unknown_feature',feature});
  if(!p.features[feature])throw planError(`This feature is not included in ${p.name}.`,{status:403,code:'feature_unavailable',feature,requiredPlan:plans.find(row=>row.features[feature])?.id??null});
  return true;
}
// Downgrades are explicit: archive excess products or remove excess settings/seats
// first. This helper never deletes historical results, memberships or notes.
export function setSubscriptionPlan(data,planId,{now=Date.now(),status=data.subscription?.status??'manual',trialEndsAt=data.subscription?.trialEndsAt,managedBy=data.subscription?.managedBy??'manual'}={}) {
  const p=planFor(planId);
  const at=timestamp(now,'subscription timestamp');
  const next={...data.subscription,planId:p.id,status,managedBy,createdAt:data.subscription?.createdAt??at,updatedAt:at};
  if(status==='trial')next.trialEndsAt=timestamp(trialEndsAt,'trial expiry');else delete next.trialEndsAt;
  subscriptionState({subscription:next},now);
  assertWorkspaceCapacity(data,{now,planId:p.id});
  data.subscription=next;
  return structuredClone(next);
}
// Imported user backups cannot author policy, cost ledgers, leases or tenancy.
export const SERVER_OWNED_FIELDS=Object.freeze(['workspace','subscription','usage','quotas','loopSchedules','analysisCycles','collection','ingestion','analysisLeases','analysisUsage','aiBudget','pilotBudget','collectedUsage','leases','loginFailures','conversationReviewReceipts','conversationReviewFailures','qualifications','qualificationMigrations','notifications','notificationOutbox','integrations','billing']);
export function preserveServerOwnedState(current,incoming,{now=Date.now(),validateCapacity=true}={}) {
  const next=structuredClone(incoming);
  for(const field of SERVER_OWNED_FIELDS) {
    if(own(current,field))next[field]=structuredClone(current[field]);else delete next[field];
  }
  if(validateCapacity)assertWorkspaceCapacity(next,{now});
  return next;
}
