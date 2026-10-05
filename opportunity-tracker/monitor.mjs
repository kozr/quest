export const MONITOR_INTERVAL_MS = 60 * 60 * 1000;
export const LINKEDIN_TIME_ZONE = 'America/Los_Angeles';
export const LINKEDIN_HOURS = [8, 20];
const pacific = new Intl.DateTimeFormat('en-CA', {timeZone: LINKEDIN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'});

// Slots follow Pacific wall time across daylight-saving changes. A late worker
// checks the latest slot once, rather than replaying missed searches.
export function linkedinSlot(now = Date.now()) {
  const parts = Object.fromEntries(pacific.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  let day = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  if (hour < 8) day = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return `${day}:${hour >= 8 && hour < 20 ? '08' : '20'}`;
}

function checkedAt(search, source) {
  if (search?.lastChecks?.[source]) return Date.parse(search.lastChecks[source]) || 0;
  const names = source === 'reddit' ? ['Reddit', 'Reddit watchlist'] : ['LinkedIn'];
  // Migrate the old combined search receipt without treating a Reddit-only
  // check as a LinkedIn check. Old receipts without sources retain Reddit backoff.
  const receipts = (search?.sources || []).filter(row => names.includes(row.name));
  if (receipts.length) return Math.max(...receipts.map(row => Date.parse(row.checkedAt || search.searchedAt) || 0));
  return search && source === 'reddit' && !search.sources?.length ? Date.parse(search.searchedAt) || 0 : 0;
}

export function dueSources(product, state, now = Date.now()) {
  if (!product.monitoring) return [];
  const search = state.searches?.[product.id];
  const attempts = product.monitorAttempts || {};
  const due = [];
  const redditAttempt = Date.parse(attempts.reddit || product.lastMonitorAttemptAt || '') || 0;
  if (product.communities?.length && now - Math.max(checkedAt(search, 'reddit'), redditAttempt) >= MONITOR_INTERVAL_MS) due.push('reddit');
  const linkedinAt = Math.max(checkedAt(search, 'linkedin'), Date.parse(attempts.linkedin || '') || 0);
  if (product.linkedin && (!linkedinAt || linkedinSlot(linkedinAt) < linkedinSlot(now))) due.push('linkedin');
  return due;
}

export function dueProducts(state, now = Date.now()) {
  return state.products.filter(product => dueSources(product, state, now).length);
}

export function startLocalMonitoring({store, runSearch, runQualification, onError = () => {}, interval = 60000}) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const product of dueProducts(await store.snapshot())) {
        try { await runSearch(product.id, true); } catch { onError(); }
      }
      if(runQualification) try {await runQualification();} catch {onError();}
    } catch { onError(); } finally { running = false; }
  }
  const timer = setInterval(tick, interval);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
