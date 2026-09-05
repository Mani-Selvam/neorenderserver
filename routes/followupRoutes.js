const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const FollowUp = require("../models/FollowUp");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const { verifyToken } = require("../middleware/auth");
const cache = require("../utils/responseCache");
const { syncEnquiryDenormalized } = require("../services/enquiryDenormalizer");
const { getCompanyUserIds } = require("../utils/companyUsersCache");
const firebaseNotificationService = require("../services/firebaseNotificationService");
const { sendExpoNotification } = require("../BACKEND_NOTIFICATIONS");

const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { buildSafeUploadName } = require("../utils/uploadSecurity");

const uploadDir = path.join(__dirname, "../uploads/voice_notes");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(
            null,
            buildSafeUploadName({
                prefix: "voice",
                originalname: file.originalname,
                fallbackExt: ".m4a",
            }),
        );
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Handle both dev (server/routes) and prod (routes at root) folder structures
let getFollowUpAssignmentTexts, getFollowUpCreationTexts;
try {
    // Try production path first (routes at same level as src)
    const mod = require("../src/constants/notificationPhrases");
    getFollowUpAssignmentTexts = mod.getFollowUpAssignmentTexts;
    getFollowUpCreationTexts = mod.getFollowUpCreationTexts;
} catch (e1) {
    try {
        // Try local dev path (routes inside server folder)
        const mod = require("../../src/constants/notificationPhrases");
        getFollowUpAssignmentTexts = mod.getFollowUpAssignmentTexts;
        getFollowUpCreationTexts = mod.getFollowUpCreationTexts;
    } catch (e2) {
        // Fallback stubs when module is missing (graceful degradation for production)
        console.warn(
            "[WARNING] notificationPhrases module not found - using fallback stubs",
        );
        getFollowUpAssignmentTexts = ({
            adminName,
            enquiryNo,
            enquiryName,
            activityType,
        }) => ({
            title: `Follow-up: ${enquiryNo}`,
            body: `${adminName} assigned follow-up (${activityType}) for ${enquiryName || enquiryNo} to you`,
        });
        getFollowUpCreationTexts = ({
            adminName,
            staffName,
            enquiryNo,
            enquiryName,
            activityType,
        }) => ({
            title: `New Follow-up: ${enquiryNo}`,
            body: `${staffName} created a ${activityType} follow-up for ${enquiryName || enquiryNo}`,
        });
    }
}

const isExpoPushToken = (value) =>
    typeof value === "string" && value.startsWith("ExponentPushToken[");

const sendNotificationToUser = async (
    userOrToken,
    message,
    { priority = "high", channelId = "default", sound = "default" } = {},
) => {
    if (!userOrToken || !message?.title || !message?.body) return false;

    const fcmToken =
        typeof userOrToken === "string" ? userOrToken : userOrToken.fcmToken;
    const userId = typeof userOrToken === "object" ? userOrToken._id : null;

    if (fcmToken) {
        const fcmResult = await firebaseNotificationService.sendNotification(
            userId || fcmToken,
            {
                title: message.title,
                body: message.body,
                type: message?.data?.type || "general",
                data: message.data || {},
            },
            {
                priority,
                channelId,
                sound,
            },
        );
        if (fcmResult?.success) return true;
        console.warn(
            "[NotifSvc] FCM delivery failed, trying Expo fallback:",
            fcmResult?.error || "unknown error",
        );
    }

    const pushToken =
        typeof userOrToken === "string" ? userOrToken : userOrToken.pushToken;
    if (isExpoPushToken(pushToken)) {
        let resolvedUserId = userId;
        if (!resolvedUserId) {
            const userWithToken = await User.findOne({ pushToken }).select("_id").lean();
            resolvedUserId = userWithToken?._id;
        }
        const badgeCount = resolvedUserId
            ? await firebaseNotificationService.getUnreadBadgeCount(resolvedUserId)
            : undefined;

        await sendExpoNotification(pushToken, { ...message, badge: badgeCount }, priority, 3, channelId);
        return true;
    }

    return false;
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
    // Clamp to sane global timezones (-14h..+14h), using JS getTimezoneOffset semantics
    return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(n)));
};

// Converts "now" into the client's local ISO date (YYYY-MM-DD) using getTimezoneOffset minutes.
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

const parseTimeToMinutes = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;

    const match = raw.match(
        /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?(?:\s*([AaPp][Mm]))?$/,
    );
    if (!match) return null;

    let hours = Number(match[1]);
    const minutes = Number(match[2] ?? "0");
    const meridian = String(match[4] || "").toUpperCase();

    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes > 59) {
        return null;
    }

    if (meridian) {
        if (hours < 1 || hours > 12) return null;
        if (meridian === "AM") {
            if (hours === 12) hours = 0;
        } else if (meridian === "PM") {
            if (hours !== 12) hours += 12;
        }
    } else if (hours > 23) {
        return null;
    }

    return hours * 60 + minutes;
};

const normalizeFollowUpEnquiryStatus = (value) => {
    const raw = String(value || "")
        .trim()
        .toLowerCase();
    if (raw === "closed") return "Closed";
    if (raw === "not interested" || raw === "dropped" || raw === "drop")
        return "Not Interested";
    if (raw === "converted" || raw === "sales") return "Converted";
    if (raw === "interested") return "Interested";
    if (raw === "contacted" || raw === "in progress") return "Contacted";
    if (raw === "new") return "New";
    return "";
};

