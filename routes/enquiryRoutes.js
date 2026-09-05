const express = require("express");
const router = express.Router();
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Company = require("../models/Company");
const mongoose = require("mongoose");
const FollowUp = require("../models/FollowUp");
const ChatMessage = require("../models/ChatMessage");
const MessageTemplate = require("../models/MessageTemplate");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { verifyToken } = require("../middleware/auth");
const cache = require("../utils/responseCache");
const {
    extractProviderMessageMeta,
    loadWhatsappConfig,
    normalizePhoneNumber,
    sendWhatsAppMessage,
} = require("../utils/whatsappConfigService");
const {
    buildSafeUploadName,
    createFileFilter,
} = require("../utils/uploadSecurity");
const { scrapePythonService } = require("../services/pythonScraperBridge");
const { getCompanyUserIds } = require("../utils/companyUsersCache");
const firebaseNotificationService = require("../services/firebaseNotificationService");
const { sendExpoNotification } = require("../BACKEND_NOTIFICATIONS");
const {
    sendNeoEnquiryTemplateMessage,
} = require("../utils/enquiryTemplateService");

// Handle both dev (server/routes) and prod (routes at root) folder structures
let getEnquiryAssignmentTexts;
try {
    // Try production path first (routes at same level as src)
    getEnquiryAssignmentTexts =
        require("../src/constants/notificationPhrases").getEnquiryAssignmentTexts;
} catch (e1) {
    try {
        // Try local dev path (routes inside server folder)
        getEnquiryAssignmentTexts =
            require("../../src/constants/notificationPhrases").getEnquiryAssignmentTexts;
    } catch (e2) {
        // Fallback stub when module is missing (graceful degradation for production)
        console.warn(
            "[WARNING] notificationPhrases module not found - using fallback stubs",
        );
        getEnquiryAssignmentTexts = ({
            staffName,
            enquiryNo,
            enquiryName,
        }) => ({
            title: `Assignment: ${enquiryNo}`,
            body: `${staffName} assigned enquiry ${enquiryName || enquiryNo} to you`,
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

const ENQUIRY_STATUS_MAP = {
    new: "New",
    contacted: "Contacted",
    interested: "Interested",
    "not interested": "Not Interested",
    not_interested: "Not Interested",
    "not-interested": "Not Interested",
    converted: "Converted",
    closed: "Closed",
    // Legacy aliases
    "in progress": "Contacted",
    in_progress: "Contacted",
    dropped: "Not Interested",
    drop: "Not Interested",
};

const ENQUIRY_STATUS_QUERY_MAP = {
    New: ["New"],
    Contacted: ["Contacted", "In Progress"],
    Interested: ["Interested"],
    "Not Interested": ["Not Interested", "Dropped"],
    Converted: ["Converted"],
    Closed: ["Closed"],
};

const normalizeEnquiryStatus = (raw) => {
    if (!raw) return "New";
    const key = String(raw).trim().toLowerCase();
    return ENQUIRY_STATUS_MAP[key] || raw;
};

const deriveFollowUpEnquiryStatus = (followUp, currentEnquiryStatus) => {
    const explicitStatus = normalizeEnquiryStatus(followUp?.enquiryStatus);
    if (explicitStatus && explicitStatus !== "New") return explicitStatus;
    if (followUp?.enquiryStatus) return explicitStatus;

    const typeText = String(followUp?.activityType || followUp?.type || "")
        .trim()
        .toLowerCase();
    const noteText = String(followUp?.note || followUp?.remarks || "")
        .trim()
        .toLowerCase();
    const nextAction = String(followUp?.nextAction || "")
        .trim()
        .toLowerCase();

    if (typeText === "system" || noteText === "enquiry created") {
        return "New";
    }
    if (nextAction === "sales") return "Converted";
    if (nextAction === "drop") return "Not Interested";

    return normalizeEnquiryStatus(currentEnquiryStatus || "New");
};

const toIsoDate = (value) => {
    if (!value) return null;
    if (typeof value === "string") {
        const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

const toClientIsoDate = (tzOffsetMinutes, fallback = new Date()) => {
    const n = Number(tzOffsetMinutes);
    if (!Number.isFinite(n)) return toIsoDate(fallback);
    const clamped = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(n)));
    return new Date(Date.now() - clamped * 60 * 1000)
        .toISOString()
        .slice(0, 10);
};

const escapeRegex = (value) =>
    String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getEnquiryAccessScope = async (req) => {
    const role = String(req.user?.role || "")
        .trim()
        .toLowerCase();
    const companyId = req.user?.company_id;
    const userId = req.userId;
    if (role === "staff") {
        const ownerUserIds = companyId
            ? await getCompanyUserIds(companyId)
            : [userId];
        return {
            companyId: companyId || null,
            ownerUserIds,
            scopingFilter: { assignedTo: userId },
        };
    }

    if (companyId) {
        // ⚡ Use cached company users (avoids MongoDB round-trip on every request)
        const ownerUserIds = await getCompanyUserIds(companyId);

        return {
            companyId,
            ownerUserIds: ownerUserIds.length > 0 ? ownerUserIds : [userId],
            scopingFilter: {},
        };
    }

    return {
        companyId: null,
        ownerUserIds: [userId],
        scopingFilter: {},
    };
};

const buildOwnerScopedFilter = (scope) => {
    const ownerUserIds = Array.isArray(scope?.ownerUserIds)
        ? scope.ownerUserIds.filter((id) =>
            mongoose.Types.ObjectId.isValid(String(id)),
        )
        : [];

    const userId =
        ownerUserIds.length <= 1
            ? ownerUserIds[0] || null
            : { $in: ownerUserIds };

    return {
        ...(scope?.companyId ? { companyId: scope.companyId } : {}),
        userId,
        ...(scope?.scopingFilter || {}),
    };
};

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, "../uploads");
        // Ensure uploads directory exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(
            null,
            buildSafeUploadName({
                prefix: file.fieldname || "image",
                originalname: file.originalname,
                fallbackExt: ".jpg",
            }),
        );
    },
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 5MB limit
    fileFilter: createFileFilter({
        allowedMimePatterns: [/^image\/(jpeg|png|gif|webp)$/],
        allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
        message: "Only image files are allowed!",
    }),
});

