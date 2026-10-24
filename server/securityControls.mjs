/**
 * Lightweight process-local API abuse controls and baseline HTTP security headers.
 *
 * Production deployments with multiple instances must also enforce equivalent
 * limits at a trusted gateway/WAF. Client IP comes from the socket by default;
 * forwarded headers are deliberately not trusted by this module.
 */
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_API_LIMIT = 120;
const DEFAULT_WRITE_LIMIT = 30;
const MAX_TRACKED_KEYS = 10_000;

export function createApiRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  apiLimit = DEFAULT_API_LIMIT,
  writeLimit = DEFAULT_WRITE_LIMIT,
  now = () => Date.now(),
  maxTrackedKeys = MAX_TRACKED_KEYS
} = {}) {
  const buckets = new Map();

  function consume(key, limit) {
    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || currentTime >= bucket.resetAt) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.delete(key);
      buckets.set(key, bucket);
    } else {
      // Refresh insertion order for bounded LRU-like eviction.
      buckets.delete(key);
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (buckets.size > maxTrackedKeys) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }

    return {
      allowed: bucket.count <= limit,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000))
    };
  }

  return {
    check({ key, isWrite = false } = {}) {
      const normalizedKey = typeof key === 'string' && key ? key : 'unknown-client';
      return consume(normalizedKey, isWrite ? writeLimit : apiLimit);
    },
    get trackedKeys() { return buckets.size; }
  };
}

export function applySecurityHeaders(res, { enableHsts = false } = {}) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('cache-control', 'no-store');
  if (enableHsts) {
    // Enable only when HTTPS is guaranteed at the public edge.
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

export function getClientRateLimitKey(req) {
  // Do not trust X-Forwarded-For unless a separately configured trusted proxy
  // adapter has validated and normalized it.
  return req.socket?.remoteAddress || 'unknown-client';
}
