const bcrypt = require("bcryptjs");
const Company = require("../models/Company");
const User = require("../models/User");
const Enquiry = require("../models/Enquiry");
const Plan = require("../models/Plan");
const Coupon = require("../models/Coupon");
const CompanySubscription = require("../models/CompanySubscription");
const CompanyPlanOverride = require("../models/CompanyPlanOverride");
const { resolveEffectivePlan } = require("../services/planResolver");
const { clearCompanyPlanCache } = require("../middleware/planGuard");
const {
    FIXED_PLAN_CODES,
    ensureFixedPlansSynced,
    getPlanDefinition,
    invalidatePlanSyncCache,
    normalizePlanForClient,
} = require("../services/planFeatures");
const {
    getUsdInrRate,
    setUsdInrRate,
    getWorkspaceSettings,
    setWorkspaceSettings,
    getSecurityPolicy,
    setSecurityPolicy,
    getRazorpayConfig,
    setRazorpayConfig,
    setEnvFileValues,
} = require("../services/settingsService");
const { clearCompanyCache } = require("../middleware/auth");
const SupportTicket = require("../models/SupportTicket");
const { sendEmail } = require("../utils/emailService");

const startOfMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
);
const startOfYear = new Date(new Date().getFullYear(), 0, 1);

const getMonthLabels = (count = 6) => {
    const labels = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        labels.push(
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        );
    }
    return labels;
};

const mapSeries = (labels, grouped) => {
    const map = new Map(grouped.map((x) => [x._id, x.value]));
    return labels.map((label) => ({ label, value: map.get(label) || 0 }));
};

const logAction = async (
    req,
    action,
    metadata = {},
    category = "admin_action",
) => {
    try {
    } catch (logErr) {
        console.warn("[SuperAdmin] logAction failed:", logErr?.message);
    }
};

const parseDate = (d, fallback = null) => {
    const date = d ? new Date(d) : fallback;
    return date && !Number.isNaN(date.getTime()) ? date : null;
};

const getCouponLimits = (coupon) => ({
    globalLimit: Number(coupon?.globalUsageLimit || coupon?.usageLimit || 1),
    perCompanyLimit: Number(coupon?.perCompanyUsageLimit || 1),
});

const getCompanyCouponUsedCount = (coupon, companyId) => {
    const map = coupon?.companyUsageMap || {};
    if (typeof map.get === "function") {
        return Number(map.get(String(companyId)) || 0);
    }
    return Number(map[String(companyId)] || 0);
};

const getCouponPlanIds = (coupon) =>
    (Array.isArray(coupon?.applicablePlans) ? coupon.applicablePlans : [])
        .map((plan) => (typeof plan === "string" ? plan : plan?._id))
        .filter(Boolean)
        .map((id) => String(id));

const getCouponCompanyIds = (coupon) =>
    (Array.isArray(coupon?.applicableCompanies)
        ? coupon.applicableCompanies
        : []
    )
        .map((company) =>
            typeof company === "string" ? company : company?._id,
        )
        .filter(Boolean)
        .map((id) => String(id));

const isCouponAnnouncementEligible = (coupon) => {
    if (!coupon?.isActive) return false;
    const expiryDate = coupon?.expiryDate ? new Date(coupon.expiryDate) : null;
    if (expiryDate) {
        expiryDate.setHours(23, 59, 59, 999);
        if (expiryDate <= new Date()) return false;
    }
    const { globalLimit } = getCouponLimits(coupon);
    return Number(coupon?.usedCount || 0) < globalLimit;
};

const buildCouponAnnouncementPayload = (coupon) => {
    const discountLabel =
        coupon?.discountType === "percentage"
            ? `${Number(coupon?.discountValue || 0)}% OFF`
            : `$${Number(coupon?.discountValue || 0)} OFF`;

    return {
        type: "coupon-offer",
        couponId: String(coupon?._id || ""),
        code: String(coupon?.code || "").toUpperCase(),
        discountType: coupon?.discountType || "",
        discountValue: Number(coupon?.discountValue || 0),
        discountLabel,
        title: "Special offer available",
        body: `You have a special offer today. Use coupon ${String(coupon?.code || "").toUpperCase()} and save ${discountLabel}.`,
        expiryDate: coupon?.expiryDate || null,
        timestamp: new Date().toISOString(),
    };
};

const getCouponTargetUsers = async (coupon) => {
    const planIds = getCouponPlanIds(coupon);
    const scopedCompanyIds = coupon?.appliesToAllCompanies
        ? []
        : getCouponCompanyIds(coupon);

    let companyIds = scopedCompanyIds;

    if (planIds.length > 0) {
        const planCompanyIds = await CompanySubscription.distinct("companyId", {
            status: { $in: ["Trial", "Active"] },
            planId: { $in: planIds },
        });
        const normalizedPlanCompanyIds = planCompanyIds.map((id) => String(id));
        companyIds = companyIds.length
            ? companyIds.filter((companyId) =>
                normalizedPlanCompanyIds.includes(companyId),
            )
            : normalizedPlanCompanyIds;
    }

    if (!coupon?.appliesToAllCompanies && companyIds.length === 0) {
        return [];
    }

    const userQuery = {
        status: "Active",
        role: { $in: ["Admin", "admin", "Staff", "staff"] },
    };

    if (companyIds.length > 0) {
        userQuery.company_id = { $in: companyIds };
    }

    const users = await User.find(userQuery).select("_id company_id").lean();
    const companyKeys = [
        ...new Set(
            users.map((user) => String(user?.company_id || "")).filter(Boolean),
        ),
    ];
    const allowedCompanySet = new Set();

    await Promise.all(
        companyKeys.map(async (companyId) => {
            const resolved = await resolveEffectivePlan(companyId);
            if (String(resolved?.plan?.code || "").toUpperCase() !== "PRO") {
                allowedCompanySet.add(String(companyId));
            }
        }),
    );

    return users.filter((user) =>
        allowedCompanySet.has(String(user?.company_id || "")),
    );
};