// Helper: Generate next enquiry number efficiently
const generateEnquiryNumber = async (companyId) => {
    try {
        const query = companyId ? { companyId } : {};
        const latestEnquiry = await Enquiry.findOne(query, { enqNo: 1 })
            .sort({ createdAt: -1 })
            .lean();

        let nextNumber = 1;

        if (latestEnquiry && latestEnquiry.enqNo) {
            const match = latestEnquiry.enqNo.match(/\d+/);
            if (match) {
                nextNumber = parseInt(match[0], 10) + 1;
            }
        }

        return `ENQ-${String(nextNumber).padStart(3, "0")}`;
    } catch (error) {
        console.error("Error generating enquiry number:", error);
        const count = await Enquiry.countDocuments(
            companyId ? { companyId } : {},
        );
        return `ENQ-${String(count + 1).padStart(3, "0")}`;
    }
};

const emitEnquiryCreated = async (req, enquiry, companyId) => {
    try {
        const io = req.app?.get("io");
        if (!io || !enquiry || !companyId) return;

        // ⚡ Use cached company users instead of a fresh DB query
        const userIds = await getCompanyUserIds(companyId);

        userIds.forEach((uid) => {
            const userId = String(uid || "");
            if (!userId) return;
            io.to(`user:${userId}`).emit("ENQUIRY_CREATED", {
                _id: enquiry._id,
                enqNo: enquiry.enqNo,
                assignedTo: enquiry.assignedTo,
                userId: enquiry.userId,
                companyId: String(companyId),
            });
        });
    } catch (_socketError) {
        // ignore real-time fanout issues
    }
};

const emitEnquiryUpdated = async (req, enquiry, companyId) => {
    try {
        const io = req.app?.get("io");
        if (!io || !enquiry) return;

        if (companyId) {
            // ⚡ Use cached company users instead of a fresh DB query
            const userIds = await getCompanyUserIds(companyId);

            userIds.forEach((uid) => {
                const userId = String(uid || "");
                if (!userId) return;
                io.to(`user:${userId}`).emit("ENQUIRY_UPDATED", {
                    _id: enquiry._id,
                    enqNo: enquiry.enqNo,
                    assignedTo: enquiry.assignedTo,
                    userId: enquiry.userId,
                    status: enquiry.status,
                    companyId: String(companyId),
                });
            });
            return;
        }

        const fallbackUserId = String(req.userId || "");
        if (fallbackUserId) {
            io.to(`user:${fallbackUserId}`).emit("ENQUIRY_UPDATED", {
                _id: enquiry._id,
                enqNo: enquiry.enqNo,
                assignedTo: enquiry.assignedTo,
                userId: enquiry.userId,
                status: enquiry.status,
            });
        }
    } catch (_socketError) {
        // ignore real-time fanout issues
    }
};

