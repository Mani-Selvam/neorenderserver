/**
 * ⚡ Response Cache with Request Deduplication
 * 
 * Solves TWO problems:
 * 1. MongoDB Atlas M0 free tier is extremely slow (2-9 seconds per query)
 *    → Cache responses in memory so repeated requests are instant
 * 
 * 2. Frontend sends duplicate concurrent requests (e.g. tab=All called twice)
 *    → If the same query is already in flight, wait for it instead of hitting DB again
 */

class ResponseCache {
    constructor() {
        this.cache = new Map();
        this.pending = new Map(); // Track in-flight DB queries for deduplication
        setInterval(() => this.cleanup(), 60000);
    }

    /**
     * Generate a cache key from request parameters
     */
    key(prefix, params) {
        return `${prefix}:${JSON.stringify(params)}`;
    }

    /**
     * Get cached response if still valid
     */
    get(cacheKey, ttlMs = 60000) {
        const entry = this.cache.get(cacheKey);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > ttlMs) {
            this.cache.delete(cacheKey);
            return null;
        }
        return entry.data;
    }

    /**
     * Store response in cache
     */
    set(cacheKey, data) {
        this.cache.set(cacheKey, {
            data,
            timestamp: Date.now()
        });
    }

    /**
     * ⚡ Smart query wrapper — handles cache, dedup, and DB in one call
     * 
     * 1. Returns cached data if available
     * 2. If same query is already in flight, waits for it (dedup)
     * 3. Otherwise runs the query, caches result, and returns
     * 
     * @param {string} cacheKey - The cache key
     * @param {Function} queryFn - Async function that runs the DB query and returns data
     * @param {number} ttlMs - Cache TTL in milliseconds
     * @returns {{ data: any, source: string }} - data and source ('cache', 'dedup', or 'db')
     */
    async wrap(cacheKey, queryFn, ttlMs = 60000) {
        // 1. Check cache
        const cached = this.get(cacheKey, ttlMs);
        if (cached) return { data: cached, source: 'CACHED' };

        // 2. Check if same query is already running (dedup)
        if (this.pending.has(cacheKey)) {
            try {
                const data = await this.pending.get(cacheKey);
                return { data, source: 'DEDUP' };
            } catch (e) {
                // Pending request failed, fall through to run our own query
            }
        }

        // 3. Run the query and track it as pending
        const promise = queryFn();
        this.pending.set(cacheKey, promise);

        try {
            const data = await promise;
            this.set(cacheKey, data);
            return { data, source: 'DB' };
        } finally {
            this.pending.delete(cacheKey);
        }
    }

    /**
     * Invalidate all cache entries matching a prefix
     */
    invalidate(prefix) {
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
        for (const key of this.pending.keys()) {
            if (key.startsWith(prefix)) {
                this.pending.delete(key);
            }
        }
    }

    /**
     * Clear all entries
     */
    clear() {
        this.cache.clear();
        this.pending.clear();
    }

    /**
     * Remove expired entries
     */
    cleanup() {
        const now = Date.now();
        const MAX_AGE = 120000;
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > MAX_AGE) {
                this.cache.delete(key);
            }
        }
    }
}

const cache = new ResponseCache();
module.exports = cache;