const emitCouponSync = async (req, users, payload) => {
    const io = req.app?.get?.("io");
    if (!io) {
        return { sent: false, targetedUsers: 0 };
    }

    const userIds = [
        ...new Set(
            (Array.isArray(users) ? users : [])
                .map((user) => String(user?._id || user))
                .filter(Boolean),
        ),
    ];
    userIds.forEach((userId) => {
        io.to(`user:${userId}`).emit("COUPON_SYNC", payload);
    });

    return { sent: userIds.length > 0, targetedUsers: userIds.length };
};

const buildCouponSyncPayload = (coupon, action = "updated") => ({
    type: "coupon-sync",
    action,
    couponId: String(coupon?._id || ""),
    code: String(coupon?.code || "").toUpperCase(),
    isActive: Boolean(coupon?.isActive),
    expiresAt: coupon?.expiryDate || null,
    timestamp: new Date().toISOString(),
});

const emitCouponAnnouncement = async (req, coupon, users = null) => {
    try {
        if (!isCouponAnnouncementEligible(coupon)) {
            return { sent: false, targetedUsers: 0 };
        }

        const targetUsers = Array.isArray(users)
            ? users
            : await getCouponTargetUsers(coupon);
        const payload = buildCouponAnnouncementPayload(coupon);
        const result = await emitCouponSync(req, targetUsers, {
            ...payload,
            type: "coupon-offer",
        });

        return result;
    } catch (error) {
        console.error("Coupon announcement emit failed:", error);
        return { sent: false, targetedUsers: 0, error: error.message };
    }
};

exports.getDashboard = async (req, res) => {
    try {
        const [
            totalCompanies,
            totalUsers,
            activeSubscriptions,
            totalEnquiries,
            totalRevenueAgg,
            monthlyRevenueAgg,
            revenueTrendAgg,
            userGrowthAgg,
            companyGrowthAgg,
        ] = await Promise.all([
            Company.countDocuments(),
            User.countDocuments({ role: { $ne: "superadmin" } }),
            CompanySubscription.countDocuments({
                status: { $in: ["Active", "Trial"] },
            }),
            Enquiry.countDocuments(),
            CompanySubscription.aggregate([
                {
                    $match: {
                        status: {
                            $in: ["Active", "Trial", "Cancelled", "Expired"],
                        },
                    },
                },
                { $group: { _id: null, value: { $sum: "$finalPrice" } } },
            ]),
            CompanySubscription.aggregate([
                { $match: { startDate: { $gte: startOfMonth } } },
                { $group: { _id: null, value: { $sum: "$finalPrice" } } },
            ]),
            CompanySubscription.aggregate([
                {
                    $project: {
                        label: {
                            $dateToString: {
                                format: "%Y-%m",
                                date: { $ifNull: ["$startDate", "$createdAt"] },
                            },
                        },
                        amount: "$finalPrice",
                    },
                },
                { $match: { label: { $ne: null } } },
                { $group: { _id: "$label", value: { $sum: "$amount" } } },
            ]),
            User.aggregate([
                { $match: { role: { $ne: "superadmin" } } },
                {
                    $project: {
                        label: {
                            $dateToString: {
                                format: "%Y-%m",
                                date: "$createdAt",
                            },
                        },
                    },
                },
                { $group: { _id: "$label", value: { $sum: 1 } } },
            ]),
            Company.aggregate([
                {
                    $project: {
                        label: {
                            $dateToString: {
                                format: "%Y-%m",
                                date: "$createdAt",
                            },
                        },
                    },
                },
                { $group: { _id: "$label", value: { $sum: 1 } } },
            ]),
        ]);

        // Attempt to count call logs if the model is available
        let totalCallsLogged = 0;
        try {
            const CallLog = require("../models/CallLog");
            totalCallsLogged = await CallLog.countDocuments();
        } catch (_e) {
            // CallLog model not available — skip
        }

        const labels = getMonthLabels(6);

        res.json({
            totalCompanies,
            totalUsers,
            activeSubscriptions,
            totalRevenue: totalRevenueAgg[0]?.value || 0,
            monthlyRevenue: monthlyRevenueAgg[0]?.value || 0,
            totalEnquiries,
            totalCallsLogged,
            charts: {
                revenueTrend: mapSeries(labels, revenueTrendAgg),
                userGrowth: mapSeries(labels, userGrowthAgg),
                companyGrowth: mapSeries(labels, companyGrowthAgg),
            },
        });
    } catch (error) {
        await logAction(
            req,
            "SUPERADMIN_DASHBOARD_ERROR",
            { message: error.message },
            "error",
        );
        res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard",
        });
    }
};


