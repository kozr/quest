import {setTimeout as pause} from 'node:timers/promises';

export class CollectionError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

export async function readText(response, maxBytes = 2_097_152) {
  if (!response.ok) { await response.body?.cancel(); throw new CollectionError(`upstream_http_${response.status}`); }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new CollectionError('response_too_large');
  }
  if (!response.body) throw new CollectionError('empty_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new CollectionError('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Retries transient transport failures only, under the caller's overall deadline. */
export async function fetchText(url, {fetchImpl = fetch, signal, headers = {}, contentType = 'text/html', retries = 2, sleep = pause} = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, {signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8_000)]), redirect: 'error', headers});
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt >= retries) throw new CollectionError('upstream_unreachable');
      await sleep(300 * 2 ** attempt, undefined, {signal}); continue;
    }
    if ([429, 502, 503, 504].includes(response.status) && attempt < retries) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = Number(retryAfter);
      const delay = retryAfter && Number.isFinite(seconds) ? seconds * 1_000 : 300 * 2 ** attempt;
      await response.body?.cancel();
      // Do not retry earlier than a long upstream Retry-After.
      if (delay > 2_000) throw new CollectionError('upstream_rate_limited', 503);
      await sleep(Math.max(300, delay), undefined, {signal}); continue;
    }
    if (!response.ok) return readText(response);
    if (!(response.headers.get('content-type') || '').includes(contentType)) {
      await response.body?.cancel(); throw new CollectionError('unexpected_content_type');
    }
    return readText(response);
  }
}