// GET ALL ENQUIRIES (With Search/Filter & Pagination)
router.get("/", verifyToken, async (req, res) => {
    const _start = Date.now();
    try {
        const {
            search,
            status,
            date,
            followUpDate,
            dateFrom,
            dateTo,
            assignedTo,
            page = 1,
            limit = 20,
        } = req.query;

        // ⚡ Short-lived cache (25s) — invalidated on create/update/delete
        // Skip cache for search queries so results are always fresh
        const cacheTtlMs = search ? 0 : 25000;
        const roleStr = String(req.user?.role || "")
            .trim()
            .toLowerCase();
        const cacheKey = cache.key("enquiries", {
            uid:
                roleStr === "staff" ? String(req.userId || "") : "company-wide",
            cid: String(req.user?.company_id || ""),
            role: roleStr,
            search: String(search || ""),
            status: String(status || ""),
            date: String(date || ""),
            followUpDate: String(followUpDate || ""),
            dateFrom: String(dateFrom || ""),
            dateTo: String(dateTo || ""),
            assignedTo: String(assignedTo || ""),
            page: String(page),
            limit: String(limit),
        });

        const { data: response } = await cache.wrap(
            cacheKey,
            async () => {
                const scope = await getEnquiryAccessScope(req);
                let query = buildOwnerScopedFilter(scope);

                if (!query.userId) {
                    if (req.user.role === "Staff")
                        return {
                            data: [],
                            pagination: {
                                total: 0,
                                page: 1,
                                limit: limit,
                                pages: 0,
                            },
                        };
                }

                if (date) {
                    query.date = date;
                } else if (dateFrom || dateTo) {
                    query.date = {};
                    if (dateFrom) query.date.$gte = dateFrom;
                    if (dateTo) query.date.$lte = dateTo;
                }

                if (assignedTo && assignedTo !== "all") {
                    // Include both explicitly assigned enquiries AND unassigned
                    // enquiries created by this user (assignedTo is null/absent
                    // means the creator "owns" them — i.e. self-assigned).
                    const assignedToFilter = [
                        { assignedTo: assignedTo },
                        { assignedTo: { $in: [null, undefined] }, userId: assignedTo },
                    ];

                    // Merge with any existing $or (e.g. from search) using $and
                    if (query.$or) {
                        query.$and = [
                            { $or: query.$or },
                            { $or: assignedToFilter },
                        ];
                        delete query.$or;
                    } else {
                        query.$or = assignedToFilter;
                    }
                }

                if (followUpDate) {
                    const followUpScope = {
                        ...(query.companyId
                            ? { companyId: query.companyId }
                            : {}),
                        userId: query.userId,
                        isCurrent: { $ne: false },
                        date: followUpDate,
                    };
                    if (assignedTo && assignedTo !== "all")
                        followUpScope.assignedTo = assignedTo;

                    const followUpEnquiryIds = (
                        await FollowUp.distinct("enqId", followUpScope)
                    ).filter((id) =>
                        mongoose.Types.ObjectId.isValid(String(id)),
                    );

                    if (followUpEnquiryIds.length === 0) {
                        return {
                            data: [],
                            pagination: {
                                total: 0,
                                page: 1,
                                limit: Number(limit),
                                pages: 0,
                            },
                        };
                    }

                    query._id = { $in: followUpEnquiryIds };
                }

                if (search) {
                    const raw = String(search || "").trim();
                    const s = raw.slice(0, 60);
                    const digits = s.replace(/\D/g, "");

                    let searchFilter;
                    // Fast paths that can use normal indexes (prefix regex).
                    if (
                        digits &&
                        digits.length >= 5 &&
                        digits.length === s.length
                    ) {
                        const re = `^${escapeRegex(digits)}`;
                        searchFilter = [{ mobile: { $regex: re } }];
                    } else if (/^enq[\s\-_]?\d+/i.test(s)) {
                        query.enqNo = {
                            $regex: `^${escapeRegex(s)}`,
                            $options: "i",
                        };
                    } else {
                        const re = escapeRegex(s);
                        searchFilter = [
                            { name: { $regex: re, $options: "i" } },
                            { mobile: { $regex: re, $options: "i" } },
                            { email: { $regex: re, $options: "i" } },
                            { enqNo: { $regex: re, $options: "i" } },
                        ];
                    }

                    // Merge search $or with any existing $or (from assignedTo filter)
                    if (searchFilter) {
                        if (query.$or) {
                            if (!query.$and) query.$and = [];
                            query.$and.push({ $or: query.$or });
                            query.$and.push({ $or: searchFilter });
                            delete query.$or;
                        } else if (query.$and) {
                            query.$and.push({ $or: searchFilter });
                        } else {
                            query.$or = searchFilter;
                        }
                    }
                }

                const selectedStatusFilter =
                    status && status !== "All"
                        ? normalizeEnquiryStatus(status)
                        : "";

                if (selectedStatusFilter && !followUpDate) {
                    const acceptedStatuses = ENQUIRY_STATUS_QUERY_MAP[
                        selectedStatusFilter
                    ] || [selectedStatusFilter];
                    query.status = { $in: acceptedStatuses };
                }

                const pageNum = parseInt(page);
                const limitNum = parseInt(limit);
                const skip = (pageNum - 1) * limitNum;

                const enquiries = await Enquiry.find(query)
                    .select(
                        "name mobile email image product enqNo status enqType date enquiryDateTime createdAt cost address source lastContactedAt assignedTo userId lastFollowUpDate lastFollowUpStatus nextFollowUpDate lastActivityAt",
                    )
                    .populate("assignedTo", "name email mobile role")
                    .populate("userId", "name email mobile role")
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum + 1)
                    .lean();

                const scopedEnquiries = enquiries.slice(0, limitNum);

                // Map denormalized fields
                scopedEnquiries.forEach((item) => {
                    item.latestFollowUpDate =
                        item.nextFollowUpDate || item.lastFollowUpDate || null;
                    item.latestFollowUpAt =
                        item.lastActivityAt || item.createdAt || null;
                    item.selectedFollowUpDate =
                        followUpDate ||
                        item.lastFollowUpDate ||
                        item.nextFollowUpDate ||
                        null;

                    if (followUpDate) {
                        item.currentEnquiryStatus = item.status;
                    }
                });

                if (selectedStatusFilter && followUpDate) {
                    const acceptedStatuses = ENQUIRY_STATUS_QUERY_MAP[
                        selectedStatusFilter
                    ] || [selectedStatusFilter];
                    for (let i = scopedEnquiries.length - 1; i >= 0; i -= 1) {
                        const s = normalizeEnquiryStatus(
                            scopedEnquiries[i]?.status,
                        );
                        if (!acceptedStatuses.includes(s)) {
                            scopedEnquiries.splice(i, 1);
                        }
                    }
                }

                const hasMore = enquiries.length > limitNum;
                if (hasMore) scopedEnquiries.pop();

                return {
                    data: scopedEnquiries,
                    pagination: {
                        total: hasMore
                            ? pageNum * limitNum + 1
                            : skip + scopedEnquiries.length,
                        page: pageNum,
                        limit: limitNum,
                        pages: hasMore ? pageNum + 1 : pageNum,
                    },
                };
            },
            cacheTtlMs,
        );

        res.json(response);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

const resolveAssignee = async ({
    requestedAssignedTo,
    ownerId,
    actorId,
    actor,
}) => {
    const actorRole = String(actor?.role || "").toLowerCase();
    if (actorRole === "staff") return actorId;

    const scopeUserId = actor?.parentUserId || ownerId;
    const actorDoc = await User.findById(scopeUserId)
        .select("company_id")
        .lean();
    const companyId = actor?.company_id || actorDoc?.company_id || null;

    if (requestedAssignedTo && requestedAssignedTo !== "all" && companyId) {
        const validAssignee = await User.findOne({
            _id: requestedAssignedTo,
            company_id: companyId,
            status: "Active",
            role: { $in: ["admin", "Admin", "staff", "Staff"] },
        })
            .select("_id")
            .lean();

        if (validAssignee?._id) return validAssignee._id;
    }

    return null;
};

// ADD NEW ENQUIRY (with optional image upload)
router.post("/", verifyToken, upload.single("image"), async (req, res) => {
    try {
        const { name, mobile, product, cost } = req.body;

        // Detailed validation with specific error messages
        const missingFields = [];
        if (!name || !String(name).trim()) missingFields.push("name");
        if (!mobile || !String(mobile).trim()) missingFields.push("mobile");
        if (!product || !String(product).trim()) missingFields.push("product");
        if (cost == null || cost === "")
            missingFields.push("cost (Lead Value)");

        if (missingFields.length > 0) {
            return res.status(400).json({
                message: `Missing required fields: ${missingFields.join(", ")}`,
            });
        }

        // 📷 Properly handle image: ensure it's a string or null
        let imageData = null;
        if (req.file) {
            // File was uploaded via multipart/form-data (PREFERRED)
            imageData = `/uploads/${req.file.filename}`;
            console.log("✅ Image uploaded successfully via FormData:", {
                filename: req.file.filename,
                originalName: req.file.originalname,
                size: req.file.size,
                path: imageData,
            });
        } else if (req.body.image) {
            // Image sent as JSON string (fallback)
            if (typeof req.body.image === "string" && req.body.image.trim()) {
                const img = req.body.image.trim();

                // 🔴 IMPORTANT: React Native sends blob: and file:// URIs via FormData
                // If they appear in JSON, it means FormData didn't work properly
                // But we'll accept them anyway as they may be valid data: or http URLs
                if (
                    img.startsWith("blob:") ||
                    img.startsWith("file://") ||
                    img.startsWith("content://")
                ) {
                    // Client-side URIs - these should have come via FormData
                    // Log but don't crash - client might have network issues
                    console.warn(
                        "⚠️  Received client-side URI (blob/file) in JSON body - this should have been sent via FormData:",
                        {
                            uri: img.substring(0, 50) + "...",
                            note: "Image upload may fail if client is offline or FormData wasn't supported",
                        },
                    );
                    // Don't use it - require FormData for these
                    imageData = null;
                } else if (
                    img.startsWith("http://") ||
                    img.startsWith("https://") ||
                    img.startsWith("data:")
                ) {
                    // Valid HTTP/HTTPS/data URLs - accept them
                    imageData = img;
                    console.log(
                        "✅ Image URL accepted:",
                        img.substring(0, 50) + "...",
                    );
                } else {
                    // Unknown format
                    console.log(
                        "ℹ️ Unknown image format:",
                        img.substring(0, 50),
                    );
                    imageData = null;
                }
            } else {
                console.log("⚠️ Image field is empty or invalid type");
                imageData = null;
            }
        } else {
            console.log("ℹ️ No image provided in enquiry");
        }

        const ownerId =
            req.user.role === "Staff" && req.user.parentUserId
                ? req.user.parentUserId
                : req.userId;
        const ownerUser = await User.findById(ownerId)
            .select("company_id")
            .lean();
        const companyId = req.user?.company_id || ownerUser?.company_id || null;

        const assignedTo = await resolveAssignee({
            requestedAssignedTo: req.body.assignedTo,
            ownerId,
            actorId: req.userId,
            actor: req.user,
        });

        const enquiryDateTime = new Date();
        const normalizedStatus = normalizeEnquiryStatus(
            req.body.status || "New",
        );
        const basePayload = {
            ...req.body,
            companyId,
            userId: ownerId,
            assignedTo,
            enqBy: req.user.name,
            image: imageData,
            date:
                toIsoDate(req.body.date) ||
                toClientIsoDate(req.body?.tzOffsetMinutes, enquiryDateTime),
            enquiryDateTime,
            status: normalizedStatus,
        };

        let savedEnquiry = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                const enqNo = await generateEnquiryNumber(companyId);
                savedEnquiry = await new Enquiry({
                    enqNo,
                    ...basePayload,
                }).save();
                break;
            } catch (saveError) {
                if (saveError?.code !== 11000) throw saveError;
            }
        }

        if (!savedEnquiry) {
            const fallbackEnqNo = `ENQ-${Date.now().toString().slice(-6)}`;
            savedEnquiry = await new Enquiry({
                enqNo: fallbackEnqNo,
                ...basePayload,
            }).save();
        }

        // --- AUTO-SEND INTRO TEMPLATE (if available) ---
        try {
            const cleanMobile = (savedEnquiry.mobile || "").replace(/\D/g, "");
            const short10 =
                cleanMobile.length > 10 ? cleanMobile.slice(-10) : cleanMobile;
            const companyId = req.user?.company_id || null;
            const cfg = await loadWhatsappConfig(
                companyId ? { companyId } : { ownerUserId: ownerId },
            );
            const normalizedPhone = normalizePhoneNumber(
                cleanMobile,
                cfg?.defaultCountry || "91",
            );

            // Look for an 'intro' template for this user (keyword or name contains 'intro')
            const introTemplate = await MessageTemplate.findOne({
                userId: ownerId,
                status: "Active",
                $or: [
                    { keyword: { $regex: "^intro$", $options: "i" } },
                    { keyword: { $regex: "intro", $options: "i" } },
                    { name: { $regex: "intro", $options: "i" } },
                ],
            }).lean();

            if (introTemplate && cfg) {
                try {
                    const sendResult = await sendWhatsAppMessage({
                        ownerUserId: ownerId,
                        companyId,
                        phoneNumber: normalizedPhone,
                        content: introTemplate.content,
                    });
                    const providerMeta = extractProviderMessageMeta(
                        cfg.provider,
                        sendResult.response,
                    );

                    const savedMsg = new ChatMessage({
                        userId: ownerId,
                        enquiryId: savedEnquiry._id,
                        sender: "Admin",
                        type: "text",
                        content: introTemplate.content,
                        phoneNumber: normalizedPhone,
                        status: providerMeta.providerOk ? "sent" : "failed",
                        externalId: providerMeta.externalId,
                        providerTicketId: providerMeta.providerTicketId,
                        providerResponse: sendResult.response
                            ? JSON.stringify(sendResult.response.data)
                            : null,
                        timestamp: new Date(),
                    });

                    await savedMsg.save();

                    // Emit to sockets so UI updates immediately
                    if (req.app.get("io")) {
                        const io = req.app.get("io");
                        io.emit(`new_message_${normalizedPhone}`, savedMsg);
                        io.emit(`new_message_${short10}`, savedMsg);
                        io.emit(`new_message_${cleanMobile}`, savedMsg);
                        io.emit("global_new_message", savedMsg);
                    }
                } catch (sendErr) {
                    console.warn(
                        "Auto-send intro template failed:",
                        sendErr.response?.data || sendErr.message,
                    );
                }
            }
        } catch (autoErr) {
            console.error("Auto-intro flow error:", autoErr.message || autoErr);
        }

        try {
            const company = await Company.findById(companyId)
                .select("name")
                .lean();
            const companyName =
                String(company?.name || "").trim() || "Your Company";
            const customerName =
                String(savedEnquiry.name || "").trim() || "Customer";
            const productName =
                String(savedEnquiry.product || "").trim() || "-";

            sendNeoEnquiryTemplateMessage({
                phoneNumber: savedEnquiry.mobile,
                customerName,
                productName,
                companyName,
                companyId,
            }).catch((templateError) => {
                console.warn(
                    "[WhatsApp][EnquiryTemplate] Internal enquiry send failed:",
                    templateError?.message || templateError,
                );
            });
        } catch (templateOuterError) {
            console.warn(
                "[WhatsApp][EnquiryTemplate] Internal enquiry flow error:",
                templateOuterError?.message || templateOuterError,
            );
        }

        cache.invalidate("enquiries"); // Clear list cache
        cache.invalidate("followups");
        cache.invalidate("dashboard");
        // ⚡ Fire-and-forget: respond immediately, emit to sockets in background
        emitEnquiryCreated(req, savedEnquiry, companyId).catch(() => { });
        res.status(201).json(savedEnquiry);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// GET SINGLE ENQUIRY (Supports both MongoDB ID and enqNo)
router.get("/:id", verifyToken, async (req, res) => {
    try {
        let enquiry;
        const scope = await getEnquiryAccessScope(req);
        const filter = buildOwnerScopedFilter(scope);

        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            enquiry = await Enquiry.findOne({
                _id: req.params.id,
                ...filter,
            })
                .populate("assignedTo", "name email mobile role")
                .populate("userId", "name email mobile role")
                .lean();
        } else {
            enquiry = await Enquiry.findOne({
                enqNo: req.params.id,
                ...filter,
            })
                .populate("assignedTo", "name email mobile role")
                .populate("userId", "name email mobile role")
                .lean();
        }

        if (!enquiry) {
            return res
                .status(404)
                .json({ message: "Enquiry not found or unauthorized" });
        }
        res.json(enquiry);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET ENQUIRY DETAIL WITH TIMELINE + UPCOMING REMINDERS
router.get("/:id/detail", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        const scope = await getEnquiryAccessScope(req);
        const baseFilter = buildOwnerScopedFilter(scope);
        const query = mongoose.Types.ObjectId.isValid(id)
            ? { _id: id, ...baseFilter }
            : { enqNo: id, ...baseFilter };

        const enquiry = await Enquiry.findOne(query)
            .populate("assignedTo", "name email mobile role")
            .populate("userId", "name email mobile role")
            .lean();

        if (!enquiry) {
            return res
                .status(404)
                .json({ message: "Enquiry not found or unauthorized" });
        }

        const timeline = await FollowUp.find({
            enqId: enquiry._id,
            ...baseFilter,
        })
            .find({
                activityType: { $ne: "System" },
                type: { $ne: "System" },
                note: { $ne: "Enquiry created", $not: /^Call:/i },
                remarks: { $ne: "Enquiry created", $not: /^Call:/i },
            })
            .sort({ activityTime: 1, createdAt: 1 })
            .select(
                "activityType type note remarks followUpDate nextFollowUpDate date staffName assignedTo status nextAction createdAt activityTime isCurrent",
            )
            .populate("assignedTo", "name")
            .lean();

        const today = new Date().toISOString().split("T")[0];
        const upcomingReminders = timeline.filter((item) => {
            const nextDate =
                item.nextFollowUpDate || item.followUpDate || item.date;
            const isClosed = ["Completed", "Drop", "Dropped"].includes(
                item.status,
            );
            return (
                nextDate &&
                nextDate >= today &&
                !isClosed &&
                item?.isCurrent !== false
            );
        });

        res.json({
            enquiry,
            currentStatus: enquiry.status,
            timeline,
            upcomingReminders,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// QUICK STATUS UPDATE
router.patch("/:id/status", verifyToken, async (req, res) => {
    try {
        const nextStatus = normalizeEnquiryStatus(req.body.status);
        if (!nextStatus)
            return res.status(400).json({ message: "status is required" });

        const scope = await getEnquiryAccessScope(req);
        const baseFilter = buildOwnerScopedFilter(scope);

        const query = mongoose.Types.ObjectId.isValid(req.params.id)
            ? { _id: req.params.id, ...baseFilter }
            : { enqNo: req.params.id, ...baseFilter };

        const update = { status: nextStatus };
        if (nextStatus === "Converted") update.conversionDate = new Date();

        const enquiry = await Enquiry.findOneAndUpdate(
            query,
            { $set: update },
            { returnDocument: "after" },
        );
        if (!enquiry)
            return res
                .status(404)
                .json({ message: "Enquiry not found or unauthorized" });

        cache.invalidate("enquiries");
        cache.invalidate("dashboard");
        cache.invalidate("reports");
        // ⚡ Fire-and-forget: respond immediately, emit in background
        emitEnquiryUpdated(
            req,
            enquiry,
            req.user?.company_id || enquiry?.companyId || null,
        ).catch(() => { });
        res.json(enquiry);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// UPCOMING FOLLOW-UP REMINDERS LIST
router.get("/meta/reminders", verifyToken, async (req, res) => {
    try {
        const scope = await getEnquiryAccessScope(req);
        const baseFilter = buildOwnerScopedFilter(scope);

        const today = new Date().toISOString().split("T")[0];
        const reminders = await FollowUp.find({
            ...baseFilter,
            isCurrent: { $ne: false },
            status: { $nin: ["Completed", "Drop", "Dropped"] },
            $or: [
                { nextFollowUpDate: { $gte: today } },
                { date: { $gte: today } },
            ],
        })
            .sort({ nextFollowUpDate: 1, date: 1, createdAt: 1 })
            .limit(200)
            .select(
                "enqId enqNo name mobile followUpDate nextFollowUpDate date activityType status assignedTo",
            )
            .populate("assignedTo", "name")
            .lean();

        res.json({ data: reminders });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.get("/meta/followup-status-summary", verifyToken, async (req, res) => {
    try {
        const selectedDate = String(
            req.query.followUpDate || toIsoDate(new Date()) || "",
        ).trim();
        const counts = {
            All: 0,
            New: 0,
            Contacted: 0,
            Interested: 0,
            "Not Interested": 0,
            Converted: 0,
            Closed: 0,
        };

        if (!selectedDate) {
            return res.json({ date: null, total: 0, counts });
        }

        const scope = await getEnquiryAccessScope(req);
        const baseFilter = buildOwnerScopedFilter(scope);

        const followUps = await FollowUp.find({
            ...baseFilter,
            isCurrent: { $ne: false },
            date: selectedDate,
        })
            .select("enqId")
            .lean();

        const enquiryIds = [
            ...new Set(
                followUps
                    .map((item) => item.enqId)
                    .filter((id) =>
                        mongoose.Types.ObjectId.isValid(String(id)),
                    ),
            ),
        ];

        if (enquiryIds.length === 0) {
            return res.json({ date: selectedDate, total: 0, counts });
        }

        const enquiries = await Enquiry.find({
            userId: baseFilter.userId,
            _id: { $in: enquiryIds },
        })
            .select("status")
            .lean();

        enquiries.forEach((item) => {
            const normalizedStatus = normalizeEnquiryStatus(item?.status);
            const summaryKey =
                counts[normalizedStatus] !== undefined
                    ? normalizedStatus
                    : "New";
            counts[summaryKey] += 1;
            counts.All += 1;
        });

        res.json({ date: selectedDate, total: counts.All, counts });
    } catch (err) {
        console.error("Follow-up status summary error:", err);
        res.status(500).json({ message: err.message });
    }
});

// REPORT SUMMARY (total, converted, pending/missed followups)
router.get("/meta/report-summary", verifyToken, async (req, res) => {
    try {
        const scope = await getEnquiryAccessScope(req);
        const baseFilter = buildOwnerScopedFilter(scope);

        const today = new Date().toISOString().split("T")[0];
        const enquiryFilter = { ...baseFilter };
        const followFilter = { ...baseFilter };

        const [
            totalEnquiries,
            convertedEnquiries,
            pendingFollowUps,
            missedFollowUps,
        ] = await Promise.all([
            Enquiry.countDocuments(enquiryFilter),
            Enquiry.countDocuments({ ...enquiryFilter, status: "Converted" }),
            FollowUp.countDocuments({
                ...followFilter,
                isCurrent: { $ne: false },
                status: {
                    $nin: [
                        "Completed",
                        "Drop",
                        "Dropped",
                        "Converted",
                        "Missed",
                    ],
                },
                $or: [
                    { date: { $gt: today } },
                    { date: today, dueAt: { $gte: new Date() } },
                ],
            }),
            FollowUp.countDocuments({
                ...followFilter,
                isCurrent: { $ne: false },
                status: "Missed",
            }),
        ]);

        res.json({
            totalEnquiries,
            convertedEnquiries,
            pendingFollowUps,
            missedFollowUps,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// BULK ASSIGN ENQUIRIES
router.put("/bulk-assign", verifyToken, async (req, res) => {
    try {
        const { enquiryIds, assignedTo } = req.body;
        if (!Array.isArray(enquiryIds) || enquiryIds.length === 0) {
            return res.status(400).json({ error: "No enquiries selected for bulk assignment" });
        }
        if (!assignedTo) {
            return res.status(400).json({ error: "No staff member selected" });
        }

        const ownerId = req.user.role === "Staff" && req.user.parentUserId ? req.user.parentUserId : req.userId;
        const ownerUser = await User.findById(ownerId).select("company_id").lean();
        const companyId = req.user?.company_id || ownerUser?.company_id || null;

        const resolvedAssignedTo = await resolveAssignee({
            requestedAssignedTo: assignedTo,
            ownerId,
            actorId: req.userId,
            actor: req.user,
        });

        if (!resolvedAssignedTo) {
            return res.status(400).json({ error: "Invalid assignee selected" });
        }

        // Fetch enquiries to verify permissions and get full objects for notifications
        const enquiries = await Enquiry.find({ _id: { $in: enquiryIds }, companyId }).lean();
        if (enquiries.length === 0) {
            return res.status(404).json({ error: "No matching enquiries found" });
        }

        // Update all
        const validIds = enquiries.map((e) => e._id);
        await Enquiry.updateMany(
            { _id: { $in: validIds } },
            { $set: { assignedTo: resolvedAssignedTo } }
        );

        // Notify and emit socket events
        for (const enq of enquiries) {
            const updatedEnq = { ...enq, assignedTo: resolvedAssignedTo };
            await emitEnquiryUpdated(req, updatedEnq, companyId);
            await sendEnquiryAssignmentNotifications(req, updatedEnq, resolvedAssignedTo);
        }

        res.json({ success: true, count: validIds.length });
    } catch (error) {
        console.error("Bulk assign error:", error);
        res.status(500).json({ error: "Failed to bulk assign enquiries" });
    }
});

// UPDATE ENQUIRY (with optional image upload)
router.put("/:id", verifyToken, upload.single("image"), async (req, res) => {
    try {
        // DEBUG: Log what we received
        console.log("🔍 PUT /enquiries/:id Request Debug:", {
            enquiryId: req.params.id,
            hasFile: !!req.file,
            fileName: req.file?.filename,
            bodyImage: req.body.image
                ? req.body.image.substring(0, 50)
                : "undefined",
            bodyKeys: Object.keys(req.body),
        });

        // Handle image - either from file upload or base64 string
        let updateData = { ...req.body };

        const scope = await getEnquiryAccessScope(req);
        const filter = buildOwnerScopedFilter(scope);

        // PROTECT USERID: Ensure users can't change who the record belongs to
        delete updateData.userId;

        // SANITIZE DATA: Prevent empty strings for ObjectIds or Numbers which cause Mongoose validation errors
        if (updateData.assignedTo === "") updateData.assignedTo = null;
        if (String(req.user?.role || "").toLowerCase() === "staff") {
            delete updateData.assignedTo;
        } else if (updateData.assignedTo) {
            const companyId = req.user?.company_id || null;
            if (companyId) {
                const validAssignee = await User.findOne({
                    _id: updateData.assignedTo,
                    company_id: companyId,
                    status: "Active",
                    role: { $in: ["admin", "Admin", "staff", "Staff"] },
                })
                    .select("_id")
                    .lean();
                if (!validAssignee?._id) {
                    return res
                        .status(400)
                        .json({ message: "Invalid assignee selected" });
                }
            }
        }
        if (updateData.cost === "")
            delete updateData.cost; // Or set to 0? Model says required: true.
        else if (updateData.cost !== undefined)
            updateData.cost = Number(updateData.cost);
        if (updateData.status)
            updateData.status = normalizeEnquiryStatus(updateData.status);
        if (updateData.date)
            updateData.date = toIsoDate(updateData.date) || updateData.date;
        if (updateData.enquiryDateTime) {
            const d = new Date(updateData.enquiryDateTime);
            if (!Number.isNaN(d.getTime())) updateData.enquiryDateTime = d;
        }

        if (req.file) {
            // File was uploaded via multipart/form-data (PREFERRED)
            updateData.image = `/uploads/${req.file.filename}`;
            console.log("✅ Image uploaded successfully via FormData in PUT:", {
                filename: req.file.filename,
                originalName: req.file.originalname,
                size: req.file.size,
                enquiryId: req.params.id,
            });
        } else if (req.body.image) {
            // Image sent as JSON string (fallback)
            if (typeof req.body.image === "string" && req.body.image.trim()) {
                const img = req.body.image.trim();

                // 🔴 React Native might send blob: and file:// URIs
                // These should have come via FormData, but accept valid URLs
                if (
                    img.startsWith("blob:") ||
                    img.startsWith("file://") ||
                    img.startsWith("content://")
                ) {
                    // Client-side URIs - should have been sent via FormData
                    console.warn(
                        "⚠️ Received client-side URI in JSON body (should be FormData):",
                        {
                            uri: img.substring(0, 50) + "...",
                            enquiryId: req.params.id,
                        },
                    );
                    // Don't use it - require FormData for these
                    delete updateData.image;
                } else if (
                    img.startsWith("http://") ||
                    img.startsWith("https://") ||
                    img.startsWith("data:")
                ) {
                    // Valid HTTP/HTTPS/data URLs - accept them
                    updateData.image = img;
                    console.log(
                        "✅ Image URL accepted in PUT:",
                        img.substring(0, 50) + "...",
                    );
                } else {
                    // Unknown format
                    console.log(
                        "ℹ️ Keeping existing image, unknown format in body",
                    );
                    delete updateData.image;
                }
            } else {
                console.log("ℹ️ No image in request body");
                delete updateData.image;
            }
        } else {
            console.log("ℹ️ No image update in PUT request");
        }

        console.log("📝 Update Data Image:", {
            imageField: updateData.image,
            enquiryId: req.params.id,
        });

        let enquiry;
        let oldEnquiry = null;
        const mongoose = require("mongoose");

        // Get old enquiry to check for assignment changes
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            oldEnquiry = await Enquiry.findOne({
                _id: req.params.id,
                ...filter,
            });
        } else {
            oldEnquiry = await Enquiry.findOne({
                enqNo: req.params.id,
                ...filter,
            });
        }

        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            enquiry = await Enquiry.findOneAndUpdate(
                { _id: req.params.id, ...filter },
                updateData,
                { returnDocument: "after", runValidators: true },
            );
        } else {
            enquiry = await Enquiry.findOneAndUpdate(
                { enqNo: req.params.id, ...filter },
                updateData,
                { returnDocument: "after", runValidators: true },
            );
        }

        if (!enquiry) {
            return res
                .status(404)
                .json({ message: "Enquiry not found or unauthorized" });
        }

        // --- NEW: Sync data with FollowUp collection ---
        try {
            const syncData = {};
            if (updateData.name) syncData.name = updateData.name;
            if (updateData.mobile) syncData.mobile = updateData.mobile;
            if (updateData.image) syncData.image = updateData.image;
            if (updateData.product) syncData.product = updateData.product;
            // Sync reassignment
            if (updateData.assignedTo !== undefined)
                syncData.assignedTo = updateData.assignedTo;

            if (Object.keys(syncData).length > 0) {
                await FollowUp.updateMany(
                    { enqId: enquiry._id },
                    { $set: syncData },
                );
            }
        } catch (syncErr) {
            console.error("❌ Sync with FollowUp failed:", syncErr.message);
        }

        // --- NEW: Send notifications for assignment changes ---
        try {
            const oldAssignedTo = oldEnquiry?.assignedTo?.toString();
            const newAssignedTo = enquiry.assignedTo?.toString();

            if (
                updateData.assignedTo !== undefined &&
                oldAssignedTo !== newAssignedTo &&
                newAssignedTo
            ) {
                // Enquiry was assigned to a staff member
                await sendEnquiryAssignmentNotifications(
                    req,
                    enquiry,
                    newAssignedTo,
                );
            }
        } catch (notifErr) {
            console.error(
                "❌ Assignment notification failed:",
                notifErr.message,
            );
        }

        cache.invalidate("enquiries");
        cache.invalidate("followups");
        cache.invalidate("dashboard");
        // ⚡ Fire-and-forget: respond immediately, emit in background
        emitEnquiryUpdated(
            req,
            enquiry,
            req.user?.company_id || enquiry?.companyId || null,
        ).catch(() => { });
        res.json(enquiry);
    } catch (err) {
        console.error(
            `❌ [PUT /enquiries/${req.params.id}] Error:`,
            err.message,
        );
        if (err.name === "ValidationError") {
            console.error(
                "   Validation details:",
                Object.keys(err.errors).map(
                    (k) => `${k}: ${err.errors[k].message}`,
                ),
            );
        }
        res.status(400).json({ message: err.message, errors: err.errors });
    }
});

// DELETE ENQUIRY
router.delete("/:id", verifyToken, async (req, res) => {
    try {
        const scope = await getEnquiryAccessScope(req);
        const filter = { _id: req.params.id, ...buildOwnerScopedFilter(scope) };
        const enquiry = await Enquiry.findOneAndDelete(filter);
        if (!enquiry) {
            return res
                .status(404)
                .json({ message: "Enquiry not found or unauthorized" });
        }

        // Remove related follow-ups so deleted enquiries do not appear in Follow-up screens.
        await FollowUp.deleteMany({
            ...buildOwnerScopedFilter(scope),
            $or: [{ enqId: enquiry._id }, { enqNo: enquiry.enqNo }],
        });

        cache.invalidate("enquiries");
        cache.invalidate("followups");
        cache.invalidate("dashboard");
        res.json({ message: "Enquiry deleted successfully", data: enquiry });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── SCRAPE WEBSITE (Python-powered advanced scraping) ────────────────────────
router.post("/scrape-website", verifyToken, async (req, res) => {
    try {
        const { url } = req.body;

        // Validate URL format
        if (!url || typeof url !== "string") {
            return res.status(400).json({
                error: "URL is required",
                errorCode: "INVALID_INPUT",
            });
        }

        try {
            new URL(url);
        } catch {
            return res.status(400).json({
                error: "Invalid URL format. Please enter a complete URL (e.g., https://example.com)",
                errorCode: "INVALID_URL_FORMAT",
            });
        }

        console.log(`[Scraping] Starting Python scrape for: ${url}`);

        // Scrape the website using Python service
        const scrapedData = await scrapePythonService(url);

        if (!scrapedData.success) {
            return res.status(400).json({
                error:
                    scrapedData.error || "Could not extract data from website",
                errorCode: "NO_DATA_EXTRACTED",
            });
        }

        // Transform Python output to frontend format
        const result = {
            success: true,
            companyName: scrapedData.companyName,
            email: scrapedData.emails?.[0] || null,
            phone: scrapedData.phones?.[0] || null,
            location: scrapedData.location,
            productDetails: scrapedData.productDetails?.join(", ") || "",
            // Additional data from Python scraper
            allEmails: scrapedData.emails,
            allPhones: scrapedData.phones,
            socialMedia: scrapedData.socialMedia,
            metadata: scrapedData.metadata,
            contactInfo: scrapedData.contactInfo,
        };

        console.log(`[Scraping] Successfully scraped: ${url}`, result);
        res.status(200).json(result);
    } catch (error) {
        console.error("[Scraping Error]", {
            message: error.message,
            stack: error.stack,
            url: req.body?.url,
        });

        res.status(500).json({
            error:
                error.message ||
                "Failed to scrape website. Please check the URL and try again.",
            errorCode: "SCRAPING_FAILED",
        });
    }
});

async function sendEnquiryAssignmentNotifications(
    req,
    enquiry,
    assignedToUserId,
) {
    try {
        const companyId = req.user?.company_id || enquiry?.companyId;
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
            const staffTexts = getEnquiryAssignmentTexts({
                lang: "en", // You can get from user preferences
                staffName: adminUser.name,
                enquiryNo: enquiry.enqNo,
                enquiryName: enquiry.name,
            });

            await sendNotificationToUser(
                staffUser,
                {
                    title: staffTexts.title,
                    body: staffTexts.body,
                    data: {
                        type: "enquiry-assigned",
                        enquiryId: enquiry._id.toString(),
                        enqNo: enquiry.enqNo,
                        assignedBy: adminUser.name,
                    },
                },
                { priority: "high", channelId: "enquiries" },
            );
        }

        // Send notification to admin
        if (adminPushToken?.pushToken || adminPushToken?.fcmToken) {
            const adminTexts = getEnquiryAssignmentTexts({
                lang: "en",
                staffName: staffUser.name,
                enquiryNo: enquiry.enqNo,
                enquiryName: enquiry.name,
            });

            await sendNotificationToUser(
                adminPushToken,
                {
                    title: adminTexts.title,
                    body: adminTexts.body,
                    data: {
                        type: "enquiry-assigned-admin",
                        enquiryId: enquiry._id.toString(),
                        enqNo: enquiry.enqNo,
                        assignedTo: staffUser.name,
                    },
                },
                { priority: "high", channelId: "enquiries" },
            );
        }

        // Create a follow-up for the assigned staff
        const followUp = new FollowUp({
            enqId: enquiry._id,
            enqNo: enquiry.enqNo,
            name: enquiry.name,
            mobile: enquiry.mobile,
            assignedTo: assignedToUserId,
            activityType: "Follow-up",
            date: new Date(),
            time: new Date().toTimeString().split(" ")[0],
            status: "Pending",
            userId: req.user.id,
            companyId: companyId,
        });

        await followUp.save();
    } catch (error) {
        console.error("Error sending enquiry assignment notifications:", error);
    }
}

module.exports = router;