exports.getCompanies = async (_req, res) => {
    try {
        const companies = await Company.aggregate([
            {
                $lookup: {
                    from: "users",
                    localField: "_id",
                    foreignField: "company_id",
                    as: "users",
                },
            },
            {
                $lookup: {
                    from: "companysubscriptions",
                    localField: "_id",
                    foreignField: "companyId",
                    as: "subscriptions",
                },
            },
            {
                $addFields: {
                    staffCount: {
                        $size: {
                            $filter: {
                                input: "$users",
                                as: "u",
                                cond: { $in: ["$$u.role", ["Staff", "staff"]] },
                            },
                        },
                    },
                    adminCount: {
                        $size: {
                            $filter: {
                                input: "$users",
                                as: "u",
                                cond: { $in: ["$$u.role", ["Admin", "admin"]] },
                            },
                        },
                    },
                    owner: {
                        $first: {
                            $filter: {
                                input: "$users",
                                as: "u",
                                cond: { $in: ["$$u.role", ["Admin", "admin"]] },
                            },
                        },
                    },
                    activeSub: {
                        $first: {
                            $filter: {
                                input: "$subscriptions",
                                as: "s",
                                cond: {
                                    $in: ["$$s.status", ["Active", "Trial"]],
                                },
                            },
                        },
                    },
                },
            },
            {
                $project: {
                    name: 1,
                    status: 1,
                    createdAt: 1,
                    staffCount: 1,
                    adminCount: 1,
                    ownerEmail: "$owner.email",
                    subscriptionStatus: "$activeSub.status",
                    planId: "$activeSub.planId",
                    disableEnvFallback: "$whatsappTemplate.disableEnvFallback",
                },
            },
            { $sort: { createdAt: -1 } },
        ]);

        const planIds = companies.map((c) => c.planId).filter(Boolean);
        const plans = await Plan.find({ _id: { $in: planIds } })
            .select("_id name code")
            .lean();
        const planMap = new Map(plans.map((p) => [p._id.toString(), p]));

        const response = companies.map((c) => ({
            ...c,
            plan: c.planId
                ? planMap.get(c.planId.toString())?.name || "-"
                : "-",
            planCode: c.planId
                ? planMap.get(c.planId.toString())?.code || "-"
                : "-",
            disableEnvFallback: c.disableEnvFallback || false,
        }));

        res.json(response);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch companies",
        });
    }
};

exports.updateCompanyStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const updated = await Company.findByIdAndUpdate(
            req.params.companyId,
            { $set: { status } },
            { returnDocument: "after", runValidators: true },
        );
        if (!updated)
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        clearCompanyCache(req.params.companyId);

        // Real-time notify all users in this company so clients can logout instantly (no refresh needed).
        try {
            const io = req.app?.get?.("io");
            if (io) {
                const users = await User.find({
                    company_id: req.params.companyId,
                })
                    .select("_id")
                    .lean();
                users.forEach((u) => {
                    const userId = u?._id?.toString?.() || String(u?._id || "");
                    if (!userId) return;
                    io.to(`user:${userId}`).emit("COMPANY_STATUS_CHANGED", {
                        companyId: req.params.companyId,
                        status: updated.status,
                        at: new Date().toISOString(),
                    });

                    if (String(updated.status) === "Suspended") {
                        io.to(`user:${userId}`).emit("FORCE_LOGOUT", {
                            reason: "Company is suspended",
                            companyId: req.params.companyId,
                            companyStatus: updated.status,
                            at: new Date().toISOString(),
                        });
                    }
                });
            }
        } catch (_socketError) {
            // ignore socket fanout errors
        }
        await logAction(req, "COMPANY_STATUS_UPDATED", {
            companyId: req.params.companyId,
            status,
        });
        res.json({ success: true, company: updated });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to update company status",
        });
    }
};

exports.updateCompanyEnvConfirmation = async (req, res) => {
    try {
        const { disableEnvFallback } = req.body;
        const updated = await Company.findByIdAndUpdate(
            req.params.companyId,
            { $set: { "whatsappTemplate.disableEnvFallback": Boolean(disableEnvFallback) } },
            { returnDocument: "after", runValidators: true },
        );
        if (!updated)
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });

        clearCompanyCache(req.params.companyId);

        await logAction(req, "COMPANY_ENV_CONFIRMATION_UPDATED", {
            companyId: req.params.companyId,
            disableEnvFallback: Boolean(disableEnvFallback),
        });
        res.json({ success: true, company: updated });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to update company environment confirmation setting",
        });
    }
};

exports.deleteCompany = async (req, res) => {
    try {
        const company = await Company.findByIdAndDelete(req.params.companyId);
        if (!company)
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });

        await Promise.all([
            User.deleteMany({ company_id: req.params.companyId }),
            CompanySubscription.deleteMany({ companyId: req.params.companyId }),
            CompanyPlanOverride.deleteMany({ companyId: req.params.companyId }),
        ]);

        await logAction(req, "COMPANY_DELETED", {
            companyId: req.params.companyId,
        });
        res.json({ success: true, message: "Company deleted" });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to delete company",
        });
    }
};

exports.getSupportTickets = async (req, res) => {
    try {
        const status = String(req.query?.status || "").trim();
        const q = String(req.query?.q || "")
            .trim()
            .toLowerCase();

        const filter = {};
        if (status) filter.status = status;

        let tickets = await SupportTicket.find(filter)
            .sort({ createdAt: -1 })
            .limit(200)
            .populate("companyId", "name status code")
            .lean();

        if (q) {
            tickets = tickets.filter((t) => {
                const companyName = t.companyId?.name || "";
                return (
                    String(t.email || "")
                        .toLowerCase()
                        .includes(q) ||
                    String(t.mobile || "")
                        .toLowerCase()
                        .includes(q) ||
                    String(t.name || "")
                        .toLowerCase()
                        .includes(q) ||
                    String(companyName).toLowerCase().includes(q) ||
                    String(t.message || "")
                        .toLowerCase()
                        .includes(q)
                );
            });
        }

        res.json({ success: true, tickets });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to load support tickets",
        });
    }
};

