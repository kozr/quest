export const MONITOR_INTERVAL_MS = 60 * 60 * 1000;

export function dueProducts(state, now = Date.now()) {
  return state.products.filter(product => product.monitoring && (product.communities?.length || product.linkedin) &&
    now - Math.max(Date.parse(state.searches[product.id]?.searchedAt || '') || 0, Date.parse(product.lastMonitorAttemptAt || '') || 0) >= MONITOR_INTERVAL_MS);
}

export function startLocalMonitoring({store, runSearch, onError = () => {}, interval = 60000}) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const product of dueProducts(await store.snapshot())) {
        try { await runSearch(product.id, true); } catch { onError(); }
      }
    } catch { onError(); } finally { running = false; }
  }
  const timer = setInterval(tick, interval);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
