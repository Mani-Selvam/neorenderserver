const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const FollowUp = require("../models/FollowUp");
const User = require("../models/User");
const AdminStaffPayment = require("../models/AdminStaffPayment");
const AIPayment = require("../models/AIPayment");
const WebsiteLead = require("../models/WebsiteLead");
const CommunicationGroup = require("../models/CommunicationGroup");
const CommunicationMessage = require("../models/CommunicationMessage");
const { verifyToken } = require("../middleware/auth");
const cache = require("../utils/responseCache");

// Throttle expensive "auto-mark Missed" maintenance in production.
const AUTO_MISSED_SYNC_TTL_MS = Number(process.env.AUTO_MISSED_SYNC_TTL_MS || 20000);
const lastAutoMissSyncAt = new Map();
const shouldRunAutoMissSync = (key) => {
    const now = Date.now();
    const last = lastAutoMissSyncAt.get(key) || 0;
    if (now - last < AUTO_MISSED_SYNC_TTL_MS) return false;
    lastAutoMissSyncAt.set(key, now);
    return true;
};

// Cache company user ids to avoid repeated User.find() on every dashboard refresh.
const COMPANY_USER_CACHE_TTL_MS = Number(process.env.COMPANY_USER_CACHE_TTL_MS || 60000);
const companyUserIdCache = new Map(); // key -> { at:number, ids:ObjectId[] }
const getCompanyUserIdsCached = async (companyId) => {
    const key = String(companyId || "");
    const now = Date.now();
    const hit = companyUserIdCache.get(key);
    if (hit && now - hit.at < COMPANY_USER_CACHE_TTL_MS) return hit.ids || [];

    const rows = await User.find({ company_id: companyId }).select("_id").lean();
    const ids = (rows || [])
        .map((u) => u?._id)
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
    companyUserIdCache.set(key, { at: now, ids });
    return ids;
};

const toLocalIsoDate = (d = new Date()) => {
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

const clampTzOffsetMinutes = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(n)));
};

const toClientIsoDate = (tzOffsetMinutes) => {
    const off = clampTzOffsetMinutes(tzOffsetMinutes);
    if (off == null) return toLocalIsoDate(new Date());
    return new Date(Date.now() - off * 60 * 1000).toISOString().slice(0, 10);
};

const getClientNowMinutes = (tzOffsetMinutes) => {
    const off = clampTzOffsetMinutes(tzOffsetMinutes);
    if (off == null) {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    }
    const shifted = new Date(Date.now() - off * 60 * 1000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const parseIsoDate = (value) => {
    if (!value) return null;
    if (typeof value === "string") {
        const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
            const y = Number(m[1]);
            const mon = Number(m[2]) - 1;
            const day = Number(m[3]);
            const local = new Date(y, mon, day);
            return Number.isNaN(local.getTime()) ? null : local;
        }
    }
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
};

const parseTimeToMinutes = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const m = raw.match(/^(\d{1,2})(?:[:.](\d{2}))?(?:\s*([AaPp][Mm]))?$/);
    if (!m) return null;
    let hh = Number(m[1]);
    const mm = Number(m[2] ?? "0");
    const meridian = String(m[3] || "").toUpperCase();
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59) return null;

    if (meridian) {
        if (hh < 1 || hh > 12) return null;
        if (meridian === "AM") {
            if (hh === 12) hh = 0;
        } else if (meridian === "PM") {
            if (hh !== 12) hh += 12;
        }
    } else if (hh > 23) {
        return null;
    }

    return hh * 60 + mm;
};