exports.respondSupportTicket = async (req, res) => {
    try {
        const {
            responseMessage,
            close = false,
            activateCompany = false,
        } = req.body || {};

        if (!responseMessage || !String(responseMessage).trim()) {
            return res
                .status(400)
                .json({
                    success: false,
                    message: "responseMessage is required",
                });
        }

        const ticket = await SupportTicket.findById(req.params.ticketId);
        if (!ticket)
            return res
                .status(404)
                .json({ success: false, message: "Ticket not found" });

        if (activateCompany && ticket.companyId) {
            await Company.findByIdAndUpdate(
                ticket.companyId,
                { $set: { status: "Active" } },
                { runValidators: true },
            );
            clearCompanyCache(ticket.companyId);
        }

        ticket.responseMessage = String(responseMessage).trim();
        ticket.respondedAt = new Date();
        ticket.respondedBy = req.userId;
        ticket.status = close ? "Closed" : "Responded";
        await ticket.save();

        const to = ticket.email;
        const subject = "NeoApp Support Response";
        const text = `Your support request has been reviewed.\n\nResponse:\n${ticket.responseMessage}\n`;
        const html = `<p>Your support request has been reviewed.</p><p><b>Response:</b></p><p>${String(
            ticket.responseMessage,
        ).replace(/\n/g, "<br/>")}</p>`;

        const mailSent = await sendEmail({ to, subject, text, html });

        res.json({ success: true, ticket, mailSent });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to respond to support ticket",
        });
    }
};

exports.getUsers = async (_req, res) => {
    try {
        const users = await User.aggregate([
            { $match: { role: { $ne: "superadmin" } } },
            {
                $lookup: {
                    from: "companies",
                    localField: "company_id",
                    foreignField: "_id",
                    as: "company",
                },
            },
            { $addFields: { company: { $first: "$company" } } },
            {
                $project: {
                    name: 1,
                    email: 1,
                    role: 1,
                    status: 1,
                    lastLogin: 1,
                    companyName: "$company.name",
                    companyStatus: "$company.status",
                    createdAt: 1,
                },
            },
            { $sort: { createdAt: -1 } },
        ]);

        res.json(users);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch users",
        });
    }
};

exports.updateUserStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const user = await User.findByIdAndUpdate(
            req.params.userId,
            { $set: { status } },
            { returnDocument: "after" },
        ).select("-password");
        if (!user)
            return res
                .status(404)
                .json({ success: false, message: "User not found" });

        await logAction(req, "USER_STATUS_UPDATED", {
            userId: req.params.userId,
            status,
        });
        res.json({ success: true, user });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to update user status",
        });
    }
};

exports.updateUserRole = async (req, res) => {
    try {
        const { role } = req.body;
        const allowed = ["admin", "staff", "Admin", "Staff"];
        if (!allowed.includes(role)) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid role" });
        }

        const userDoc = await User.findById(req.params.userId).select(
            "-password",
        );
        if (!userDoc)
            return res
                .status(404)
                .json({ success: false, message: "User not found" });

        const nextRole = String(role || "").toLowerCase();
        const currentRole = String(userDoc.role || "").toLowerCase();
        const companyId = userDoc.company_id ? String(userDoc.company_id) : "";

        if (nextRole === "admin" && currentRole !== "admin" && companyId) {
            const resolved = await resolveEffectivePlan(companyId);
            if (!resolved?.hasPlan) {
                return res.status(403).json({
                    success: false,
                    code: "NO_ACTIVE_PLAN",
                    message: "No active plan for this company",
                });
            }

            const limit = Number(resolved.plan?.maxAdmins || 0);
            const current = Number(resolved.plan?.adminsUsed || 0);
            if (limit <= 0 || current >= limit) {
                return res.status(403).json({
                    success: false,
                    code: "ADMIN_LIMIT_REACHED",
                    message: "Admin limit reached for this company plan",
                    limit,
                    current,
                });
            }
        }

        userDoc.role = role;
        await userDoc.save();
        const user = userDoc.toObject ? userDoc.toObject() : userDoc;

        await logAction(req, "USER_ROLE_UPDATED", {
            userId: req.params.userId,
            role,
        });
        res.json({ success: true, user });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to update user role",
        });
    }
};

exports.resetUserPassword = async (req, res) => {
    try {
        const { password } = req.body;
        const policy = await getSecurityPolicy();
        const minLen = Number(policy?.passwordMinLength ?? 8);
        const requiredLen = Number.isFinite(minLen) && minLen >= 8 ? minLen : 8;

        if (!password || String(password).length < requiredLen) {
            return res
                .status(400)
                .json({
                    success: false,
                    message: `Password must be at least ${requiredLen} characters`,
                });
        }

        const hash = await bcrypt.hash(password, 10);
        const user = await User.findByIdAndUpdate(
            req.params.userId,
            { $set: { password: hash, passwordChangedAt: new Date() } },
            { returnDocument: "after" },
        ).select("-password");
        if (!user)
            return res
                .status(404)
                .json({ success: false, message: "User not found" });

        await logAction(req, "USER_PASSWORD_RESET", {
            userId: req.params.userId,
        });
        res.json({ success: true, message: "Password reset successfully" });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to reset password",
        });
    }
};

