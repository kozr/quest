// An operator-approved pilot cap supplements the daily provider caps. These
// helpers run inside the same Store CAS mutation as each provider reservation.
export const PILOT_LIMITS=Object.freeze({aiMicroUsd:3000000,scrapeCredits:13333});
const error=(message,code,status=429,details={})=>Object.assign(new Error(message),{status,code,...details});
const amount=value=>{if(value===undefined)return 0;if(!Number.isSafeInteger(value)||value<0)throw error('The pilot cost ledger is invalid.','pilot_budget_invalid',503);return value;};
const sum=values=>{const value=values.reduce((total,next)=>total+amount(next),0);return amount(value);};
function totals(data){
  const days=Object.values(data.collection?.daily||{});
  return {aiMicroUsd:sum([data.aiBudget?.spentMicroUsd,data.aiBudget?.reservedMicroUsd]),scrapeCredits:sum(days.flatMap(day=>[day.spentCredits,day.reservedCredits]))};
}
export function activatePilotBudget(data,{id,aiMicroUsd=PILOT_LIMITS.aiMicroUsd,scrapeCredits=PILOT_LIMITS.scrapeCredits,now=Date.now()}={}){
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||!Number.isFinite(now))throw error('Choose a valid pilot identifier and activation time.','pilot_budget_invalid',400);
  const limits={aiMicroUsd,scrapeCredits};
  for(const [resource,limit]of Object.entries(limits))if(!Number.isSafeInteger(limit)||limit<1||limit>PILOT_LIMITS[resource])throw error('The pilot limit exceeds the approved provider budget.','pilot_budget_invalid',400);
  if(data.pilotBudget){
    if(data.pilotBudget.id===id&&data.pilotBudget.active===true&&Object.entries(limits).every(([key,value])=>data.pilotBudget.limits?.[key]===value))return pilotBudgetState(data);
    throw error('A pilot budget already exists; activation cannot reset its baseline.','pilot_budget_exists',409);
  }
  // A pre-pilot hold settling below its estimate would otherwise hide new
  // pilot spend in a simple cumulative delta. Start only after those settle.
  if(amount(data.aiBudget?.reservedMicroUsd)||Object.values(data.collection?.daily||{}).some(day=>amount(day.reservedCredits))||data.collection?.active)throw error('Wait for existing provider reservations to settle before activating the pilot.','pilot_reservations_pending',409);
  data.pilotBudget={version:1,id,active:true,activatedAt:new Date(now).toISOString(),limits,baseline:totals(data)};
  return pilotBudgetState(data);
}
export function pilotBudgetState(data){
  const pilot=data.pilotBudget;if(!pilot?.active)return null;
  if(pilot.version!==1||!pilot.baseline||!pilot.limits)throw error('The pilot budget configuration is invalid.','pilot_budget_invalid',503);
  const current=totals(data),resources={};
  for(const resource of Object.keys(PILOT_LIMITS)){
    const baseline=amount(pilot.baseline[resource]),limit=amount(pilot.limits[resource]);
    if(!limit||limit>PILOT_LIMITS[resource]||current[resource]<baseline)throw error('The pilot cost ledger no longer matches its trusted baseline.','pilot_budget_invalid',503);
    const used=current[resource]-baseline;resources[resource]={limit,used,remaining:Math.max(0,limit-used)};
  }
  return {id:pilot.id,active:true,activatedAt:pilot.activatedAt,...resources};
}
export function pilotBudgetBlock(data,resource,reservation){
  if(!data.pilotBudget?.active)return null;
  if(!Object.hasOwn(PILOT_LIMITS,resource)||!Number.isSafeInteger(reservation)||reservation<0)return error('The pilot reservation is invalid.','pilot_budget_invalid',503);
  const state=pilotBudgetState(data),budget=state[resource];
  if(reservation<=budget.remaining)return null;
  return error(resource==='aiMicroUsd'?'The approved total AI pilot budget is exhausted.':'The approved total ScrapeBadger pilot budget is exhausted.',resource==='aiMicroUsd'?'pilot_ai_budget':'pilot_scraper_budget',429,{limit:budget.limit,used:budget.used,reservation});
}
export function assertPilotBudget(data,resource,reservation){const blocked=pilotBudgetBlock(data,resource,reservation);if(blocked)throw blocked;}