const getRangeBounds = ({ range = "day", date = new Date() } = {}) => {
    const dt = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(dt.getTime())) {
        const today = new Date();
        return { rangeFrom: toLocalIsoDate(today), rangeTo: toLocalIsoDate(today) };
    }

    const normalized = String(range || "day").trim().toLowerCase();
    if (normalized === "year") {
        const start = new Date(dt.getFullYear(), 0, 1);
        const end = new Date(dt.getFullYear(), 11, 31);
        return { rangeFrom: toLocalIsoDate(start), rangeTo: toLocalIsoDate(end) };
    }
    if (normalized === "month") {
        const start = new Date(dt.getFullYear(), dt.getMonth(), 1);
        const end = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
        return { rangeFrom: toLocalIsoDate(start), rangeTo: toLocalIsoDate(end) };
    }
    if (normalized === "week") {
        // ISO-like week starting Monday.
        const day = dt.getDay(); // 0 Sun ... 6 Sat
        const diffToMonday = (day + 6) % 7;
        const start = new Date(dt);
        start.setDate(dt.getDate() - diffToMonday);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return { rangeFrom: toLocalIsoDate(start), rangeTo: toLocalIsoDate(end) };
    }
    const iso = toLocalIsoDate(dt);
    return { rangeFrom: iso, rangeTo: iso };
};

const shiftIsoDate = (iso, days) => {
    const dt = parseIsoDate(iso) || new Date();
    const next = new Date(dt);
    next.setDate(dt.getDate() + Number(days || 0));
    return toLocalIsoDate(next);
};

const getPrevRangeBounds = ({ range = "day", date = new Date() } = {}) => {
    const dt = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(dt.getTime())) {
        const today = new Date();
        const iso = toLocalIsoDate(today);
        return { prevFrom: iso, prevTo: iso };
    }

    const normalized = String(range || "day").trim().toLowerCase();
    if (normalized === "year") {
        const start = new Date(dt.getFullYear() - 1, 0, 1);
        const end = new Date(dt.getFullYear() - 1, 11, 31);
        return { prevFrom: toLocalIsoDate(start), prevTo: toLocalIsoDate(end) };
    }
    if (normalized === "month") {
        const start = new Date(dt.getFullYear(), dt.getMonth() - 1, 1);
        const end = new Date(dt.getFullYear(), dt.getMonth(), 0);
        return { prevFrom: toLocalIsoDate(start), prevTo: toLocalIsoDate(end) };
    }
    if (normalized === "week") {
        const { rangeFrom, rangeTo } = getRangeBounds({ range: "week", date: dt });
        return { prevFrom: shiftIsoDate(rangeFrom, -7), prevTo: shiftIsoDate(rangeTo, -7) };
    }
    const iso = toLocalIsoDate(dt);
    return { prevFrom: shiftIsoDate(iso, -1), prevTo: shiftIsoDate(iso, -1) };
};

const sumByDateToMap = (rows = []) => {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const date = String(row?._id || "").trim();
        if (!date) continue;
        map.set(date, {
            count: Number(row?.count || 0),
            amount: Number(row?.amount || 0),
        });
    }
    return map;
};

const parseIsoDateParts = (iso) => {
    const m = String(iso || "")
        .trim()
        .match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
};

const getUtcBoundsForClientIsoRange = (fromIso, toIso, tzOffsetMinutes) => {
    const off = clampTzOffsetMinutes(tzOffsetMinutes);
    if (off == null) return null;
    const from = parseIsoDateParts(fromIso);
    const to = parseIsoDateParts(toIso);
    if (!from || !to) return null;
    const fromUtcMs =
        Date.UTC(from.y, from.m - 1, from.d, 0, 0, 0, 0) + off * 60 * 1000;
    const toUtcMs =
        Date.UTC(to.y, to.m - 1, to.d, 23, 59, 59, 999) + off * 60 * 1000;
    return { fromUtc: new Date(fromUtcMs), toUtc: new Date(toUtcMs) };
};

const buildEnquiryDateFilter = ({ fromIso, toIso, tzOffsetMinutes }) => {
    const byDate = { date: { $gte: fromIso, $lte: toIso } };
    const utc = getUtcBoundsForClientIsoRange(fromIso, toIso, tzOffsetMinutes);
    if (!utc) return byDate;
    return {
        $or: [byDate, { createdAt: { $gte: utc.fromUtc, $lte: utc.toUtc } }],
    };
};

const andMatch = (...parts) => {
    const cleaned = parts.filter(
        (p) => p && typeof p === "object" && Object.keys(p).length > 0,
    );
    if (cleaned.length === 0) return {};
    if (cleaned.length === 1) return cleaned[0];
    return { $and: cleaned };
};

