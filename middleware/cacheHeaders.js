/**
 * Cache middleware for API responses
 * Adds proper HTTP Cache-Control headers for different endpoint types
 *
 * Usage:
 * app.use("/api/enquiries", apiCacheHeaders({ maxAge: 60 }), enquiriesRouter);
 */

const apiCacheHeaders = ({
    maxAge = 60, // seconds
    staleWhileRevalidate = 300, // seconds - allow stale responses while revalidating
    staleIfError = 86400, // seconds - allow stale responses on error
    public: isPublic = false, // public cache vs private
} = {}) => {
    return (req, res, next) => {
        // Only cache GET requests
        if (req.method !== "GET") {
            res.set(
                "Cache-Control",
                "no-store, no-cache, must-revalidate, proxy-revalidate",
            );
            return next();
        }

        // Cache-Control header with stale-while-revalidate and stale-if-error
        const cacheControl = [
            isPublic ? "public" : "private",
            `max-age=${maxAge}`,
            `stale-while-revalidate=${staleWhileRevalidate}`,
            `stale-if-error=${staleIfError}`,
        ].join(", ");

        res.set("Cache-Control", cacheControl);

        // Add ETag for conditional requests
        res.set("Vary", "Authorization, Accept-Encoding");

        // Add Last-Modified header (can be used for 304 responses)
        res.set("Last-Modified", new Date().toUTCString());

        next();
    };
};

/**
 * Lightweight middleware to add cache version header
 * Helps clients determine if their cache is outdated
 */
const addCacheVersionHeader = (version = "1.0.0") => {
    return (req, res, next) => {
        res.set("X-Cache-Version", version);
        next();
    };
};

/**
 * Response wrapper for cached API responses
 * Includes metadata about cache status
 */
const wrapCachedResponse = (
    data,
    { cached = false, version = "1", age = 0 } = {},
) => {
    return {
        success: true,
        data,
        cache: {
            version,
            cached,
            age, // milliseconds since data was generated
            timestamp: Date.now(),
        },
    };
};

module.exports = {
    apiCacheHeaders,
    addCacheVersionHeader,
    wrapCachedResponse,
};
