/**
 * cache.js — simple in-memory TTL cache
 *
 * Usage:
 *   import { withCache, bustCache } from './cache.js';
 *
 *   router.get('/heavy', withCache('1h'), handler);
 *   router.post('/upload', handler, bustCache('*'));   // invalidate everything
 */

// ─── TTL shorthands ──────────────────────────────────────────────────────────
const TTL = {
  '5m':  5  * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '6h':  6  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

function parseTtl(ttl) {
  if (typeof ttl === 'number') return ttl;
  if (TTL[ttl]) return TTL[ttl];
  throw new Error(`Unknown TTL string "${ttl}". Use a number (ms) or one of: ${Object.keys(TTL).join(', ')}`);
}

// ─── Store ───────────────────────────────────────────────────────────────────
const store    = new Map();
const inflight = new Map(); // key → Promise  (single-flight coalescing)

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { store.delete(key); return null; }
  return entry.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

/**
 * Invalidate all keys that start with `prefix`.
 * Pass '*' to clear everything.
 */
export function invalidate(prefix = '*') {
  if (prefix === '*') { store.clear(); inflight.clear(); return; }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheStats() {
  const now = Date.now();
  let alive = 0, expired = 0;
  for (const [, v] of store) {
    v.expires > now ? alive++ : expired++;
  }
  return { total: store.size, alive, expired };
}

// ─── Express middleware ───────────────────────────────────────────────────────

/**
 * withCache(ttl, keyFn?)
 *
 * ttl    — '5m' | '30m' | '1h' | '6h' | '24h'  or milliseconds
 * keyFn  — optional fn(req) → string for a custom cache key
 *           defaults to req.originalUrl (method + full URL + query string)
 *
 * Only caches 200 responses.
 * Adds X-Cache: HIT/MISS header for debugging.
 */
export function withCache(ttl, keyFn) {
  const ttlMs = parseTtl(ttl);

  return (req, res, next) => {
    const key    = keyFn ? keyFn(req) : req.originalUrl;
    const cached = cacheGet(key);

    // ── Cache hit ────────────────────────────────────────────────────────────
    if (cached !== null) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    // ── Single-flight coalescing ─────────────────────────────────────────────
    // If another request is already fetching this key, wait for its result
    // instead of firing a duplicate DB query (thunder herd prevention).
    if (inflight.has(key)) {
      res.setHeader('X-Cache', 'COALESCED');
      inflight.get(key)
        .then(data => res.json(data))
        .catch(err  => next(err));
      return;
    }

    // ── Cache miss — this request does the work ──────────────────────────────
    res.setHeader('X-Cache', 'MISS');

    let resolveInflight, rejectInflight;
    const promise = new Promise((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight  = reject;
    });
    inflight.set(key, promise);

    // Intercept res.json to populate cache + resolve waiting requests
    const origJson = res.json.bind(res);
    res.json = (data) => {
      inflight.delete(key);
      if (res.statusCode === 200) {
        cacheSet(key, data, ttlMs);
        resolveInflight(data);
      } else {
        rejectInflight(new Error(`Upstream returned ${res.statusCode}`));
      }
      return origJson(data);
    };

    // If the handler throws, clean up inflight so it doesn't block forever
    const origNext = next;
    next = (err) => {
      if (err) { inflight.delete(key); rejectInflight(err); }
      origNext(err);
    };

    next();
  };
}

/**
 * bustCache(prefix)
 * Express middleware — call AFTER a successful write to invalidate stale cache.
 * Typically used as the last middleware in a POST/PUT/DELETE chain.
 *
 * Example:
 *   router.delete('/:id', requireAdmin, deleteHandler, bustCache('/api/holdings'));
 */
export function bustCache(prefix = '*') {
  return (_req, _res, next) => {
    invalidate(prefix);
    next();
  };
}