// Get Dashboard Summary
router.get("/summary", verifyToken, async (req, res) => {
    const _start = Date.now();
    try {
        const range = String(req.query.range || "day").trim().toLowerCase();
        const dateRef =
            req.query.date ||
            req.query.referenceDate ||
            req.query.day ||
            "";
        const tzOffsetMinutes = req.query.tzOffsetMinutes;
        const parsedRef = parseIsoDate(dateRef) || new Date();
        const { rangeFrom, rangeTo } = getRangeBounds({ range, date: parsedRef });
        const { prevFrom, prevTo } = getPrevRangeBounds({ range, date: parsedRef });
        const { rangeFrom: weekFrom, rangeTo: weekTo } = getRangeBounds({
            range: "week",
            date: parsedRef,
        });

        const roleStr = String(req.user?.role || "").trim().toLowerCase();
        const cacheKey = cache.key("dashboard", {
            userId: roleStr === "staff" ? req.userId : "company-wide",
            companyId: req.user?.company_id || "none",
            role: roleStr,
            range,
            date: toLocalIsoDate(parsedRef),
            rangeFrom,
            rangeTo,
            prevFrom,
            prevTo,
            weekFrom,
            weekTo,
            tzOffsetMinutes,
        });

        // ⚡ Use cache.wrap to deduplicate concurrent requests
        // Keep TTL low because "Missed" is real-time (dueAt < now), and users expect it to update fast.
        const today = toLocalIsoDate(parsedRef);
        const realToday = toClientIsoDate(tzOffsetMinutes);
        const isRealToday = today === realToday;
        const now = new Date();
        const nowMinutes = getClientNowMinutes(tzOffsetMinutes);

        // Data isolation query (Optimized for company-wide admin visibility)
        const role = String(req.user?.role || "").trim().toLowerCase();
        const userId = req.userId;
        const companyId = req.user?.company_id;

        const query = {};
        if (role === "staff") {
            query.userId = new mongoose.Types.ObjectId(req.user?.parentUserId || userId);
            query.assignedTo = new mongoose.Types.ObjectId(userId);
        } else if (companyId) {
            const companyObjId = mongoose.Types.ObjectId.isValid(String(companyId))
                ? new mongoose.Types.ObjectId(companyId)
                : null;
            if (companyObjId) {
                const ownerUserIds = await getCompanyUserIdsCached(companyId);
                query.$or = [{ companyId: companyObjId }];
                if (ownerUserIds.length > 0) {
                    query.$or.push({ userId: { $in: ownerUserIds } });
                }
            } else {
                query.userId = new mongoose.Types.ObjectId(userId);
            }
        } else {
            query.userId = new mongoose.Types.ObjectId(userId);
        }

        // ⚡ Auto-mark Missed — runs in background, never blocks the response
        const autoSyncKey = `dash:${String(req.user?.company_id || "")}:${String(req.userId || "")}:${realToday}`;
        if (isRealToday && shouldRunAutoMissSync(autoSyncKey)) {
            const _query = { ...query };
            const _today = today;
            const _now = now;
            const _nowMinutes = nowMinutes;
            setImmediate(async () => {
                try {
                    await FollowUp.updateMany(
                        {
                            ..._query,
                            isCurrent: { $ne: false },
                            date: _today,
                            dueAt: { $lte: _now },
                            status: { $nin: ["Completed", "Drop", "Dropped", "Missed"] },
                        },
                        { $set: { status: "Missed" } },
                    );

                    const legacyRows = await FollowUp.find({
                        ..._query,
                        isCurrent: { $ne: false },
                        date: _today,
                        time: { $exists: true, $ne: null, $ne: "" },
                        status: { $nin: ["Completed", "Drop", "Dropped", "Missed"] },
                        $or: [{ dueAt: null }, { dueAt: { $exists: false } }],
                    })
                        .select("_id time")
                        .limit(500)
                        .lean();

                    if (Array.isArray(legacyRows) && legacyRows.length > 0) {
                        const ids = legacyRows
                            .filter((row) => {
                                const mins = parseTimeToMinutes(row?.time);
                                return mins != null && mins <= _nowMinutes;
                            })
                            .map((row) => row?._id);

                        if (ids.length > 0) {
                            await FollowUp.updateMany(
                                { _id: { $in: ids } },
                                { $set: { status: "Missed", dueAt: new Date(_now.getTime() - 1000) } },
                            );
                        }
                    }

                    await FollowUp.updateMany(
                        {
                            ..._query,
                            isCurrent: { $ne: false },
                            status: "Missed",
                            $or: [{ date: { $gt: _today } }, { date: _today, dueAt: { $gt: _now } }],
                        },
                        { $set: { status: "Scheduled" } },
                    );

                    const legacyMissed = await FollowUp.find({
                        ..._query,
                        isCurrent: { $ne: false },
                        status: "Missed",
                        date: _today,
                        time: { $exists: true, $ne: null, $ne: "" },
                        $or: [{ dueAt: null }, { dueAt: { $exists: false } }],
                    })
                        .select("_id time")
                        .limit(500)
                        .lean();

                    const unmissIds = legacyMissed
                        .filter((row) => {
                            const mins = parseTimeToMinutes(row?.time);
                            return mins != null && mins > _nowMinutes;
                        })
                        .map((row) => row._id);

                    if (unmissIds.length > 0) {
                        await FollowUp.updateMany(
                            { _id: { $in: unmissIds } },
                            { $set: { status: "Scheduled" } },
                        );
                    }
                } catch (_missedSyncError) {
                    console.error("[Dashboard] Auto-mark Missed failed:", _missedSyncError.message);
                }
            });
        }

        const { data: response, source } = await cache.wrap(cacheKey, async () => {
            const dateFilter = buildEnquiryDateFilter({
                fromIso: rangeFrom,
                toIso: rangeTo,
                tzOffsetMinutes,
            });
            const prevDateFilter = buildEnquiryDateFilter({
                fromIso: prevFrom,
                toIso: prevTo,
                tzOffsetMinutes,
            });
            const weekDateFilter = buildEnquiryDateFilter({
                fromIso: weekFrom,
                toIso: weekTo,
                tzOffsetMinutes,
            });
            const todayDateFilter = buildEnquiryDateFilter({
                fromIso: today,
                toIso: today,
                tzOffsetMinutes,
            });

            const CURRENT_FOLLOWUP_CLAUSE = { isCurrent: { $ne: false } };
            const openFollowUpStatusFilter = {
                status: { $nin: ["Missed", "Completed", "Drop", "Dropped", "Converted"] },
            };
            const missedFollowUpStatusFilter = { status: "Missed" };

            const todayOpenFollowUpQuery = {
                ...query,
                date: today,
                ...CURRENT_FOLLOWUP_CLAUSE,
                ...openFollowUpStatusFilter,
            };

            const missedFollowUpQuery = {
                ...query,
                ...CURRENT_FOLLOWUP_CLAUSE,
                ...missedFollowUpStatusFilter,
            };

            const upcomingFollowUpQuery = {
                ...query,
                date: { $gt: today },
                ...CURRENT_FOLLOWUP_CLAUSE,
                ...openFollowUpStatusFilter,
            };

            // Run all queries in parallel
            const [
                countsResult,
                totalEnquiry,
                todayEnquiry,
                revenueResult,
                prevRevenueResult,
                weekSalesByDate,
                todayFollowUpsCount,
                missedFollowUpsCount,
                upcomingFollowUpsCount,
                recentEnquiries,
                todayList,
                missedList,
                upcomingList,
                unreadChatCount,
            ] = await Promise.all([
                Enquiry.aggregate([
                    { $match: andMatch(query, dateFilter) },
                    { $group: { _id: "$status", count: { $sum: 1 } } }
                ]),
                Enquiry.countDocuments(andMatch(query, dateFilter)),
                Enquiry.countDocuments(andMatch(query, todayDateFilter)),
                Enquiry.aggregate([
                    { $match: andMatch(query, dateFilter, { status: "Converted" }) },
                    {
                        $facet: {
                            overall: [
                                {
                                    $group: {
                                        _id: null,
                                        totalAmount: { $sum: { $toDouble: "$cost" } },
                                        count: { $sum: 1 },
                                    },
                                },
                            ],
                        }
                    }
                ]),
                Enquiry.aggregate([
                    { $match: andMatch(query, prevDateFilter, { status: "Converted" }) },
                    {
                        $facet: {
                            overall: [
                                {
                                    $group: {
                                        _id: null,
                                        totalAmount: { $sum: { $toDouble: "$cost" } },
                                        count: { $sum: 1 },
                                    },
                                },
                            ],
                        }
                    }
                ]),
                Enquiry.aggregate([
                    { $match: andMatch(query, weekDateFilter, { status: "Converted" }) },
                    {
                        $group: {
                            _id: "$date",
                            count: { $sum: 1 },
                            amount: { $sum: { $toDouble: "$cost" } },
                        },
                    },
                    { $sort: { _id: 1 } },
                ]),
                FollowUp.countDocuments(todayOpenFollowUpQuery),
                FollowUp.countDocuments(missedFollowUpQuery),
                FollowUp.countDocuments(upcomingFollowUpQuery),
                Enquiry.find(andMatch(query, dateFilter))
                    .select('name enqNo date status mobile product cost')
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .lean(),
                FollowUp.find(todayOpenFollowUpQuery)
                    .select('enqId name mobile image product enqNo date time dueAt followUpDate nextFollowUpDate type activityType remarks status')
                    .sort({ dueAt: 1, activityTime: -1, createdAt: -1 })
                    .limit(5)
                    .lean(),
                FollowUp.find(missedFollowUpQuery)
                    .select('enqId name mobile image product enqNo date time dueAt followUpDate nextFollowUpDate type activityType remarks status')
                    .sort({ date: -1, dueAt: -1, activityTime: -1, createdAt: -1 })
                    .limit(50)
                    .lean(),
                FollowUp.find(upcomingFollowUpQuery)
                    .select('enqId name mobile image product enqNo date time dueAt followUpDate nextFollowUpDate type activityType remarks status')
                    .sort({ date: 1, dueAt: 1, activityTime: 1, createdAt: 1 })
                    .limit(20)
                    .lean(),
                (async () => {
                    try {
                        const currentUserId = req.userId;
                        const compObjId = mongoose.Types.ObjectId.isValid(String(companyId))
                            ? new mongoose.Types.ObjectId(companyId)
                            : null;
                        if (!currentUserId || !compObjId) return 0;
                        const [myGroups, unreadDirectCount] = await Promise.all([
                            CommunicationGroup.find({
                                companyId: compObjId,
                                isActive: true,
                                members: currentUserId,
                            }).select("_id").lean(),
                            CommunicationMessage.countDocuments({
                                companyId: compObjId,
                                groupId: null,
                                receiverId: currentUserId,
                                readBy: { $ne: currentUserId }
                            })
                        ]);

                        const myGroupIds = (myGroups || []).map(g => g._id);
                        const unreadGroupCount = myGroupIds.length > 0
                            ? await CommunicationMessage.countDocuments({
                                companyId: compObjId,
                                groupId: { $in: myGroupIds },
                                readBy: { $ne: currentUserId }
                            })
                            : 0;

                        return (unreadDirectCount || 0) + (unreadGroupCount || 0);
                    } catch (err) {
                        console.error("[Dashboard] Error querying unread chat count:", err.message);
                        return 0;
                    }
                })()
            ]);

            const counts = {
                new: 0,
                contacted: 0,
                interested: 0,
                notInterested: 0,
                converted: 0,
                closed: 0,
            };
            countsResult.forEach(c => {
                const status = c._id?.toLowerCase();
                if (status === "new") counts.new = c.count;
                else if (status === "contacted" || status === "in progress") counts.contacted = c.count;
                else if (status === "interested") counts.interested = c.count;
                else if (status === "not interested" || status === "dropped" || status === "drop") counts.notInterested = c.count;
                else if (status === "converted") counts.converted = c.count;
                else if (status === "closed") counts.closed = c.count;
            }, 10000);

            const converted = counts.converted || 0;
            const conversionRate = totalEnquiry > 0 ? Math.round((converted / totalEnquiry) * 100) : 0;

            const revenueNow = Number(revenueResult[0]?.overall[0]?.totalAmount || 0);
            const revenuePrev = Number(prevRevenueResult[0]?.overall[0]?.totalAmount || 0);
            let revenueChangePct = 0;
            let revenueChangePctValid = true;
            if (revenuePrev > 0) {
                revenueChangePct = Math.round(((revenueNow - revenuePrev) / revenuePrev) * 100);
            } else if (revenueNow === 0) {
                revenueChangePct = 0;
            } else {
                revenueChangePctValid = false; // avoid infinity when prev is 0 but current > 0
            }

            return {
                range,
                rangeFrom,
                rangeTo,
                prevFrom,
                prevTo,
                weekFrom,
                weekTo,
                counts: {
                    ...counts,
                    contacted: counts.contacted || 0,
                    inProgress: counts.contacted || 0,
                    interested: counts.interested || 0,
                    dropped: counts.notInterested || 0,
                    converted,
                },
                totalEnquiry,
                todayEnquiry,
                todayFollowUps: todayFollowUpsCount,
                missedFollowUps: missedFollowUpsCount,
                upcomingFollowUps: upcomingFollowUpsCount,
                unreadTeamMessagesCount: unreadChatCount || 0,
                overallSalesAmount: revenueNow,
                monthlyRevenue: revenueNow,
                salesMonthly: revenueResult[0]?.overall[0]?.count || 0,
                prevRevenue: revenuePrev,
                revenueChangePct: revenueChangePctValid ? revenueChangePct : null,
                weekSales: (() => {
                    const byDate = sumByDateToMap(weekSalesByDate);
                    const days = [];
                    for (let i = 0; i < 7; i += 1) {
                        const d = shiftIsoDate(weekFrom, i);
                        const hit = byDate.get(d) || { count: 0, amount: 0 };
                        days.push({
                            date: d,
                            convertedCount: hit.count,
                            revenue: hit.amount,
                        });
                    }
                    return days;
                })(),
                conversionRate,
                recentEnquiries,
                todayList,
                missedList,
                upcomingList,
            };
        }, 60000); // 60s TTL

        res.json(response);
        console.log(`⚡ GET /dashboard — ${Date.now() - _start}ms ${source}`);
    } catch (err) {
        console.error("Dashboard error:", err);
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;

/**
 * GET /api/dashboard/recent-activity
 * Returns a timeline of the latest company activity across modules.
 */
router.get("/recent-activity", verifyToken, async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.json({ success: true, activity: [] });

        const limit = 10;

        // Fetch Website Leads
        const leads = await WebsiteLead.find({ companyId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        // Fetch Admin/Staff Payments
        const staffPayments = await AdminStaffPayment.find({ companyId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        // Fetch AI Payments
        const aiPayments = await AIPayment.find({ companyId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        let activityFeed = [];

        // Format leads
        leads.forEach(lead => {
            activityFeed.push({
                id: lead._id,
                type: "lead",
                title: "New Website Lead",
                description: `${lead.name} (${lead.email}) submitted a query via the website.`,
                timestamp: lead.createdAt,
                icon: "UserPlus",
                color: "bg-blue-500/10 text-blue-500"
            });
        });

        // Format Staff Payments
        staffPayments.forEach(payment => {
            activityFeed.push({
                id: payment._id,
                type: "staff_topup",
                title: `${payment.type} Slots Top-up`,
                description: `Successfully added ${payment.quantity} ${payment.type} slot(s) for ₹${payment.amountPaid}.`,
                timestamp: payment.createdAt,
                icon: "ShieldPlus",
                color: "bg-green-500/10 text-green-500"
            });
        });

        // Format AI Payments
        aiPayments.forEach(payment => {
            activityFeed.push({
                id: payment._id,
                type: "ai_topup",
                title: "AI Voice Top-up",
                description: `Purchased ${payment.requestsAdded} AI requests for ₹${payment.amountPaid}.`,
                timestamp: payment.createdAt,
                icon: "Mic",
                color: "bg-purple-500/10 text-purple-500"
            });
        });

        // Sort globally by timestamp
        activityFeed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        // Slice to max 15 items
        activityFeed = activityFeed.slice(0, 15);

        res.json({ success: true, activity: activityFeed });
    } catch (error) {
        console.error("Recent Activity Error:", error);
        res.status(500).json({ success: false, message: "Error fetching recent activity" });
    }
});