exports.getPlans = async (_req, res) => {
    try {
        // Always invalidate before fetching so an update is immediately visible
        invalidatePlanSyncCache();
        const syncResult = await ensureFixedPlansSynced();
        syncResult.impactedCompanyIds.forEach((companyId) =>
            clearCompanyPlanCache(companyId),
        );
        const plans = syncResult.plans.map((plan) =>
            normalizePlanForClient(plan),
        );
        res.json(plans);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch plans",
        });
    }
};

exports.createPlan = async (req, res) => {
    try {
        return res.status(400).json({
            success: false,
            message:
                "Custom plans are disabled. Edit Free CRM, Basic CRM, or Pro CRM instead.",
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updatePlan = async (req, res) => {
    try {
        invalidatePlanSyncCache();
        const syncResult = await ensureFixedPlansSynced();
        const updates = { ...req.body };
        delete updates.currency;
        delete updates.features;
        delete updates.name;
        delete updates.code;
        delete updates.sortOrder;

        const existing = await Plan.findById(req.params.planId).lean();
        if (!existing)
            return res
                .status(404)
                .json({ success: false, message: "Plan not found" });

        const code = String(existing.code || "").toUpperCase();
        if (!FIXED_PLAN_CODES.includes(code)) {
            return res.status(400).json({
                success: false,
                message:
                    "Only Free CRM, Basic CRM, and Pro CRM can be managed here.",
            });
        }

        const definition = getPlanDefinition(code);
        const plan = await Plan.findByIdAndUpdate(
            req.params.planId,
            {
                $set: {
                    ...updates,
                    code,
                    name: definition.name,
                    sortOrder: definition.sortOrder,
                    features: [...definition.features],
                },
            },
            { returnDocument: "after", runValidators: true },
        );
        if (!plan)
            return res
                .status(404)
                .json({ success: false, message: "Plan not found" });

        const impactedSubscriptions = await CompanySubscription.find({
            planId: plan._id,
        })
            .select("companyId")
            .lean();
        impactedSubscriptions.forEach((subscription) => {
            clearCompanyPlanCache(subscription.companyId);
        });
        syncResult.impactedCompanyIds.forEach((companyId) =>
            clearCompanyPlanCache(companyId),
        );

        await logAction(req, "PLAN_UPDATED", {
            planId: plan._id,
            changes: updates,
        });
        res.json(
            normalizePlanForClient(plan.toObject ? plan.toObject() : plan),
        );
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getExchangeRates = async (_req, res) => {
    try {
        const usdInr = await getUsdInrRate();
        return res.json({ success: true, rates: { USD_INR: usdInr } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateExchangeRates = async (req, res) => {
    try {
        const usdInr = await setUsdInrRate(req.body?.USD_INR);
        await logAction(req, "EXCHANGE_RATES_UPDATED", { USD_INR: usdInr });
        return res.json({ success: true, rates: { USD_INR: usdInr } });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const looksLikeEmail = (value) => {
    const email = String(value || "").trim();
    if (!email) return true; // allow empty
    // simple email regex (same as auth validateEmail)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

exports.getWorkspaceSettings = async (_req, res) => {
    try {
        const workspace = await getWorkspaceSettings();
        return res.json({ success: true, workspace });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateWorkspaceSettings = async (req, res) => {
    try {
        const { name, supportEmail, defaultTimezone } = req.body || {};
        if (typeof name === "string" && !name.trim()) {
            return res
                .status(400)
                .json({
                    success: false,
                    message: "Workspace name is required",
                });
        }
        if (!looksLikeEmail(supportEmail)) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid support email" });
        }

        const workspace = await setWorkspaceSettings({
            name,
            supportEmail,
            defaultTimezone,
        });
        await logAction(req, "WORKSPACE_SETTINGS_UPDATED", {
            keys: Object.keys(req.body || {}),
        });
        return res.json({ success: true, workspace });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

exports.getSecurityPolicySettings = async (_req, res) => {
    try {
        const policy = await getSecurityPolicy();
        return res.json({ success: true, policy });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateSecurityPolicySettings = async (req, res) => {
    try {
        const next = await setSecurityPolicy(req.body || {});
        await logAction(req, "SECURITY_POLICY_UPDATED", {
            keys: Object.keys(req.body || {}),
        });
        return res.json({ success: true, policy: next });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const maskSecret = (value) => {
    const raw = String(value || "");
    if (!raw) return "";
    if (raw.length <= 6) return "******";
    return `${raw.slice(0, 2)}******${raw.slice(-2)}`;
};

exports.getRazorpaySettings = async (_req, res) => {
    try {
        const cfg = await getRazorpayConfig();
        return res.json({
            success: true,
            razorpay: {
                source: cfg.source || "env",
                keyId: cfg.keyId || "",
                keySecretMasked: maskSecret(cfg.keySecret),
                webhookSecretMasked: maskSecret(cfg.webhookSecret),
                configured: Boolean(cfg.keyId && cfg.keySecret),
                webhookConfigured: Boolean(cfg.webhookSecret),
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateRazorpaySettings = async (req, res) => {
    try {
        const {
            keyId,
            keySecret,
            webhookSecret,
            syncEnv = true,
        } = req.body || {};
        await setRazorpayConfig({ keyId, keySecret, webhookSecret });
        const effective = await getRazorpayConfig();

        let envWritten = false;
        if (syncEnv) {
            const result = await setEnvFileValues({
                RAZORPAY_KEY_ID: effective.keyId || "",
                RAZORPAY_KEY_SECRET: effective.keySecret || "",
                RAZORPAY_WEBHOOK_SECRET: effective.webhookSecret || "",
            });
            envWritten = Boolean(result?.envWritten);
        }

        await logAction(req, "RAZORPAY_SETTINGS_UPDATED", {
            envWritten,
            hasKeyId: Boolean(effective.keyId),
            hasKeySecret: Boolean(effective.keySecret),
            hasWebhookSecret: Boolean(effective.webhookSecret),
        });

        return res.json({
            success: true,
            envWritten,
            razorpay: {
                source: effective.source || "env",
                keyId: effective.keyId || "",
                keySecretMasked: maskSecret(effective.keySecret),
                webhookSecretMasked: maskSecret(effective.webhookSecret),
                configured: Boolean(effective.keyId && effective.keySecret),
                webhookConfigured: Boolean(effective.webhookSecret),
            },
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

exports.deletePlan = async (req, res) => {
    try {
        return res.status(400).json({
            success: false,
            message: "Fixed pricing tiers cannot be deleted.",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.getCoupons = async (_req, res) => {
    try {
        const coupons = await Coupon.find()
            .populate("applicablePlans", "name code")
            .populate("applicableCompanies", "name code")
            .sort({ createdAt: -1 })
            .lean();
        res.json(coupons);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch coupons",
        });
    }
};

exports.createCoupon = async (req, res) => {
    try {
        const payload = { ...req.body };
        if (payload.code) payload.code = String(payload.code).toUpperCase();
        if (payload.usageLimit && !payload.globalUsageLimit)
            payload.globalUsageLimit = payload.usageLimit;
        payload.globalUsageLimit = Math.max(
            1,
            Number(payload.globalUsageLimit || 1),
        );
        payload.perCompanyUsageLimit = Math.max(
            1,
            Number(payload.perCompanyUsageLimit || 1),
        );
        payload.usageLimit = payload.globalUsageLimit;
        if (!payload.companyUsageMap) payload.companyUsageMap = {};
        if (payload.appliesToAllCompanies) {
            payload.applicableCompanies = [];
        }
        const coupon = await Coupon.create(payload);
        const targetUsers = await getCouponTargetUsers(coupon);
        const syncResult = await emitCouponSync(
            req,
            targetUsers,
            buildCouponSyncPayload(coupon, "created"),
        );
        const announcement = await emitCouponAnnouncement(
            req,
            coupon,
            targetUsers,
        );
        await logAction(req, "COUPON_CREATED", {
            couponId: coupon._id,
            code: coupon.code,
        });
        res.status(201).json({
            ...coupon.toObject(),
            syncSent: Boolean(syncResult?.sent),
            syncUsers: Number(syncResult?.targetedUsers || 0),
            announcementSent: Boolean(announcement?.sent),
            announcementUsers: Number(announcement?.targetedUsers || 0),
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateCoupon = async (req, res) => {
    try {
        const previousCoupon = await Coupon.findById(
            req.params.couponId,
        ).lean();
        if (!previousCoupon)
            return res
                .status(404)
                .json({ success: false, message: "Coupon not found" });
        const payload = { ...req.body };
        if (payload.code) payload.code = String(payload.code).toUpperCase();
        if (payload.usageLimit && !payload.globalUsageLimit)
            payload.globalUsageLimit = payload.usageLimit;
        if (payload.globalUsageLimit != null)
            payload.globalUsageLimit = Math.max(
                1,
                Number(payload.globalUsageLimit),
            );
        if (payload.perCompanyUsageLimit != null)
            payload.perCompanyUsageLimit = Math.max(
                1,
                Number(payload.perCompanyUsageLimit),
            );
        if (payload.globalUsageLimit != null)
            payload.usageLimit = payload.globalUsageLimit;
        if (payload.appliesToAllCompanies) {
            payload.applicableCompanies = [];
        }
        const previousUsers = await getCouponTargetUsers(previousCoupon);
        const coupon = await Coupon.findByIdAndUpdate(
            req.params.couponId,
            { $set: payload },
            { returnDocument: "after", runValidators: true },
        );
        if (!coupon)
            return res
                .status(404)
                .json({ success: false, message: "Coupon not found" });
        const currentUsers = await getCouponTargetUsers(coupon);
        const combinedUsers = [...previousUsers, ...currentUsers];
        const syncResult = await emitCouponSync(
            req,
            combinedUsers,
            buildCouponSyncPayload(coupon, "updated"),
        );
        const announcement =
            !previousCoupon.isActive && coupon.isActive
                ? await emitCouponAnnouncement(req, coupon, currentUsers)
                : { sent: false, targetedUsers: 0 };
        await logAction(req, "COUPON_UPDATED", {
            couponId: coupon._id,
            changes: payload,
        });
        res.json({
            ...coupon.toObject(),
            syncSent: Boolean(syncResult?.sent),
            syncUsers: Number(syncResult?.targetedUsers || 0),
            announcementSent: Boolean(announcement?.sent),
            announcementUsers: Number(announcement?.targetedUsers || 0),
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.couponId).lean();
        if (!coupon)
            return res
                .status(404)
                .json({ success: false, message: "Coupon not found" });
        const targetUsers = await getCouponTargetUsers(coupon);

        if ((coupon.usedCount || 0) > 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete coupon after it has been used",
            });
        }

        const linkedSubscriptions = await CompanySubscription.countDocuments({
            couponId: req.params.couponId,
        });
        if (linkedSubscriptions > 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete coupon linked to subscriptions",
            });
        }

        await Coupon.findByIdAndDelete(req.params.couponId);
        await emitCouponSync(
            req,
            targetUsers,
            buildCouponSyncPayload(coupon, "deleted"),
        );
        await logAction(req, "COUPON_DELETED", {
            couponId: req.params.couponId,
            code: coupon.code,
        });
        return res.json({
            success: true,
            message: "Coupon deleted successfully",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.getOverrides = async (_req, res) => {
    try {
        const overrides = await CompanyPlanOverride.find()
            .populate("companyId", "name code")
            .populate("targetPlanId", "name code")
            .sort({ createdAt: -1 })
            .lean();
        res.json(overrides);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch overrides",
        });
    }
};

exports.upsertOverride = async (req, res) => {
    try {
        const { companyId, ...updates } = req.body;
        if (!companyId)
            return res
                .status(400)
                .json({ success: false, message: "companyId is required" });
        if (updates.targetPlanId === "") updates.targetPlanId = null;
        if (updates.targetPlanId === undefined) updates.targetPlanId = null;

        const override = await CompanyPlanOverride.findOneAndUpdate(
            { companyId },
            { $set: updates },
            { upsert: true, returnDocument: "after", runValidators: true },
        );

        await logAction(req, "COMPANY_OVERRIDE_UPSERTED", {
            companyId,
            updates,
        });
        res.json(override);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteOverride = async (req, res) => {
    try {
        const deleted = await CompanyPlanOverride.findByIdAndDelete(
            req.params.overrideId,
        );
        if (!deleted)
            return res
                .status(404)
                .json({ success: false, message: "Override not found" });

        await logAction(req, "COMPANY_OVERRIDE_DELETED", {
            overrideId: req.params.overrideId,
            companyId: deleted.companyId,
        });
        return res.json({
            success: true,
            message: "Override deleted successfully",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.getSubscriptions = async (_req, res) => {
    try {
        const subscriptions = await CompanySubscription.find()
            .populate("companyId", "name code status")
            .populate(
                "planId",
                "name code basePrice maxAdmins maxStaff extraAdminPrice extraStaffPrice",
            )
            .populate("couponId", "code discountType discountValue")
            .sort({ createdAt: -1 })
            .lean();
        res.json(subscriptions);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch subscriptions",
        });
    }
};

exports.deleteSubscription = async (req, res) => {
    try {
        const deleted = await CompanySubscription.findByIdAndDelete(
            req.params.subscriptionId,
        ).lean();
        if (!deleted)
            return res
                .status(404)
                .json({ success: false, message: "Subscription not found" });

        await logAction(req, "COMPANY_SUBSCRIPTION_DELETED", {
            subscriptionId: req.params.subscriptionId,
            companyId: deleted.companyId,
            planId: deleted.planId,
            status: deleted.status,
        });

        res.json({ success: true, message: "Subscription deleted" });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to delete subscription",
        });
    }
};

exports.assignSubscription = async (req, res) => {
    try {
        const {
            companyId,
            planId,
            status = "Active",
            startDate,
            endDate,
            trialUsed = false,
            manualOverrideExpiry,
            couponCode,
            notes,
            allocatedAdmins,
            allocatedStaff,
        } = req.body;

        if (!companyId || !planId) {
            return res
                .status(400)
                .json({
                    success: false,
                    message: "companyId and planId are required",
                });
        }

        const plan = await Plan.findById(planId).lean();
        if (!plan || !plan.isActive)
            return res
                .status(400)
                .json({ success: false, message: "Invalid or inactive plan" });

        let coupon = null;
        if (couponCode) {
            coupon = await Coupon.findOne({
                code: String(couponCode).toUpperCase(),
            });
            const couponExpiryEnd = coupon?.expiryDate
                ? new Date(coupon.expiryDate)
                : null;
            if (couponExpiryEnd) couponExpiryEnd.setHours(23, 59, 59, 999);
            const { globalLimit, perCompanyLimit } = getCouponLimits(coupon);
            const companyUsedCount = getCompanyCouponUsedCount(
                coupon,
                companyId,
            );
            const couponValid = Boolean(
                coupon &&
                coupon.isActive &&
                coupon.usedCount < globalLimit &&
                companyUsedCount < perCompanyLimit &&
                (!couponExpiryEnd || couponExpiryEnd > new Date()),
            );
            if (!couponValid) {
                return res
                    .status(400)
                    .json({ success: false, message: "Invalid coupon" });
            }
            if (
                coupon.applicablePlans?.length &&
                !coupon.applicablePlans.some((id) => id.toString() === planId)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: "Coupon not applicable to selected plan",
                    });
            }
            if (
                !coupon.appliesToAllCompanies &&
                coupon.applicableCompanies?.length &&
                !coupon.applicableCompanies.some(
                    (id) => id.toString() === companyId,
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: "Coupon not applicable to selected company",
                    });
            }
        }

        const start = parseDate(startDate, new Date());
        const defaultEnd = new Date(start);
        defaultEnd.setDate(defaultEnd.getDate() + (plan.trialDays || 30));

        const safeAllocatedAdmins = Math.max(
            Number(allocatedAdmins || 0),
            Number(plan.maxAdmins || 0),
        );
        const safeAllocatedStaff = Math.max(
            Number(allocatedStaff || 0),
            Number(plan.maxStaff || 0),
        );
        const extraAdminsPurchased = Math.max(
            0,
            safeAllocatedAdmins - Number(plan.maxAdmins || 0),
        );
        const extraStaffPurchased = Math.max(
            0,
            safeAllocatedStaff - Number(plan.maxStaff || 0),
        );
        const finalPrice =
            Number(plan.basePrice || 0) +
            extraAdminsPurchased * Number(plan.extraAdminPrice || 0) +
            extraStaffPurchased * Number(plan.extraStaffPrice || 0);

        const sub = await CompanySubscription.create({
            companyId,
            planId,
            couponId: coupon ? coupon._id : null,
            status,
            startDate: start,
            endDate: parseDate(endDate, defaultEnd),
            trialUsed,
            manualOverrideExpiry: parseDate(manualOverrideExpiry, null),
            finalPrice,
            allocatedAdmins: safeAllocatedAdmins,
            allocatedStaff: safeAllocatedStaff,
            extraAdminsPurchased,
            extraStaffPurchased,
            extraAdminPrice: Number(plan.extraAdminPrice || 0),
            extraStaffPrice: Number(plan.extraStaffPrice || 0),
            notes,
        });

        if (coupon) {
            coupon.usedCount += 1;
            coupon.companyUsageMap = coupon.companyUsageMap || {};
            coupon.companyUsageMap.set(
                String(companyId),
                getCompanyCouponUsedCount(coupon, companyId) + 1,
            );
            await coupon.save();
        }

        await logAction(req, "COMPANY_SUBSCRIPTION_ASSIGNED", {
            companyId,
            planId,
            subscriptionId: sub._id,
            couponCode: coupon?.code || null,
        });

        res.status(201).json(sub);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateSubscription = async (req, res) => {
    try {
        const sub = await CompanySubscription.findByIdAndUpdate(
            req.params.subscriptionId,
            { $set: req.body },
            { returnDocument: "after", runValidators: true },
        );
        if (!sub)
            return res
                .status(404)
                .json({ success: false, message: "Subscription not found" });

        await logAction(req, "COMPANY_SUBSCRIPTION_UPDATED", {
            subscriptionId: req.params.subscriptionId,
            changes: req.body,
        });

        res.json(sub);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getEffectivePlanByCompany = async (req, res) => {
    try {
        const { companyId } = req.params;
        const effective = await resolveEffectivePlan(companyId);
        res.json(effective);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Failed to resolve effective plan",
        });
    }
};

exports.getRevenue = async (_req, res) => {
    try {
        const [
            monthlyRevenueAgg,
            yearlyRevenueAgg,
            activeSubscriptions,
            cancelledSubscriptions,
            chartAgg,
        ] = await Promise.all([
            CompanySubscription.aggregate([
                { $match: { startDate: { $gte: startOfMonth } } },
                { $group: { _id: null, value: { $sum: "$finalPrice" } } },
            ]),
            CompanySubscription.aggregate([
                { $match: { startDate: { $gte: startOfYear } } },
                { $group: { _id: null, value: { $sum: "$finalPrice" } } },
            ]),
            CompanySubscription.countDocuments({
                status: { $in: ["Active", "Trial"] },
            }),
            CompanySubscription.countDocuments({ status: "Cancelled" }),
            CompanySubscription.aggregate([
                {
                    $project: {
                        label: {
                            $dateToString: {
                                format: "%Y-%m",
                                date: { $ifNull: ["$startDate", "$createdAt"] },
                            },
                        },
                        amount: "$finalPrice",
                    },
                },
                { $group: { _id: "$label", value: { $sum: "$amount" } } },
            ]),
        ]);

        const labels = getMonthLabels(12);
        res.json({
            monthlyRevenue: monthlyRevenueAgg[0]?.value || 0,
            yearlyRevenue: yearlyRevenueAgg[0]?.value || 0,
            activeSubscriptions,
            cancelledSubscriptions,
            revenueChart: mapSeries(labels, chartAgg),
        });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch revenue",
        });
    }
};

exports.getLogs = async (req, res) => {
    try {
        res.json([]);
    } catch (e) {
        res.status(500).json({ success: false });
    }
};

exports.getWebsiteLeads = async (req, res) => {
    try {
        const WebsiteLead = require("../models/WebsiteLead");
        const leads = await WebsiteLead.find().sort({ createdAt: -1 }).lean();
        res.json(leads);
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch website leads",
        });
    }
};

exports.getAdminStaffPayments = async (req, res) => {
    try {
        const AdminStaffPayment = require("../models/AdminStaffPayment");
        const payments = await AdminStaffPayment.find()
            .populate("companyId", "name code")
            .populate("userId", "name email")
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, payments });
    } catch (_error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch admin/staff payments",
        });
    }
};

exports.changeSuperadminPassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!newPassword) {
            return res.status(400).json({ success: false, message: "New password is required" });
        }
        if (!currentPassword) {
            return res.status(400).json({ success: false, message: "Current password is required" });
        }

        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "Superadmin profile not found" });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Incorrect current password" });
        }

        const policy = await getSecurityPolicy();
        const minLen = Number(policy?.passwordMinLength ?? 8);
        const requiredLen = Number.isFinite(minLen) && minLen >= 8 ? minLen : 8;

        if (String(newPassword).length < requiredLen) {
            return res.status(400).json({
                success: false,
                message: `New password must be at least ${requiredLen} characters`,
            });
        }

        const isSame = await bcrypt.compare(newPassword, user.password);
        if (isSame) {
            return res.status(400).json({
                success: false,
                message: "New password cannot be the same as your current password",
            });
        }

        user.password = newPassword;
        await user.save();

        await logAction(req, "SUPERADMIN_PASSWORD_CHANGED", {
            userId: user._id,
        });

        res.json({ success: true, message: "Password changed successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message || "Failed to change password" });
    }
};

