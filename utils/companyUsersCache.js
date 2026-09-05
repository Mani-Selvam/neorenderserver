/**
 * ⚡ Company Users Cache
 *
 * Problem: Every enquiry/followup request calls User.find({ company_id }) to
 * build the scope filter AND again in every socket-emit helper. With Atlas M0
 * that's 2-4 extra round-trips of 200-900ms each on every API call.
 *
 * Solution: Cache the list of user _ids per companyId for a short TTL (30s).
 * The list changes only when staff are added/removed/deactivated, which is rare
 * and can tolerate a 30-second stale window. Any write that changes staff
 * membership should call `invalidateCompanyUsers(companyId)`.
 */

const mongoose = require("mongoose");

const TTL_MS = Number(process.env.COMPANY_USERS_CACHE_TTL_MS || 30000);

const _cache = new Map(); // companyId.toString() → { ids: ObjectId[], ts: number }

/**
 * Return cached user _ids for a companyId, fetching from DB if needed.
 * @param {mongoose.Types.ObjectId|string} companyId
 * @returns {Promise<mongoose.Types.ObjectId[]>}
 */
async function getCompanyUserIds(companyId) {
    if (!companyId) return [];
    const key = String(companyId);

    const entry = _cache.get(key);
    if (entry && Date.now() - entry.ts < TTL_MS) {
        return entry.ids;
    }

    const User = mongoose.models.User;
    if (!User) return [];

    const users = await User.find({ company_id: companyId }).select("_id").lean();
    const ids = users
        .map((u) => u._id)
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));

    _cache.set(key, { ids, ts: Date.now() });
    return ids;
}

/**
 * Force-evict a company's cached user list (call after staff add/remove).
 * @param {mongoose.Types.ObjectId|string} companyId
 */
function invalidateCompanyUsers(companyId) {
    if (!companyId) return;
    _cache.delete(String(companyId));
}

// Auto-cleanup stale entries every 60s to prevent unbounded growth
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of _cache.entries()) {
        if (now - entry.ts > TTL_MS * 4) _cache.delete(key);
    }
}, 60000);

module.exports = { getCompanyUserIds, invalidateCompanyUsers };