const parseDueAtLocal = (isoDate, timeStr) => {
    const iso = String(isoDate || "").trim();
    const time = String(timeStr || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    if (!time) return null;

    const m = time.match(
        /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?(?:\s*([AaPp][Mm]))?$/,
    );
    if (!m) return null;
    let hh = Number(m[1]);
    const mm = Number(m[2] ?? "0");
    const meridian = String(m[4] || "").toUpperCase();
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

    const [yy, mo, dd] = iso.split("-").map((n) => Number(n));
    const dt = new Date(yy, (mo || 1) - 1, dd || 1, hh, mm, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
};

const parseDueAtWithOffset = (isoDate, timeStr, tzOffsetMinutes) => {
    const off = clampTzOffsetMinutes(tzOffsetMinutes);
    if (off == null) return parseDueAtLocal(isoDate, timeStr);

    const iso = String(isoDate || "").trim();
    const time = String(timeStr || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    if (!time) return null;

    const m = time.match(
        /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?(?:\s*([AaPp][Mm]))?$/,
    );
    if (!m) return null;
    let hh = Number(m[1]);
    const mm = Number(m[2] ?? "0");
    const meridian = String(m[4] || "").toUpperCase();
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

    const [yy, mo, dd] = iso.split("-").map((n) => Number(n));
    const utcMs =
        Date.UTC(yy, (mo || 1) - 1, dd || 1, hh, mm, 0, 0) + off * 60 * 1000;
    const dt = new Date(utcMs);
    return Number.isNaN(dt.getTime()) ? null : dt;
};

const isMissedForReference = (
    item,
    referenceDate,
    { realToday = null, nowMinutes = null } = {},
) => {
    const itemDate = String(
        item?.date || item?.nextFollowUpDate || item?.followUpDate || "",
    ).trim();
    if (!itemDate) return false;
    if (itemDate < referenceDate) return true;
    if (itemDate > referenceDate) return false;

    const todayIso = realToday || toLocalIsoDate(new Date());
    if (referenceDate !== todayIso) return false;

    const dueAt = item?.dueAt ? new Date(item.dueAt) : null;
    if (dueAt && !Number.isNaN(dueAt.getTime())) {
        return dueAt.getTime() <= Date.now();
    }

    const dueMinutes = parseTimeToMinutes(item?.time);
    if (dueMinutes == null) return false;

    const fallbackNow = new Date();
    const minutesNow =
        Number.isFinite(Number(nowMinutes)) && nowMinutes != null
            ? Number(nowMinutes)
            : fallbackNow.getHours() * 60 + fallbackNow.getMinutes();
    return dueMinutes <= minutesNow;
};

const getFollowUpAccessScope = async (req) => {
    const role = String(req.user?.role || "")
        .trim()
        .toLowerCase();
    const userId = req.userId;
    const companyId = req.user?.company_id;

    if (role === "staff") {
        const scopeClause = { assignedTo: userId };
        const createdByClause = { createdBy: userId };
        const scopingFilter = { $or: [scopeClause, createdByClause] };
        if (companyId && mongoose.Types.ObjectId.isValid(String(companyId))) {
            scopingFilter.companyId = new mongoose.Types.ObjectId(companyId);
        }
        return {
            ownerUserIds: [],
            scopingFilter,
        };
    }

    if (companyId) {
        const scopingFilter = {};
        if (mongoose.Types.ObjectId.isValid(String(companyId))) {
            scopingFilter.companyId = new mongoose.Types.ObjectId(companyId);
        }
        return {
            ownerUserIds: [],
            scopingFilter,
        };
    }

    return {
        ownerUserIds: [userId],
        scopingFilter: {},
    };
};

const buildFollowUpScopedFilter = (scope) => {
    const ownerUserIds = Array.isArray(scope?.ownerUserIds)
        ? scope.ownerUserIds.filter((id) =>
            mongoose.Types.ObjectId.isValid(String(id)),
        )
        : [];

    if (ownerUserIds.length === 0) {
        return {
            ...(scope?.scopingFilter || {}),
        };
    }

    const userId =
        ownerUserIds.length <= 1
            ? ownerUserIds[0] || null
            : { $in: ownerUserIds };

    return {
        userId,
        ...(scope?.scopingFilter || {}),
    };
};

const SALES_REGEX = /^(sales|converted)$/i;
const DROP_REGEX = /^(drop|dropped|closed|not interested)$/i;
const COMPLETED_REGEX = /^completed$/i;
const CURRENT_FOLLOWUP_CLAUSE = { isCurrent: true };

// In production, multiple screens hit /followups repeatedly (counts + lists).
// Auto-marking missed followups via updateMany on every request can become very slow.
// Throttle this work to run at most once per scope window.
const AUTO_MISSED_SYNC_TTL_MS = Number(
    process.env.AUTO_MISSED_SYNC_TTL_MS || 20000,
);
const lastAutoMissSyncAt = new Map();
const shouldRunAutoMissSync = (key) => {
    const now = Date.now();
    const last = lastAutoMissSyncAt.get(key) || 0;
    if (now - last < AUTO_MISSED_SYNC_TTL_MS) return false;
    lastAutoMissSyncAt.set(key, now);
    return true;
};

const emitFollowUpChanged = async (req, payload = {}) => {
    try {
        const io = req.app?.get("io");
        if (!io) return;

        const companyId = req.user?.company_id || null;
        if (companyId) {
            // ⚡ Use cached company users instead of a fresh DB query
            const userIds = await getCompanyUserIds(companyId);

            userIds.forEach((uid) => {
                const userId = String(uid || "");
                if (!userId) return;
                io.to(`user:${userId}`).emit("FOLLOWUP_CHANGED", {
                    ...payload,
                    companyId: String(companyId),
                });
            });
            return;
        }

        const fallbackUserId = String(req.userId || "");
        if (fallbackUserId) {
            io.to(`user:${fallbackUserId}`).emit("FOLLOWUP_CHANGED", payload);
        }
    } catch (_socketError) {
        // ignore issues
    }
};

/**
 * DASHBOARD ENDPOINT
 */
router.get("/dashboard", verifyToken, async (req, res) => {
    const _start = Date.now();
    try {
        const companyId = req.user?.company_id;
        const userId = req.userId;
        const { tab = "All", pageSize = 20 } = req.query;

        const scope = await getFollowUpAccessScope(req);
        const baseFilter = buildFollowUpScopedFilter(scope);
        if (companyId)
            baseFilter.companyId = new mongoose.Types.ObjectId(companyId);

        const user = await User.findById(userId)
            .select("tzOffsetMinutes")
            .lean();
        const tzOffsetMinutes = user?.tzOffsetMinutes || null;
        const clientIsoDate = toClientIsoDate(tzOffsetMinutes);
        const now = new Date();
        const nowMinutes = getClientNowMinutes(tzOffsetMinutes);

        // ⚡ Proactive auto-marker — runs in background, never blocks the response
        const autoSyncKey = `fuDash:${String(companyId || "")}:${String(userId || "")}:${clientIsoDate}`;
        if (shouldRunAutoMissSync(autoSyncKey)) {
            // Capture values needed inside the async closure (closures over let/const are fine)
            const _baseFilter = { ...baseFilter };
            const _clientIsoDate = clientIsoDate;
            const _now = now;
            const _nowMinutes = nowMinutes;
            setImmediate(async () => {
                try {
                    await FollowUp.updateMany(
                        {
                            ..._baseFilter,
                            ...CURRENT_FOLLOWUP_CLAUSE,
                            status: {
                                $nin: [
                                    "Completed",
                                    "Dropped",
                                    "Converted",
                                    "Missed",
                                ],
                            },
                            $or: [
                                { date: { $lt: _clientIsoDate } },
                                { date: _clientIsoDate, dueAt: { $lt: _now } },
                            ],
                        },
                        { $set: { status: "Missed" } },
                    );

                    await FollowUp.updateMany(
                        {
                            ..._baseFilter,
                            ...CURRENT_FOLLOWUP_CLAUSE,
                            status: "Missed",
                            $or: [
                                { date: { $gt: _clientIsoDate } },
                                { date: _clientIsoDate, dueAt: { $gt: _now } },
                            ],
                        },
                        { $set: { status: "Scheduled" } },
                    );

                    const legacyRows = await FollowUp.find({
                        ..._baseFilter,
                        ...CURRENT_FOLLOWUP_CLAUSE,
                        status: "Missed",
                        date: _clientIsoDate,
                        time: { $exists: true, $ne: null, $ne: "" },
                        $or: [{ dueAt: null }, { dueAt: { $exists: false } }],
                    })
                        .select("_id time")
                        .limit(500)
                        .lean();
                    const legacyUnmissIds = legacyRows
                        .filter((row) => {
                            const mins = parseTimeToMinutes(row?.time);
                            return mins != null && mins > _nowMinutes;
                        })
                        .map((row) => row._id);
                    if (legacyUnmissIds.length > 0) {
                        await FollowUp.updateMany(
                            { _id: { $in: legacyUnmissIds } },
                            { $set: { status: "Scheduled" } },
                        );
                    }
                } catch (_autoErr) {
                    console.error(
                        "[Dashboard] Auto-mark Missed failed:",
                        _autoErr.message,
                    );
                }
            });
        }

        const [
            allCount,
            todayCount,
            missedCount,
            salesCount,
            droppedCount,
            tabData,
            missedData,
        ] = await Promise.all([
            FollowUp.countDocuments({
                ...baseFilter,
                ...CURRENT_FOLLOWUP_CLAUSE,
            }),
            FollowUp.countDocuments({
                ...baseFilter,
                ...CURRENT_FOLLOWUP_CLAUSE,
                date: clientIsoDate,
                status: { $ne: "Missed" },
            }),
            FollowUp.countDocuments({
                ...baseFilter,
                ...CURRENT_FOLLOWUP_CLAUSE,
                status: "Missed",
            }),
            Enquiry.countDocuments({
                ...(baseFilter?.companyId
                    ? { companyId: baseFilter.companyId }
                    : {}),
                ...(baseFilter?.assignedTo
                    ? { assignedTo: baseFilter.assignedTo }
                    : {}),
                status: "Converted",
            }),
            FollowUp.countDocuments({
                ...baseFilter,
                ...CURRENT_FOLLOWUP_CLAUSE,
                status: { $in: ["Drop", "Dropped"] },
            }),
            FollowUp.find({ ...baseFilter, ...CURRENT_FOLLOWUP_CLAUSE })
                .select(
                    "enqId enqNo name mobile image product date time dueAt followUpDate nextFollowUpDate type activityType remarks note status nextAction assignedTo createdAt activityTime voiceNote",
                )
                .limit(parseInt(pageSize))
                .sort({ date: -1, createdAt: -1 })
                .lean(),
            FollowUp.find({
                ...baseFilter,
                ...CURRENT_FOLLOWUP_CLAUSE,
                status: "Missed",
            })
                .select(
                    "enqId enqNo name mobile image product date time dueAt followUpDate nextFollowUpDate type activityType remarks note status nextAction assignedTo staffName createdAt activityTime voiceNote",
                )
                .limit(50)
                .sort({ date: -1 })
                .lean(),
        ]);

        res.json({
            data: {
                counts: {
                    All: allCount,
                    Today: todayCount,
                    Missed: missedCount,
                    Sales: salesCount,
                    Dropped: droppedCount,
                },
                currentTab: {
                    tab,
                    items: tabData,
                    hasMore: tabData.length >= pageSize,
                },
                missedItems: missedData,
            },
            elapsed: Date.now() - _start,
        });
    } catch (error) {
        console.error("[Dashboard] Error:", error.message);
        res.status(500).json({ error: "Dashboard fetch failed" });
    }
});

// GET Follow-ups
router.get("/", verifyToken, async (req, res) => {
    const _start = Date.now();
    try {
        const {
            tab,
            status,
            assignedTo,
            activityType,
            date,
            dateFrom,
            dateTo,
            tzOffsetMinutes,
            page = 1,
            limit = 20,
        } = req.query;

        // ⚡ Short-lived cache (20s) — invalidated on create/update/delete
        const fuCacheKey = cache.key("followups", {
            uid: String(req.userId || ""),
            cid: String(req.user?.company_id || ""),
            role: String(req.user?.role || ""),
            tab: String(tab || ""),
            status: String(status || ""),
            assignedTo: String(assignedTo || ""),
            activityType: String(activityType || ""),
            date: String(date || ""),
            dateFrom: String(dateFrom || ""),
            dateTo: String(dateTo || ""),
            tz: String(tzOffsetMinutes || ""),
            page: String(page),
            limit: String(limit),
        });
        const fuCacheTtlMs = 20000;

        const referenceDate = date || toClientIsoDate(tzOffsetMinutes);
        const realToday = toClientIsoDate(tzOffsetMinutes);
        const isRealToday = referenceDate === realToday;
        const now = new Date();
        const nowMinutes = getClientNowMinutes(tzOffsetMinutes);

        const scope = await getFollowUpAccessScope(req);
        let query = buildFollowUpScopedFilter(scope);

        // ⚡ Proactive auto-marker — runs in background, never blocks the response
        const listAutoSyncKey = `fuList:${String(req.user?.company_id || "")}:${String(req.userId || "")}:${realToday}`;
        if (isRealToday && shouldRunAutoMissSync(listAutoSyncKey)) {
            const _query = { ...query };
            const _realToday = realToday;
            const _now = now;
            const _nowMinutes = nowMinutes;
            setImmediate(async () => {
                try {
                    await FollowUp.updateMany(
                        {
                            ..._query,
                            ...CURRENT_FOLLOWUP_CLAUSE,
                            status: {
                                $nin: [
                                    "Completed",
                                    "Dropped",
                                    "Converted",
                                    "Missed",
                                ],
                            },
                            $or: [
                                { date: { $lt: _realToday } },
                                { date: _realToday, dueAt: { $lt: _now } },
                            ],
                        },
                        { $set: { status: "Missed" } },
                    );

                    await FollowUp.updateMany(
                        {
                            ..._query,
                            ...CURRENT_FOLLOWUP_CLAUSE,
                            status: "Missed",
                            $or: [
                                { date: { $gt: _realToday } },
                                { date: _realToday, dueAt: { $gt: _now } },
                            ],
                        },
                        { $set: { status: "Scheduled" } },
                    );

                    const legacyRows = await FollowUp.find({
                        ..._query,
                        ...CURRENT_FOLLOWUP_CLAUSE,
                        status: "Missed",
                        date: _realToday,
                        time: { $exists: true, $ne: null, $ne: "" },
                        $or: [{ dueAt: null }, { dueAt: { $exists: false } }],
                    })
                        .select("_id time")
                        .limit(500)
                        .lean();
                    const legacyUnmissIds = legacyRows
                        .filter((row) => {
                            const mins = parseTimeToMinutes(row?.time);
                            return mins != null && mins > _nowMinutes;
                        })
                        .map((row) => row._id);
                    if (legacyUnmissIds.length > 0) {
                        await FollowUp.updateMany(
                            { _id: { $in: legacyUnmissIds } },
                            { $set: { status: "Scheduled" } },
                        );
                    }
                } catch (_autoErr) {
                    console.error(
                        "[FollowUp List] Auto-mark Missed failed:",
                        _autoErr.message,
                    );
                }
            });
        }

        if (assignedTo && assignedTo !== "all") query.assignedTo = assignedTo;
        if (activityType && activityType !== "all")
            query.$or = [{ activityType }, { type: activityType }];
        if (status && status !== "all") query.status = status;

        if (date) {
            query.date = date;
        } else if (dateFrom || dateTo) {
            query.date = {};
            if (dateFrom) query.date.$gte = dateFrom;
            if (dateTo) query.date.$lte = dateTo;
        }

        // Exclude system-generated rows (avoid regex filters here; they force collection scans in production).
        query.$nor = [{ activityType: "System" }, { type: "System" }];

        // Status logic
        if (tab === "Today") {
            query.date = referenceDate;
            query.status = {
                $nin: ["Missed", "Completed", "Dropped", "Drop", "Converted"],
            };
            Object.assign(query, CURRENT_FOLLOWUP_CLAUSE);
        } else if (tab === "Upcoming") {
            query.date = { $gt: referenceDate };
            Object.assign(query, CURRENT_FOLLOWUP_CLAUSE);
        } else if (tab === "Missed") {
            query.status = "Missed";
            Object.assign(query, CURRENT_FOLLOWUP_CLAUSE);
        } else if (tab === "Sales") {
            query.status = "Converted";
            Object.assign(query, CURRENT_FOLLOWUP_CLAUSE);
        } else if (tab === "Dropped") {
            query.status = { $in: ["Drop", "Dropped"] };
            Object.assign(query, CURRENT_FOLLOWUP_CLAUSE);
        } else if (tab === "All") {
            Object.assign(query, CURRENT_FOLLOWUP_CLAUSE);
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;
        const sort =
            tab === "Today"
                ? { dueAt: 1, activityTime: -1, createdAt: -1 }
                : tab === "Upcoming"
                    ? { date: 1, dueAt: 1, activityTime: -1, createdAt: -1 }
                    : { date: -1, dueAt: -1, activityTime: -1, createdAt: -1 };

        const { data: fuResponse } = await cache.wrap(
            fuCacheKey,
            async () => {
                const followUps = await FollowUp.find(query)
                    .select(
                        "enqId enqNo name mobile image product date time dueAt followUpDate nextFollowUpDate type activityType remarks note status nextAction assignedTo staffName createdAt activityTime voiceNote",
                    )
                    .populate("assignedTo", "name")
                    .sort(sort)
                    .skip(skip)
                    .limit(limitNum + 1)
                    .lean();

                const hasMore = followUps.length > limitNum;
                if (hasMore) followUps.pop();

                return {
                    data: followUps,
                    pagination: {
                        total: hasMore
                            ? pageNum * limitNum + 1
                            : skip + followUps.length,
                        page: pageNum,
                        limit: limitNum,
                        pages: hasMore ? pageNum + 1 : pageNum,
                    },
                };
            },
            fuCacheTtlMs,
        );

        res.json(fuResponse);
    } catch (err) {
        console.error("Get follow-ups error:", err);
        res.status(500).json({ message: err.message });
    }
});

// CREATE Follow-up
router.post("/", verifyToken, upload.single("voiceNote"), async (req, res) => {
    try {
        const ownerId =
            req.user.role === "Staff" && req.user.parentUserId
                ? req.user.parentUserId
                : req.userId;
        const companyId = req.user?.company_id || null;
        const today = toLocalIsoDate(new Date());

        const toObjectId = (value) => {
            if (!value) return undefined;
            const str = String(
                typeof value === "object" ? value._id || value.id : value,
            ).trim();
            return mongoose.Types.ObjectId.isValid(str) ? str : undefined;
        };

        const assignedToId = toObjectId(req.body.assignedTo) || req.userId;
        const enquiryId = toObjectId(req.body.enqId);
        const enqNo = String(req.body.enqNo || "").trim();
        const safeRemarks = String(
            req.body.remarks || req.body.note || "",
        ).trim();

        // staffName = the person who CREATED this follow-up (shown in the notification
        // as the actorName prefix: "AdminName • You might have missed this").
        // It is always the logged-in creator, regardless of who it is assigned to.
        // (assignedTo's name is used for routing the notification, not for display.)
        const staffName = String(req.user?.name || "Staff").trim();

        if (!enqNo || !safeRemarks)
            return res
                .status(400)
                .json({ message: "enqNo and remarks are required" });

        const effDate = String(
            req.body.nextFollowUpDate ||
            req.body.date ||
            req.body.followUpDate ||
            today,
        ).trim();
        const effTime = String(req.body.time || "").trim();
        const dueAt =
            effDate && effTime
                ? parseDueAtWithOffset(
                    effDate,
                    effTime,
                    req.body?.tzOffsetMinutes,
                )
                : null;

        const actType = req.body.activityType || req.body.type || "WhatsApp";
        const isNote = actType === "Note";

        const newFollowUp = new FollowUp({
            ...req.body,
            companyId,
            enqId: enquiryId,
            enqNo,
            userId: ownerId,
            createdBy: req.userId,
            assignedTo: assignedToId,
            staffName, // = creator's name (always req.user.name)
            activityType: actType,
            note: safeRemarks,
            remarks: safeRemarks,
            date: effDate,
            dueAt,
            voiceNote: req.file ? `/uploads/voice_notes/${req.file.filename}` : undefined,
            isCurrent: !isNote,
        });

        const saved = await newFollowUp.save();

        if (!isNote) {
            // Supersede older ones
            await FollowUp.updateMany(
                {
                    companyId,
                    enqNo,
                    _id: { $ne: saved._id },
                    isCurrent: { $ne: false },
                },
                { $set: { isCurrent: false, supersededAt: new Date() } },
            );
        }

        if (saved.enqId) {
            const payloadEnquiryStatus = normalizeFollowUpEnquiryStatus(
                req.body.enquiryStatus || req.body.status,
            );
            const nextAction = String(saved.nextAction || "").toLowerCase();
            let enquiryStatus = payloadEnquiryStatus;

            if (!enquiryStatus) {
                if (nextAction === "sales") enquiryStatus = "Converted";
                else if (nextAction === "drop")
                    enquiryStatus = "Not Interested";
            }

            const updatePayload = {
                lastContactedAt: new Date(),
                lastFollowUpDate: saved.date,
                lastFollowUpStatus: saved.status || "Scheduled",
                nextFollowUpDate: saved.nextFollowUpDate || saved.date,
                lastActivityAt: new Date(),
            };
            if (enquiryStatus) updatePayload.status = enquiryStatus;

            await Enquiry.findByIdAndUpdate(saved.enqId, {
                $set: updatePayload,
            });
            await syncEnquiryDenormalized(saved.enqId);
        }

        cache.invalidate("followups");
        cache.invalidate("enquiries");
        cache.invalidate("dashboard");

        // --- NEW: Send notifications for new follow-up creation ---
        try {
            await sendFollowUpCreationNotifications(req, saved);
        } catch (notifErr) {
            console.error(
                "❌ Follow-up creation notification failed:",
                notifErr.message,
            );
        }

        // ⚡ Fire-and-forget: respond immediately, emit to sockets in background
        emitFollowUpChanged(req, {
            type: "CREATE",
            _id: saved._id,
            enqNo: saved.enqNo,
        }).catch(() => { });
        res.status(201).json(saved);
    } catch (err) {
        console.error("Create follow-up error:", err.message);
        res.status(400).json({ message: err.message });
    }
});

// CREATE Call record only (does not replace the current scheduled follow-up)
router.post("/call-record", verifyToken, async (req, res) => {
    try {
        const ownerId =
            req.user.role === "Staff" && req.user.parentUserId
                ? req.user.parentUserId
                : req.userId;
        const companyId = req.user?.company_id || null;
        const today = toClientIsoDate(req.body?.tzOffsetMinutes);

        const toObjectId = (value) => {
            if (!value) return undefined;
            const str = String(
                typeof value === "object" ? value._id || value.id : value,
            ).trim();
            return mongoose.Types.ObjectId.isValid(str) ? str : undefined;
        };

        const enquiryId = toObjectId(req.body.enqId);
        const assignedToId = toObjectId(req.body.assignedTo) || req.userId;
        const enqNo = String(req.body.enqNo || "").trim();
        const safeRemarks = String(
            req.body.remarks || req.body.note || "Outgoing phone call",
        ).trim();

        if (!enqNo || !safeRemarks) {
            return res
                .status(400)
                .json({ message: "enqNo and remarks are required" });
        }

        const callTimeValue = req.body.activityTime
            ? new Date(req.body.activityTime)
            : new Date();
        const activityTime = Number.isNaN(callTimeValue.getTime())
            ? new Date()
            : callTimeValue;
        const time = `${String(activityTime.getHours()).padStart(2, "0")}:${String(
            activityTime.getMinutes(),
        ).padStart(2, "0")}`;

        const callRecord = new FollowUp({
            companyId,
            enqId: enquiryId,
            enqNo,
            userId: ownerId,
            createdBy: req.userId,
            assignedTo: assignedToId,
            staffName: String(req.user?.name || "Staff").trim(),
            name: req.body.name,
            mobile: req.body.mobile,
            image: req.body.image,
            product: req.body.product,
            activityType: "Phone Call",
            type: "Phone Call",
            enquiryStatus: req.body.enquiryStatus || "Contacted",
            note: safeRemarks,
            remarks: safeRemarks,
            date: today,
            time,
            followUpDate: today,
            nextFollowUpDate: today,
            activityTime,
            nextAction: "Followup",
            status: "Completed",
            isCurrent: false,
        });

        const saved = await callRecord.save();

        if (saved.enqId) {
            await Enquiry.findByIdAndUpdate(saved.enqId, {
                $set: {
                    lastContactedAt: activityTime,
                    lastActivityAt: activityTime,
                },
            });
            await syncEnquiryDenormalized(saved.enqId);
        }

        cache.invalidate("followups");
        cache.invalidate("enquiries");
        cache.invalidate("dashboard");

        emitFollowUpChanged(req, {
            type: "CALL_RECORD",
            _id: saved._id,
            enqNo: saved.enqNo,
        }).catch(() => { });

        res.status(201).json(saved);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// UPDATE Follow-up
router.put("/:id", verifyToken, upload.single("voiceNote"), async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ message: "Invalid ID" });

        const scope = await getFollowUpAccessScope(req);
        const filter = {
            _id: req.params.id,
            ...buildFollowUpScopedFilter(scope),
        };

        const followUp = await FollowUp.findOne(filter);
        if (!followUp) return res.status(404).json({ message: "Not found" });

        const oldAssignedTo = followUp.assignedTo?.toString();

        const updateData = { ...req.body };
        delete updateData.userId;
        delete updateData.createdBy;
        delete updateData.companyId;
        delete updateData.enqId;

        const tzOffsetMinutes = updateData?.tzOffsetMinutes ?? null;
        delete updateData.tzOffsetMinutes;

        if (req.file) {
            updateData.voiceNote = `/uploads/voice_notes/${req.file.filename}`;
        }

        const toObjectId = (value) => {
            if (!value) return undefined;
            const str = String(
                typeof value === "object" ? value._id || value.id : value,
            ).trim();
            return mongoose.Types.ObjectId.isValid(str) ? str : undefined;
        };

        if (Object.prototype.hasOwnProperty.call(updateData, "assignedTo")) {
            updateData.assignedTo =
                toObjectId(updateData.assignedTo) || followUp.assignedTo;
            if (
                updateData.assignedTo &&
                String(updateData.assignedTo) !== String(followUp.assignedTo)
            ) {
                const assignedUser = await User.findById(updateData.assignedTo)
                    .select("name")
                    .lean();
                if (assignedUser?.name) {
                    updateData.staffName =
                        String(assignedUser.name || "").trim() ||
                        followUp.staffName;
                }
            }
        }

        const mergedDate = String(
            updateData.nextFollowUpDate ||
            updateData.date ||
            updateData.followUpDate ||
            followUp.nextFollowUpDate ||
            followUp.date ||
            followUp.followUpDate ||
            toLocalIsoDate(new Date()),
        ).trim();
        const mergedTime = String(
            Object.prototype.hasOwnProperty.call(updateData, "time")
                ? updateData.time
                : followUp.time || "",
        ).trim();

        const safeRemarks = String(
            updateData.remarks || updateData.note || "",
        ).trim();
        if (safeRemarks) {
            updateData.remarks = safeRemarks;
            updateData.note = safeRemarks;
        }

        Object.entries(updateData).forEach(([key, value]) => {
            followUp.set(key, value);
        });

        // Keep primary schedule date stable for queries and sorts
        const scheduleTouched =
            Object.prototype.hasOwnProperty.call(
                updateData,
                "nextFollowUpDate",
            ) ||
            Object.prototype.hasOwnProperty.call(updateData, "followUpDate") ||
            Object.prototype.hasOwnProperty.call(updateData, "date") ||
            Object.prototype.hasOwnProperty.call(updateData, "time");

        if (scheduleTouched) {
            if (mergedDate) followUp.set("date", mergedDate);
            const dueAt =
                mergedDate && mergedTime
                    ? parseDueAtWithOffset(
                        mergedDate,
                        mergedTime,
                        tzOffsetMinutes,
                    )
                    : null;
            followUp.set("dueAt", dueAt);
        }

        // If user reschedules a Missed follow-up into the future, move it back to Scheduled.
        // This keeps "Missed Activity" lists accurate even if the client sends status=Missed.
        const status = String(followUp.status || "")
            .trim()
            .toLowerCase();
        if (scheduleTouched && status === "missed") {
            const dueAt =
                followUp.dueAt instanceof Date
                    ? followUp.dueAt
                    : followUp.dueAt
                        ? new Date(followUp.dueAt)
                        : null;
            const todayIso = toClientIsoDate(tzOffsetMinutes);
            const dateIso = String(followUp.date || "").trim();
            const rescheduled =
                (dateIso && dateIso > todayIso) ||
                (dateIso &&
                    dateIso === todayIso &&
                    dueAt &&
                    !Number.isNaN(dueAt.getTime()) &&
                    dueAt.getTime() > Date.now());
            if (rescheduled) followUp.set("status", "Scheduled");
        }

        const saved = await followUp.save();

        if (saved.enqId) await syncEnquiryDenormalized(saved.enqId);

        // --- NEW: Send notifications for follow-up assignment changes ---
        try {
            const newAssignedTo = saved.assignedTo?.toString();
            if (
                Object.prototype.hasOwnProperty.call(
                    updateData,
                    "assignedTo",
                ) &&
                oldAssignedTo !== newAssignedTo &&
                newAssignedTo
            ) {
                // Follow-up was assigned to a staff member
                await sendFollowUpAssignmentNotifications(
                    req,
                    saved,
                    newAssignedTo,
                );
            }
        } catch (notifErr) {
            console.error(
                "❌ Follow-up assignment notification failed:",
                notifErr.message,
            );
        }

        cache.invalidate("followups");
        cache.invalidate("dashboard");
        cache.invalidate("enquiries");
        // ⚡ Fire-and-forget: respond immediately, emit in background
        emitFollowUpChanged(req, { action: "update", _id: saved._id }).catch(
            () => { },
        );
        res.json(saved);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// DELETE Follow-up
router.delete("/:id", verifyToken, async (req, res) => {
    try {
        const scope = await getFollowUpAccessScope(req);
        const filter = {
            _id: req.params.id,
            ...buildFollowUpScopedFilter(scope),
        };
        const followUp = await FollowUp.findOneAndDelete(filter);
        if (!followUp) return res.status(404).json({ message: "Not found" });

        cache.invalidate("followups");
        cache.invalidate("dashboard");
        cache.invalidate("enquiries");
        // ⚡ Fire-and-forget: respond immediately, emit in background
        emitFollowUpChanged(req, { action: "delete", _id: followUp._id }).catch(
            () => { },
        );
        res.json({ message: "Deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// History
router.get("/history/:enqNoOrId", verifyToken, async (req, res) => {
    try {
        const scope = await getFollowUpAccessScope(req);
        const filter = buildFollowUpScopedFilter(scope);
        const target = req.params.enqNoOrId;

        const query = mongoose.Types.ObjectId.isValid(target)
            ? { $or: [{ enqId: target }, { enqNo: target }], ...filter }
            : { enqNo: target, ...filter };

        const history = await FollowUp.find(query)
            .find({
                activityType: { $ne: "System" },
                note: { $not: /^Call:/i },
            })
            .select(
                "staffName assignedTo enqId enqNo name mobile image product date time dueAt followUpDate nextFollowUpDate type activityType remarks note status nextAction createdAt activityTime voiceNote",
            )
            .populate("assignedTo", "name")
            .sort({ activityTime: 1, createdAt: 1 })
            .lean();

        res.json(history);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

async function sendFollowUpAssignmentNotifications(
    req,
    followUp,
    assignedToUserId,
) {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return;

        // Get admin user (the one making the assignment)
        const adminUser = await User.findById(req.user.id)
            .select("name")
            .lean();
        if (!adminUser) return;

        // Get assigned staff user
        const staffUser = await User.findById(assignedToUserId)
            .select("name pushToken fcmToken")
            .lean();
        if (!staffUser) return;

        // Get admin's push token (or FCM token)
        const adminPushToken = await User.findOne({
            company_id: companyId,
            role: { $in: ["admin", "Admin"] },
            $or: [
                { fcmToken: { $exists: true, $ne: null } },
                { pushToken: { $exists: true, $ne: null } },
            ],
        })
            .select("pushToken fcmToken")
            .lean();

        // Send notification to staff
        if (staffUser.pushToken || staffUser.fcmToken) {
            const staffTexts = getFollowUpAssignmentTexts({
                lang: "en",
                adminName: adminUser.name,
                enquiryNo: followUp.enqNo,
                enquiryName: followUp.name,
                activityType: followUp.activityType,
            });

            await sendNotificationToUser(
                staffUser,
                {
                    title: staffTexts.title,
                    body: staffTexts.body,
                    data: {
                        type: "followup-assigned",
                        followUpId: followUp._id.toString(),
                        enqNo: followUp.enqNo,
                        assignedBy: adminUser.name,
                    },
                },
                { priority: "high", channelId: "followups" },
            );
        }

        // Send notification to admin
        if (adminPushToken?.pushToken || adminPushToken?.fcmToken) {
            const adminTexts = getFollowUpAssignmentTexts({
                lang: "en",
                adminName: adminUser.name,
                enquiryNo: followUp.enqNo,
                enquiryName: followUp.name,
                activityType: followUp.activityType,
            });

            await sendNotificationToUser(
                adminPushToken,
                {
                    title: adminTexts.title,
                    body: adminTexts.body,
                    data: {
                        type: "followup-assigned-admin",
                        followUpId: followUp._id.toString(),
                        enqNo: followUp.enqNo,
                        assignedTo: staffUser.name,
                    },
                },
                { priority: "high", channelId: "followups" },
            );
        }
    } catch (error) {
        console.error(
            "Error sending follow-up assignment notifications:",
            error,
        );
    }
}

// ─── Inline Expo Notification Sender ──────────────────────────────────────
async function sendExpoNotificationDirect(
    pushToken,
    message,
    priority = "high",
    maxRetries = 3,
) {
    if (!pushToken || !String(pushToken).startsWith("ExponentPushToken[")) {
        console.warn("[NotifSvc] Invalid push token:", pushToken);
        return false;
    }

    const expoApiUrl = "https://exp.host/--/api/v2/push/send";
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            console.log(
                `[ExpoPush] Attempt ${attempt + 1}/${maxRetries + 1} to send notification`,
            );

            const requestBody = {
                to: pushToken,
                sound: "default",
                priority: priority || "high",
                ttl: 86400, // 24 hours TTL
                expiration: Math.floor(Date.now() / 1000) + 86400, // Expire in 24 hours
                ...message,
            };

            console.log("[ExpoPush] ✓ Sending to Expo API:");
            console.log("   - to:", pushToken.substring(0, 30) + "...");
            console.log("   - title:", message.title);
            console.log("   - body:", message.body);

            const response = await fetch(expoApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.warn(
                    `[ExpoPush] Attempt ${attempt + 1} failed:`,
                    response.status,
                    errorData,
                );
                lastError = new Error(
                    `HTTP ${response.status}: ${JSON.stringify(errorData)}`,
                );
                continue;
            }

            const result = await response.json();
            if (result?.errors && result.errors.length > 0) {
                lastError = new Error(
                    result.errors[0].message || "Unknown error",
                );
                console.warn(
                    `[ExpoPush] Attempt ${attempt + 1} API error:`,
                    lastError.message,
                );
                continue;
            }

            if (result?.data && result.data.length > 0) {
                const ticket = result.data[0];
                console.log(
                    `[ExpoPush] ✓ Sent successfully. Ticket: ${ticket.id} Status: ${ticket.status}`,
                );
                return true;
            }

            console.log(
                `[ExpoPush] ✓ Sent to ${pushToken.substring(0, 20)}...`,
            );
            return true;
        } catch (error) {
            lastError = error;
            console.warn(
                `[ExpoPush] Attempt ${attempt + 1} network error:`,
                error.message,
            );
            if (attempt < maxRetries) {
                const delay = 1000 * (attempt + 1); // 1s, 2s, 3s delays
                console.log(`[ExpoPush] Waiting ${delay}ms before retry...`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    console.error(
        `[ExpoPush] Failed after ${maxRetries + 1} attempts:`,
        lastError?.message,
    );
    return false;
}

// ─── Follow-up Creation Notification ──────────────────────────────────────
async function sendFollowUpCreationNotifications(req, followUp) {
    try {
        const companyId = req.user?.company_id;
        console.log("[FollowUpNotif] Company ID:", companyId);
        if (!companyId) {
            console.log("[FollowUpNotif] No company ID - skipping");
            return;
        }

        const creatorRole = String(req.user?.role || "").toLowerCase();
        const isStaff = creatorRole === "staff";
        console.log(
            "[FollowUpNotif] Creator role:",
            creatorRole,
            "- isStaff:",
            isStaff,
        );

        if (!isStaff) {
            console.log("[FollowUpNotif] Not staff - skipping");
            return;
        }

        // Get staff user details
        const staffUser = await User.findById(req.userId)
            .select("name email")
            .lean();
        let staffName = String(
            staffUser?.name || staffUser?.email || "",
        ).trim();

        if (!staffName || staffName === "undefined" || staffName === "null") {
            staffName = "Staff";
        }

        console.log("[FollowUpNotif] Staff ID:", req.userId);
        console.log("[FollowUpNotif] Staff User Data:", {
            name: staffUser?.name,
            email: staffUser?.email,
        });
        console.log(
            "[FollowUpNotif] Final Staff name:",
            staffName,
            "Type:",
            typeof staffName,
        );

        // Get all users in company
        const allUsersInCompany = await User.find({
            company_id: companyId,
        })
            .select("name role pushToken fcmToken")
            .lean();

        console.log(
            "[FollowUpNotif] Company users:",
            allUsersInCompany.map((u) => ({
                name: u.name,
                role: u.role,
                token: u.fcmToken || u.pushToken ? "YES" : "NO",
            })),
        );

        // Get admin users with push tokens
        const adminsWithTokens = allUsersInCompany.filter(
            (u) =>
                ["admin", "Admin"].includes(u.role) &&
                (u.fcmToken || u.pushToken),
        );

        console.log(
            "[FollowUpNotif] Admins with tokens:",
            adminsWithTokens.length,
        );

        if (adminsWithTokens.length === 0) {
            console.log(
                "[FollowUpNotif] No admins with push tokens - notifications cannot be sent yet",
            );
            console.log(
                "[FollowUpNotif] ℹ️ Admins must log into mobile app to register push tokens",
            );
            console.log(
                "[FollowUpNotif] ℹ️ Current users without tokens:",
                allUsersInCompany
                    .filter((u) => !u.pushToken && !u.fcmToken)
                    .map((u) => u.name),
            );
            return;
        }

        // Get admin name for notification
        let adminName = "Admin";
        const adminUsers = allUsersInCompany.filter((u) =>
            ["admin", "Admin"].includes(u.role),
        );
        if (adminUsers.length > 0) {
            adminName = String(adminUsers[0].name || "Admin").trim() || "Admin";
        }

        console.log("[FollowUpNotif] Admin user data:", {
            name: adminUsers[0]?.name,
            role: adminUsers[0]?.role,
        });
        console.log(
            "[FollowUpNotif] Final Admin name:",
            adminName,
            "Type:",
            typeof adminName,
        );

        // Build notification text using proper phrases
        let title, body;
        try {
            const notificationTexts = getFollowUpCreationTexts({
                lang: "en",
                adminName: adminName,
                staffName: staffName,
                enquiryNo: followUp.enqNo,
                enquiryName: followUp.name,
                activityType: followUp.activityType,
            });
            title = notificationTexts?.title;
            body = notificationTexts?.body;
        } catch (fnError) {
            console.error(
                "[FollowUpNotif] Error calling getFollowUpCreationTexts:",
                fnError?.message,
            );
            // Fallback text construction
            title = "📋 New Follow-up Created";
            body = `${adminName} • ${staffName} created a follow-up for enquiry ${followUp.enqNo}`;
        }

        console.log("[FollowUpNotif] ✓ Built notification with:");
        console.log("  - adminName:", adminName);
        console.log("  - staffName:", staffName);
        console.log("  - enquiryNo:", followUp.enqNo);
        console.log("  - enquiryName:", followUp.name);
        console.log("  - activityType:", followUp.activityType);
        console.log("[FollowUpNotif] ✓ Resulting notification text:");
        console.log("  - title:", title);
        console.log("  - body:", body);

        // Send to each admin with token
        let successCount = 0;
        for (const admin of adminsWithTokens) {
            try {
                console.log(
                    `[FollowUpNotif] Sending to admin: ${admin.name} (${String(admin.fcmToken || admin.pushToken).substring(0, 20)}...)`,
                );

                const notificationPayload = {
                    title,
                    body,
                    data: {
                        type: "followup-created",
                        followUpId: followUp._id.toString(),
                        enqNo: followUp.enqNo,
                        enquiryName: followUp.name,
                        activityType: followUp.activityType,
                        createdBy: staffName,
                        createdById: req.userId,
                        adminName: adminName,
                    },
                };

                console.log(
                    "[FollowUpNotif] ✓ Notification Payload:",
                    JSON.stringify(notificationPayload, null, 2),
                );

                const success = await sendNotificationToUser(
                    admin,
                    notificationPayload,
                    { priority: "high", channelId: "followups" },
                );

                if (success) {
                    console.log("[FollowUpNotif] ✓ Sent to admin:", admin.name);
                    successCount++;
                } else {
                    console.warn(
                        "[FollowUpNotif] ✗ Failed to send to admin:",
                        admin.name,
                    );
                }
            } catch (error) {
                console.error(
                    "[FollowUpNotif] Error sending to admin:",
                    admin.name,
                    error?.message,
                );
            }
        }

        console.log(
            `[FollowUpNotif] Completed: ${successCount}/${adminsWithTokens.length} notifications sent successfully`,
        );

        // Log final status for debugging
        if (successCount === 0) {
            console.warn(
                "[FollowUpNotif] ⚠️ No notifications were sent successfully!",
            );
            console.warn("[FollowUpNotif] ⚠️ This may be due to:");
            console.warn(
                "[FollowUpNotif] ⚠️ 1. Invalid or expired push tokens",
            );
            console.warn(
                "[FollowUpNotif] ⚠️ 2. Network issues with Expo Push API",
            );
            console.warn(
                "[FollowUpNotif] ⚠️ 3. Users not logged into mobile app",
            );
            console.warn(
                "[FollowUpNotif] ⚠️ 4. Push tokens not registered on login",
            );
        } else {
            console.log(
                `[FollowUpNotif] ✅ Successfully sent ${successCount} notification(s)`,
            );
        }
    } catch (error) {
        console.error("[FollowUpNotif] Error:", error?.message);
    }
}

// ─── Debug Endpoint for Push Token Status ──────────────────────────────────
router.get("/debug-push-tokens", verifyToken, async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) {
            return res
                .status(400)
                .json({ success: false, message: "No company ID" });
        }

        const allUsers = await User.find({ company_id: companyId })
            .select(
                "name email role pushToken fcmToken lastTokenUpdate fcmTokenUpdatedAt",
            )
            .lean();

        const tokenStatus = allUsers.map((user) => ({
            name: user.name,
            email: user.email,
            role: user.role,
            hasToken: !!(user.pushToken || user.fcmToken),
            tokenPreview: user.fcmToken
                ? user.fcmToken.substring(0, 20) + "..."
                : user.pushToken
                    ? user.pushToken.substring(0, 20) + "..."
                    : null,
            lastUpdate: user.fcmTokenUpdatedAt || user.lastTokenUpdate,
        }));

        const summary = {
            totalUsers: allUsers.length,
            usersWithTokens: tokenStatus.filter((u) => u.hasToken).length,
            adminsWithTokens: tokenStatus.filter(
                (u) => ["admin", "Admin"].includes(u.role) && u.hasToken,
            ).length,
            staffWithTokens: tokenStatus.filter(
                (u) => ["staff", "Staff"].includes(u.role) && u.hasToken,
            ).length,
        };

        res.json({
            success: true,
            summary,
            users: tokenStatus,
        });
    } catch (error) {
        console.error("Debug push tokens error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET latest aggregated badge count for the user
router.get("/badge-count", verifyToken, async (req, res) => {
    try {
        const userId = req.userId;
        const badgeCount = await firebaseNotificationService.getUnreadBadgeCount(userId);
        res.json({ success: true, badgeCount });
    } catch (error) {
        console.error("Get badge count error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
