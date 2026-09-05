const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");
const path = require("path");
const Company = require("../models/Company");
const User = require("../models/User");
const Plan = require("../models/Plan");
const Coupon = require("../models/Coupon");
const CompanyPlanOverride = require("../models/CompanyPlanOverride");
const CompanySubscription = require("../models/CompanySubscription");
const Payment = require("../models/Payment");
const Enquiry = require("../models/Enquiry");
const FollowUp = require("../models/FollowUp");
const ChatMessage = require("../models/ChatMessage");
const CommunicationMessage = require("../models/CommunicationMessage");
const CommunicationTask = require("../models/CommunicationTask");
const EmailSettings = require("../models/EmailSettings");
const EmailTemplate = require("../models/EmailTemplate");
const EmailLog = require("../models/EmailLog");
const MessageTemplate = require("../models/MessageTemplate");
const LeadSource = require("../models/LeadSource");
const Product = require("../models/Product");
const Subscription = require("../models/Subscription");
const SupportTicket = require("../models/SupportTicket");
const Target = require("../models/Target");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const { verifyToken, clearCompanyCache } = require("../middleware/auth");
const { sendEmailOTP, sendMobileOTP, sendPlanUpgradeNotification, sendAdminPaymentAlert } = require("../utils/otpService");
const { sendEmail } = require("../utils/emailService");
const { clearUserCache } = require("../middleware/auth");
const cache = require("../utils/responseCache");
const { resolveEffectivePlan } = require("../services/planResolver");
const { clearCompanyPlanCache } = require("../middleware/planGuard");
const {
    getUsdInrRate,
    getRazorpayConfig,
} = require("../services/settingsService");
const {
    ensureFixedPlansSynced,
    normalizePlanForClient,
} = require("../services/planFeatures");
const {
    buildSafeUploadName,
    createFileFilter,
} = require("../utils/uploadSecurity");
const {
    getRazorpayClientAsync,
    verifyCheckoutSignatureAsync,
    verifyWebhookSignatureAsync,
} = require("../services/razorpayService");

const otpStore = {}; // Memory store for profile changes
const EXPOSE_TEST_OTP =
    String(process.env.EXPOSE_TEST_OTP || "").toLowerCase() === "true" ||
    String(process.env.NODE_ENV || "").toLowerCase() !== "production";

const profileUploadDir = path.join(__dirname, "../uploads/profile");
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
}

const profileStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profileUploadDir),
    filename: (_req, file, cb) => {
        cb(
            null,
            buildSafeUploadName({
                prefix: "logo",
                originalname: file.originalname,
                fallbackExt: ".jpg",
            }),
        );
    },
});

const profileUpload = multer({
    storage: profileStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: createFileFilter({
        allowedMimePatterns: [/^image\/(jpeg|png|gif|webp)$/],
        allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
        message: "Only JPG, PNG, GIF, or WEBP images are allowed.",
    }),
});

// Simple OTP generator
const generateOTP = () =>
    Math.floor(100000 + Math.random() * 900000).toString();

const isEnterprisePlan = (plan) => {
    if (!plan) return false;
    const code = String(plan.code || "").toLowerCase();
    const name = String(plan.name || "").toLowerCase();
    return code.includes("enter") || name.includes("enterprise");
};

const isRazorpayConfigured = async () => {
    const cfg = await getRazorpayConfig();
    return Boolean(cfg?.keyId && cfg?.keySecret);
};

const buildRazorpayReceipt = ({ companyId, planId }) => {
    const companyPart = String(companyId || "").slice(-6) || "company";
    const planPart = String(planId || "").slice(-6) || "plan";
    const timePart = Date.now().toString(36);
    // Razorpay receipts have a small max length; keep this deterministic and compact.
    return `c${companyPart}p${planPart}${timePart}`.slice(0, 40);
};

const buildReceiptNumber = ({ subscriptionId, paymentId }) => {
    const subPart = String(subscriptionId || "").slice(-6) || "sub000";
    const payPart = String(paymentId || "").slice(-6) || "pay000";
    return `NEO-${subPart}-${payPart}`.toUpperCase();
};

const buildPaymentReceipt = ({
    companyName = "NeoApp Workspace",
    customerName = "",
    customerEmail = "",
    planName = "",
    paymentId = "",
    orderId = "",
    amountUsd = 0,
    amountInr = 0,
    currency = "INR",
    couponCode = "",
    renewDate = null,
    subscriptionId = "",
    paidAt = new Date(),
}) => {
    const receiptNumber = buildReceiptNumber({ subscriptionId, paymentId });
    const paidDate = new Date(paidAt);
    return {
        receiptNumber,
        companyName,
        customerName,
        customerEmail,
        planName,
        paymentId,
        orderId,
        amountUsd: Number(amountUsd || 0),
        amountInr: Number(Number(amountInr || 0).toFixed(2)),
        currency: String(currency || "INR").toUpperCase(),
        couponCode: String(couponCode || "")
            .trim()
            .toUpperCase(),
        renewDate,
        subscriptionId: String(subscriptionId || ""),
        paidAt: paidDate.toISOString(),
        paidAtLabel: paidDate.toLocaleString("en-IN", { hour12: true }),
    };
};

const buildReceiptEmailHtml = (receipt) => `
  <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f4f7fa;padding:40px 20px;color:#1a202c">
    <div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);border:1px solid #e2e8f0">
      <div style="background-color:#4f46e5;padding:32px;text-align:center">
        <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px">Payment Successful!</h1>
        <p style="color:rgba(255,255,255,0.9);margin:8px 0 0;font-size:16px">Thank you for choosing NeoApp</p>
      </div>
      <div style="padding:32px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #edf2f7">
            <h2 style="margin:0;font-size:18px;font-weight:700">Receipt Details</h2>
            <span style="background-color:#ebf4ff;color:#4f46e5;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700">PAID</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:10px 0;color:#718096;font-size:14px">Receipt Number</td><td style="padding:10px 0;text-align:right;font-weight:700;color:#2d3748">${receipt.receiptNumber}</td></tr>
          <tr><td style="padding:10px 0;color:#718096;font-size:14px">Selected Plan</td><td style="padding:10px 0;text-align:right;font-weight:600;color:#2d3748">${receipt.planName}</td></tr>
          <tr><td style="padding:10px 0;color:#718096;font-size:14px">Amount Paid</td><td style="padding:10px 0;text-align:right;font-weight:800;color:#4f46e5;font-size:18px">INR ${receipt.amountInr.toFixed(2)}${receipt.amountUsd ? `<br/><span style="font-size:12px;color:#718096;font-weight:400">/ USD ${receipt.amountUsd.toFixed(2)}</span>` : ""}</td></tr>
          <tr><td style="padding:10px 0;color:#718096;font-size:14px">Payment Reference</td><td style="padding:10px 0;text-align:right;color:#2d3748;font-size:13px;word-break:break-all">${receipt.paymentId || receipt.orderId || "-"}</td></tr>
          <tr><td style="padding:10px 0;color:#718096;font-size:14px">Transaction Date</td><td style="padding:10px 0;text-align:right;color:#2d3748">${receipt.paidAtLabel}</td></tr>
          <tr><td style="padding:10px 0;color:#718096;font-size:14px">Renewal Date</td><td style="padding:10px 0;text-align:right;color:#2d3748;font-weight:600">${receipt.renewDate ? new Date(receipt.renewDate).toLocaleDateString() : "Lifetime"}</td></tr>
        </table>
        <div style="margin-top:32px;padding-top:24px;border-top:1px solid #edf2f7;text-align:center">
          <p style="margin:0;font-size:14px;color:#718096">Need help? Contact our support team at info@neophrontech.com</p>
        </div>
      </div>
      <div style="background-color:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#a0aec0">
        &copy; ${new Date().getFullYear()} NeoApp by Neophron. All rights reserved.
      </div>
    </div>
  </div>
`;

const buildReceiptEmailText = (receipt) =>
    [
        "NeoApp Payment Receipt",
        `Receipt No: ${receipt.receiptNumber}`,
        `Plan: ${receipt.planName}`,
        `Amount: INR ${receipt.amountInr.toFixed(2)}${receipt.amountUsd ? ` / USD ${receipt.amountUsd.toFixed(2)}` : ""}`,
        `Payment ID: ${receipt.paymentId}`,
        `Order ID: ${receipt.orderId}`,
        `Paid On: ${receipt.paidAtLabel}`,
        `Renew Date: ${receipt.renewDate ? new Date(receipt.renewDate).toLocaleDateString() : "-"}`,
        `Coupon: ${receipt.couponCode || "-"}`,
    ].join("\n");

const sendPlanReceiptEmail = async ({ user, receipt }) => {
    const to = String(user?.email || "")
        .trim()
        .toLowerCase();
    if (!to) return false;
    try {
        return await sendEmail({
            to,
            subject: `NeoApp receipt ${receipt.receiptNumber}`,
            text: buildReceiptEmailText(receipt),
            html: buildReceiptEmailHtml(receipt),
        });
    } catch (err) {
        return false;
    }
};

const isAdminRole = (role) => ["admin", "Admin"].includes(String(role || ""));

const resolvePublicBaseUrl = (req) => {
    const explicitBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim();
    if (explicitBaseUrl) {
        return explicitBaseUrl.replace(/\/+$/, "");
    }
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim();
    const protocol = forwardedProto || req.protocol || "https";
    return `${protocol}://${req.get("host")}`;
};

const buildPublicFormUrl = (req, slug) => {
    return `${resolvePublicBaseUrl(req)}/public/forms/${encodeURIComponent(String(slug || "").trim())}`;
};

const ensureCompanyPublicForm = async (companyId) => {
    if (!companyId) return null;
    const company = await Company.findById(companyId)
        .select("name status publicForm")
        .exec();
    if (!company) return null;

    if (
        !company.publicForm?.slug ||
        !company.publicForm?.token ||
        !company.publicForm?.title
    ) {
        company.markModified("publicForm");
        await company.save();
    }

    return company;
};

const computeDiscount = (price, coupon) => {
    if (!coupon) return { discountAmount: 0, finalPrice: price };
    const safeValue = Number(coupon.discountValue || 0);
    if (!Number.isFinite(safeValue) || safeValue <= 0) {
        return { discountAmount: 0, finalPrice: price };
    }
    let discountAmount = 0;
    if (coupon.discountType === "percentage") {
        discountAmount = (price * safeValue) / 100;
    } else {
        discountAmount = safeValue;
    }
    if (discountAmount > price) discountAmount = price;
    const finalPrice = Math.max(0, Number((price - discountAmount).toFixed(2)));
    return { discountAmount: Number(discountAmount.toFixed(2)), finalPrice };
};

const getCouponLimits = (coupon) => ({
    globalLimit: Number(coupon?.globalUsageLimit || coupon?.usageLimit || 1),
    perCompanyLimit: Number(coupon?.perCompanyUsageLimit || 1),
});

const getCompanyCouponUsedCount = (coupon, companyId) => {
    const map = coupon?.companyUsageMap || {};
    if (typeof map.get === "function")
        return Number(map.get(String(companyId)) || 0);
    return Number(map[String(companyId)] || 0);
};

const isCompanyOnProPlan = async (companyId) => {
    if (!companyId) return false;
    const resolved = await resolveEffectivePlan(companyId);
    return String(resolved?.plan?.code || "").toUpperCase() === "PRO";
};

const toWholeNumber = (value, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return Math.max(0, Number(fallback || 0));
    return Math.floor(n);
};

const buildSeatPricing = ({
    plan,
    override,
    requestedAdmins = 0,
    requestedStaff = 0,
}) => {
    const includedAdmins = toWholeNumber(plan?.maxAdmins, 1);
    const includedStaff =
        override && typeof override?.customMaxStaff === "number"
            ? toWholeNumber(override.customMaxStaff, plan?.maxStaff)
            : toWholeNumber(plan?.maxStaff, 0);

    const allocatedAdmins = Math.max(
        includedAdmins,
        toWholeNumber(requestedAdmins, includedAdmins),
    );
    const allocatedStaff = Math.max(
        includedStaff,
        toWholeNumber(requestedStaff, includedStaff),
    );

    const extraAdminsPurchased = Math.max(0, allocatedAdmins - includedAdmins);
    const extraStaffPurchased = Math.max(0, allocatedStaff - includedStaff);

    const extraAdminPrice = Number(plan?.extraAdminPrice || 0);
    const extraStaffPrice = Number(plan?.extraStaffPrice || 0);
    const extraAdminsAmount = Number(
        (extraAdminsPurchased * extraAdminPrice).toFixed(2),
    );
    const extraStaffAmount = Number(
        (extraStaffPurchased * extraStaffPrice).toFixed(2),
    );

    return {
        includedAdmins,
        includedStaff,
        allocatedAdmins,
        allocatedStaff,
        extraAdminsPurchased,
        extraStaffPurchased,
        extraAdminPrice,
        extraStaffPrice,
        extraAdminsAmount,
        extraStaffAmount,
    };
};

const getActiveOverrideForPlan = async (companyId, planId) => {
    const override = await CompanyPlanOverride.findOne({ companyId }).lean();
    if (!override || override.isActive === false) return null;

    const now = new Date();
    const endOfExpiryDay = override.customExpiry
        ? new Date(override.customExpiry)
        : null;
    if (endOfExpiryDay) endOfExpiryDay.setHours(23, 59, 59, 999);
    if (endOfExpiryDay && endOfExpiryDay <= now) return null;

    const targetPlanId = override.targetPlanId
        ? String(override.targetPlanId)
        : null;
    if (targetPlanId && String(planId) !== targetPlanId) return null;

    return override;
};

const validateCouponForPlan = async ({ couponCode, companyId, planId }) => {
    if (!couponCode) return null;

    if (await isCompanyOnProPlan(companyId)) {
        throw new Error("Coupons are not available for Pro plan companies");
    }

    const normalizedCode = String(couponCode).trim().toUpperCase();
    console.log("[CouponValidation] request", {
        companyId: String(companyId),
        planId: String(planId),
        couponCode: normalizedCode,
    });

    const coupon = await Coupon.findOne({ code: normalizedCode }).lean();
    if (!coupon) {
        console.log("[CouponValidation] failed: coupon not found");
        throw new Error("Invalid coupon code");
    }
    if (!coupon.isActive) {
        console.log("[CouponValidation] failed: coupon inactive");
        throw new Error("Coupon is not active");
    }
    const { globalLimit, perCompanyLimit } = getCouponLimits(coupon);
    const companyUsed = getCompanyCouponUsedCount(coupon, companyId);
    if (coupon.usedCount >= globalLimit) {
        console.log("[CouponValidation] failed: global usage limit reached", {
            usedCount: coupon.usedCount,
            globalLimit,
        });
        throw new Error("Coupon global usage limit reached");
    }
    if (companyUsed >= perCompanyLimit) {
        console.log("[CouponValidation] failed: company usage limit reached", {
            companyId: String(companyId),
            companyUsed,
            perCompanyLimit,
        });
        throw new Error("Coupon usage exhausted for this company");
    }
    const couponExpiryEnd = coupon.expiryDate
        ? new Date(coupon.expiryDate)
        : null;
    if (couponExpiryEnd) couponExpiryEnd.setHours(23, 59, 59, 999);
    if (couponExpiryEnd && couponExpiryEnd <= new Date()) {
        console.log("[CouponValidation] failed: expired", {
            expiryDate: coupon.expiryDate,
            expiryEnd: couponExpiryEnd,
        });
        throw new Error("Coupon expired");
    }
    if (
        !Number.isFinite(Number(coupon.discountValue)) ||
        Number(coupon.discountValue) <= 0
    ) {
        console.log("[CouponValidation] failed: invalid discount value", {
            discountValue: coupon.discountValue,
        });
        throw new Error("Coupon has no discount value");
    }

    if (
        coupon.applicablePlans?.length &&
        !coupon.applicablePlans.some((id) => id.toString() === String(planId))
    ) {
        console.log("[CouponValidation] failed: plan not applicable", {
            applicablePlans: coupon.applicablePlans.map((id) => id.toString()),
        });
        throw new Error("Coupon not applicable to selected plan");
    }

    if (
        !coupon.appliesToAllCompanies &&
        coupon.applicableCompanies?.length &&
        !coupon.applicableCompanies.some(
            (id) => id.toString() === String(companyId),
        )
    ) {
        console.log("[CouponValidation] failed: company not applicable", {
            applicableCompanies: coupon.applicableCompanies.map((id) =>
                id.toString(),
            ),
        });
        throw new Error("Coupon not applicable to your company");
    }

    console.log("[CouponValidation] success", {
        couponId: String(coupon._id),
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        globalLimit,
        perCompanyLimit,
        companyUsed,
    });
    return coupon;
};

const buildCheckoutSummary = async ({
    companyId,
    planId,
    couponCode = "",
    requestedAdmins = 0,
    requestedStaff = 0,
}) => {
    const plan = await Plan.findOne({ _id: planId, isActive: true }).lean();
    if (!plan) throw new Error("Selected plan is not available");

    const override = await getActiveOverrideForPlan(companyId, plan._id);
    const basePrice =
        override && typeof override.customPrice === "number"
            ? override.customPrice
            : plan.basePrice;
    const trialDays =
        override && typeof override.customTrialDays === "number"
            ? override.customTrialDays
            : plan.trialDays;
    const seatPricing = buildSeatPricing({
        plan,
        override,
        requestedAdmins,
        requestedStaff,
    });
    const originalPrice = Number(
        (
            Number(basePrice || 0) +
            seatPricing.extraAdminsAmount +
            seatPricing.extraStaffAmount
        ).toFixed(2),
    );

    const coupon = await validateCouponForPlan({
        couponCode,
        companyId,
        planId: plan._id,
    });

    const { discountAmount, finalPrice } = computeDiscount(
        originalPrice,
        coupon,
    );
    const renewDate = new Date();
    renewDate.setDate(renewDate.getDate() + (typeof trialDays === 'number' ? trialDays : 30));

    return {
        plan,
        override,
        coupon,
        originalPrice,
        discountAmount,
        finalPrice,
        trialDays,
        ...seatPricing,
        renewDate,
    };
};

const activateSubscription = async ({
    companyId,
    userId,
    ip,
    summary,
    paymentReference = "",
    provider = "manual",
    paymentMeta = {},
}) => {
    await CompanySubscription.updateMany(
        { companyId, status: { $in: ["Active", "Trial"] } },
        { $set: { status: "Cancelled" } },
    );

    const subscription = await CompanySubscription.create({
        companyId,
        planId: summary.plan._id,
        couponId: summary.coupon ? summary.coupon._id : null,
        status: "Active",
        startDate: new Date(),
        endDate: summary.renewDate,
        trialUsed: false,
        finalPrice: summary.finalPrice,
        allocatedAdmins: summary.allocatedAdmins,
        allocatedStaff: summary.allocatedStaff,
        extraAdminsPurchased: summary.extraAdminsPurchased,
        extraStaffPurchased: summary.extraStaffPurchased,
        extraAdminPrice: summary.extraAdminPrice,
        extraStaffPrice: summary.extraStaffPrice,
        notes: paymentReference
            ? `paymentReference:${paymentReference}`
            : `Plan purchased via ${provider}`,
    });

    clearCompanyPlanCache(companyId);

    if (summary.coupon) {
        const companyKey = String(companyId);
        await Coupon.findByIdAndUpdate(summary.coupon._id, {
            $inc: {
                usedCount: 1,
                [`companyUsageMap.${companyKey}`]: 1,
            },
        });
    }

    return subscription;
};

const emitSubscriptionUpdate = (req, payload) => {
    try {
        const io = req.app?.get("io");
        if (!io) return;

        const companyId = payload?.companyId ? String(payload.companyId) : "";
        const userId = payload?.userId ? String(payload.userId) : "";

        io.emit("SUBSCRIPTION_UPDATED", { ...payload, companyId, userId });
        if (userId) {
            io.to(`user:${userId}`).emit("SUBSCRIPTION_UPDATED", payload);
        }
    } catch (_socketError) {
        // ignore socket fanout errors
    }
};

const emitProfileUpdate = (req, payload) => {
    try {
        const io = req.app?.get("io");
        if (!io) return;

        const userId = String(
            payload?.id || payload?._id || payload?.userId || "",
        );
        if (!userId) return;

        io.to(`user:${userId}`).emit("PROFILE_UPDATED", payload);
    } catch (_socketError) {
        // ignore socket fanout errors
    }
};

const isPrimaryCompanyAdmin = async (user) => {
    const role = String(user?.role || "").toLowerCase();
    if (role !== "admin") return false;
    if (!user?.company_id) return false;

    const primaryAdmin = await User.findOne({
        company_id: user.company_id,
        role: { $in: ["Admin", "admin"] },
    })
        .sort({ createdAt: 1, _id: 1 })
        .select("_id")
        .lean();

    return Boolean(
        primaryAdmin?._id &&
        String(primaryAdmin._id) === String(user?._id || ""),
    );
};

// 1. GET PROFILE
router.get("/profile", verifyToken, async (req, res) => {
    try {
        const userDoc = await User.findById(req.userId).lean();
        if (!userDoc) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        const { password, ...user } = userDoc;
        user.hasPassword = Boolean(password);
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. UPDATE BASIC PROFILE (Name, Logo)
router.put(
    "/profile",
    verifyToken,
    profileUpload.single("logo"),
    async (req, res) => {
        try {
            const existingUser = await User.findById(req.userId)
                .select("logo")
                .lean();
            const name = String(req.body.name || "").trim();
            const mobile = req.body.mobile !== undefined ? String(req.body.mobile || "").trim() : undefined;
            const bodyLogo =
                typeof req.body.logo === "string" ? req.body.logo.trim() : "";
            const clearLogo =
                String(req.body.clearLogo || "").trim() === "true";
            const uploadedLogo = req.file
                ? `/uploads/profile/${req.file.filename}`
                : "";
            const logo = clearLogo
                ? ""
                : uploadedLogo || bodyLogo || existingUser?.logo || "";

            const updateFields = { name, logo, updatedAt: new Date() };
            if (mobile !== undefined) {
                updateFields.mobile = mobile;
            }

            const user = await User.findByIdAndUpdate(
                req.userId,
                { $set: updateFields },
                { returnDocument: "after", runValidators: true },
            ).select("-password");

            if (user) {
                clearUserCache(req.userId);
                cache.invalidate("dashboard");
                cache.invalidate("enquiries");
                cache.invalidate("followups");
                emitProfileUpdate(req, {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    mobile: user.mobile,
                    logo: user.logo || "",
                    role: user.role,
                    status: user.status,
                    company_id: user.company_id,
                    updatedAt: user.updatedAt,
                });
            }

            res.json({ success: true, message: "Profile updated", user });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    },
);

// 2b. UPDATE NOTIFICATION PREFERENCES (voiceLang)
router.put("/profile/notification-preferences", verifyToken, async (req, res) => {
    try {
        const { voiceLang } = req.body;
        if (!voiceLang || !["en", "ta"].includes(voiceLang)) {
            return res.status(400).json({ success: false, message: "Invalid voiceLang" });
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            {
                $set: {
                    "notificationPreferences.voiceLang": voiceLang,
                    "notificationPreferences.updatedAt": new Date(),
                    updatedAt: new Date()
                }
            },
            { returnDocument: "after", runValidators: true },
        ).select("-password");

        if (user) {
            clearUserCache(req.userId);
            emitProfileUpdate(req, {
                id: user._id,
                notificationPreferences: user.notificationPreferences,
                updatedAt: user.updatedAt,
            });
        }

        res.json({ success: true, message: "Notification preferences updated", user });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2c. UPDATE PASSWORD (Set or Change) - STEP 1: Initiate & Send Email OTP
router.post("/profile/update-password/initiate", verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const otp = generateOTP();
        otpStore[`password_change_${req.userId}`] = {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        };

        if (EXPOSE_TEST_OTP) {
            console.log(`[Profile] Password change OTP for ${user.email}: ${otp}`);
        }

        const sentVia = [];
        const tasks = [];

        if (user.email) {
            tasks.push(
                sendEmailOTP(user.email, otp).then((ok) => {
                    if (ok) sentVia.push("email");
                }),
            );
        }

        if (user.mobile) {
            tasks.push(
                sendMobileOTP(user.mobile, otp, { method: "whatsapp" }).then((ok) => {
                    if (ok) sentVia.push("whatsapp");
                }),
            );
        }

        await Promise.allSettled(tasks);

        if (sentVia.length === 0) {
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP via email or WhatsApp. Please try again later.",
            });
        }

        const channelLabel = sentVia.includes("email") && sentVia.includes("whatsapp")
            ? "your Gmail and WhatsApp"
            : sentVia.includes("whatsapp")
            ? "your WhatsApp"
            : "your Gmail";

        res.json({
            success: true,
            message: `Verification OTP sent to ${channelLabel}`,
        });
    } catch (err) {
        console.error("Initiate password update error:", err);
        res.status(500).json({ success: false, message: err.message || "Internal server error" });
    }
});

// 2d. UPDATE PASSWORD - STEP 2: Verify OTP & Change
router.put("/profile/update-password", verifyToken, async (req, res) => {
    try {
        const { oldPassword, newPassword, otp } = req.body;
        const user = await User.findById(req.userId).select("password googleId");

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Verify OTP first
        const record = otpStore[`password_change_${req.userId}`];
        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
        }

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ success: false, message: "New password must be at least 8 characters" });
        }

        const isGoogleUser = Boolean(user.googleId);

        if (oldPassword) {
            const isMatch = await require("bcryptjs").compare(oldPassword, user.password);
            if (!isMatch) {
                return res.status(401).json({ success: false, message: "Incorrect current password" });
            }
        } else if (!isGoogleUser) {
            // Non-Google users MUST provide old password
            return res.status(400).json({ success: false, message: "Current password is required" });
        }

        // Clean up OTP store
        delete otpStore[`password_change_${req.userId}`];

        // Update password
        const salt = await require("bcryptjs").genSalt(10);
        user.password = await require("bcryptjs").hash(newPassword, salt);
        user.updatedAt = new Date();
        await user.save();

        res.json({ success: true, message: "Password updated successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/company/public-form", verifyToken, async (req, res) => {
    try {
        const companyId = req.user?.company_id || null;
        if (!companyId) {
            return res
                .status(400)
                .json({ success: false, message: "Company not set for user" });
        }

        const company = await ensureCompanyPublicForm(companyId);
        if (!company) {
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        }

        return res.json({
            success: true,
            publicForm: {
                enabled: company.publicForm?.enabled !== false,
                slug: company.publicForm?.slug || "",
                title:
                    company.publicForm?.title || `${company.name} Enquiry Form`,
                description:
                    company.publicForm?.description ||
                    "Fill out this form and our team will contact you shortly.",
                defaultSource:
                    company.publicForm?.defaultSource || "Public Form",
                successMessage:
                    company.publicForm?.successMessage ||
                    "Thanks for your enquiry. Our team will contact you soon.",
                url: buildPublicFormUrl(req, company.publicForm?.slug || ""),
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/company/public-form", verifyToken, async (req, res) => {
    try {
        if (!isAdminRole(req.user?.role)) {
            return res.status(403).json({
                success: false,
                message: "Only admin users can update the public enquiry form",
            });
        }

        const companyId = req.user?.company_id || null;
        if (!companyId) {
            return res
                .status(400)
                .json({ success: false, message: "Company not set for user" });
        }

        const company = await ensureCompanyPublicForm(companyId);
        if (!company) {
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        }

        company.publicForm = {
            ...(company.publicForm?.toObject
                ? company.publicForm.toObject()
                : company.publicForm || {}),
            enabled: req.body?.enabled !== false,
            title:
                String(req.body?.title || "")
                    .trim()
                    .slice(0, 100) || `${company.name} Enquiry Form`,
            description:
                String(req.body?.description || "")
                    .trim()
                    .slice(0, 240) ||
                "Fill out this form and our team will contact you shortly.",
            defaultSource:
                String(req.body?.defaultSource || "")
                    .trim()
                    .slice(0, 80) || "Public Form",
            successMessage:
                String(req.body?.successMessage || "")
                    .trim()
                    .slice(0, 200) ||
                "Thanks for your enquiry. Our team will contact you soon.",
        };

        company.markModified("publicForm");
        await company.save();

        return res.json({
            success: true,
            message: "Public enquiry form updated",
            publicForm: {
                enabled: company.publicForm?.enabled !== false,
                slug: company.publicForm?.slug || "",
                title:
                    company.publicForm?.title || `${company.name} Enquiry Form`,
                description: company.publicForm?.description || "",
                defaultSource:
                    company.publicForm?.defaultSource || "Public Form",
                successMessage:
                    company.publicForm?.successMessage ||
                    "Thanks for your enquiry. Our team will contact you soon.",
                url: buildPublicFormUrl(req, company.publicForm?.slug || ""),
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/company/whatsapp-template", verifyToken, async (req, res) => {
    try {
        const companyId = req.user?.company_id || null;
        if (!companyId) {
            return res
                .status(400)
                .json({ success: false, message: "Company not set for user" });
        }

        const company = await Company.findById(companyId).select("name status whatsappTemplate").lean();
        if (!company) {
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        }

        let maskedToken = "";
        const rawToken = company.whatsappTemplate?.token || "";
        if (rawToken) {
            let decryptedToken = rawToken;
            if (rawToken.includes(":")) {
                const { decrypt } = require("../utils/crypto");
                decryptedToken = decrypt(rawToken) || rawToken;
            }
            maskedToken = decryptedToken.length <= 6 ? "****" : `****${decryptedToken.slice(-6)}`;
        }

        return res.json({
            success: true,
            whatsappTemplate: {
                enabled: company.whatsappTemplate?.enabled === true,
                url: company.whatsappTemplate?.url || "",
                token: maskedToken,
                name: company.whatsappTemplate?.name || "",
                language: company.whatsappTemplate?.language || "en",
                buttonIndex: typeof company.whatsappTemplate?.buttonIndex === "number" ? company.whatsappTemplate.buttonIndex : 0,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/company/whatsapp-template", verifyToken, async (req, res) => {
    try {
        if (!isAdminRole(req.user?.role)) {
            return res.status(403).json({
                success: false,
                message: "Only admin users can update the whatsapp template settings",
            });
        }

        const companyId = req.user?.company_id || null;
        if (!companyId) {
            return res
                .status(400)
                .json({ success: false, message: "Company not set for user" });
        }

        const company = await Company.findById(companyId);
        if (!company) {
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        }

        const reqToken = String(req.body?.token || "").trim().slice(0, 500);
        let finalToken = company.whatsappTemplate?.token || "";
        if (reqToken && !reqToken.startsWith("****")) {
            const { encrypt } = require("../utils/crypto");
            finalToken = encrypt(reqToken);
        } else if (!reqToken) {
            finalToken = "";
        }

        company.whatsappTemplate = {
            enabled: req.body?.enabled === true,
            url: String(req.body?.url || "").trim().slice(0, 500),
            token: finalToken,
            name: String(req.body?.name || "").trim().slice(0, 100),
            language: String(req.body?.language || "en").trim().slice(0, 10),
            buttonIndex: typeof req.body?.buttonIndex === "number" ? req.body.buttonIndex : 0,
        };

        company.markModified("whatsappTemplate");
        await company.save();

        return res.json({
            success: true,
            message: "WhatsApp Template settings updated",
            whatsappTemplate: company.whatsappTemplate,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/company/account/disable", verifyToken, async (req, res) => {
    try {
        const actor = await User.findById(req.userId)
            .select("_id role company_id")
            .lean();

        if (!actor?.company_id) {
            return res.status(400).json({
                success: false,
                message: "No company linked to this account",
            });
        }

        const allowed = await isPrimaryCompanyAdmin(actor);
        if (!allowed) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the primary admin can disable this company account",
            });
        }

        const companyId = actor.company_id;
        const updated = await Company.findByIdAndUpdate(
            companyId,
            { $set: { status: "Suspended" } },
            { returnDocument: "after", runValidators: true },
        ).select("_id name code status");

        if (!updated) {
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        }

        clearCompanyCache(companyId);

        try {
            const io = req.app?.get?.("io");
            if (io) {
                const companyUsers = await User.find({ company_id: companyId })
                    .select("_id")
                    .lean();

                companyUsers.forEach((entry) => {
                    const userId =
                        entry?._id?.toString?.() || String(entry?._id || "");
                    if (!userId) return;

                    io.to(`user:${userId}`).emit("COMPANY_STATUS_CHANGED", {
                        companyId: String(companyId),
                        status: "Suspended",
                        at: new Date().toISOString(),
                    });

                    io.to(`user:${userId}`).emit("FORCE_LOGOUT", {
                        reason: "Company is suspended",
                        companyId: String(companyId),
                        companyStatus: "Suspended",
                        at: new Date().toISOString(),
                    });
                });
            }
        } catch (_socketError) {
            // ignore socket fanout failures
        }

        return res.json({
            success: true,
            message: "Company account disabled successfully",
            company: {
                id: String(updated._id),
                name: updated.name || "",
                code: updated.code || "",
                status: updated.status || "Suspended",
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.delete("/company/account", verifyToken, async (req, res) => {
    try {
        const actor = await User.findById(req.userId)
            .select("_id role company_id")
            .lean();

        if (!actor?.company_id) {
            return res.status(400).json({
                success: false,
                message: "No company linked to this account",
            });
        }

        const allowed = await isPrimaryCompanyAdmin(actor);
        if (!allowed) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the primary admin can permanently delete this company account",
            });
        }

        const companyId = actor.company_id;
        const company = await Company.findById(companyId)
            .select("_id name code")
            .lean();
        if (!company) {
            return res
                .status(404)
                .json({ success: false, message: "Company not found" });
        }

        const companyUsers = await User.find({ company_id: companyId })
            .select("_id")
            .lean();
        const companyUserIds = companyUsers.map((entry) => entry._id);

        try {
            const io = req.app?.get?.("io");
            if (io) {
                companyUserIds.forEach((userId) => {
                    const safeUserId = String(userId || "");
                    if (!safeUserId) return;
                    io.to(`user:${safeUserId}`).emit("FORCE_LOGOUT", {
                        reason: "Company account deleted permanently",
                        companyId: String(companyId),
                        companyStatus: "Deleted",
                        at: new Date().toISOString(),
                    });
                });
            }
        } catch (_socketError) {
            // ignore socket fanout errors
        }

        await Promise.all([
            Enquiry.deleteMany({
                $or: [
                    { userId: { $in: companyUserIds } },
                    { assignedTo: { $in: companyUserIds } },
                ],
            }),
            FollowUp.deleteMany({
                $or: [
                    { userId: { $in: companyUserIds } },
                    { assignedTo: { $in: companyUserIds } },
                ],
            }),
            ChatMessage.deleteMany({ userId: { $in: companyUserIds } }),
            CommunicationMessage.deleteMany({ companyId }),
            CommunicationTask.deleteMany({ companyId }),
            EmailSettings.deleteMany({ companyId }),
            EmailTemplate.deleteMany({ companyId }),
            EmailLog.deleteMany({ companyId }),
            MessageTemplate.deleteMany({ userId: { $in: companyUserIds } }),
            LeadSource.deleteMany({ createdBy: { $in: companyUserIds } }),
            Product.deleteMany({ createdBy: { $in: companyUserIds } }),
            Payment.deleteMany({ companyId }),
            Subscription.deleteMany({ companyId }),
            CompanySubscription.deleteMany({ companyId }),
            CompanyPlanOverride.deleteMany({ companyId }),
            SupportTicket.deleteMany({ companyId }),
            Target.deleteMany({ company_id: companyId }),
            WhatsAppConfig.deleteMany({ companyId }),
            User.deleteMany({ _id: { $in: companyUserIds } }),
        ]);
        await Company.deleteOne({ _id: companyId });

        companyUserIds.forEach((userId) => clearUserCache(userId));
        clearCompanyCache(companyId);
        clearCompanyPlanCache(companyId);
        cache.invalidate("dashboard");
        cache.invalidate("enquiries");
        cache.invalidate("followups");

        return res.json({
            success: true,
            message: "Company account and related data permanently deleted",
            deletedCompany: {
                id: String(company._id),
                name: company.name || "",
                code: company.code || "",
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 3. EMAIL CHANGE - STEP 1: Verify current email
router.post("/email-change/initiate", verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        const otp = generateOTP();

        otpStore[`email_old_${req.userId}`] = {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000, // 10 mins
        };

        if (EXPOSE_TEST_OTP) {
            console.log(
                `[Profile] OTP for current email ${user.email}: ${otp}`,
            );
        }
        await sendEmailOTP(user.email, otp);

        res.json({ success: true, message: "OTP sent to your current email" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. EMAIL CHANGE - STEP 2: Verify OTP for Current Email
router.post("/email-change/verify-current", verifyToken, async (req, res) => {
    try {
        const { otp } = req.body;
        const record = otpStore[`email_old_${req.userId}`];

        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid or expired OTP" });
        }

        // Mark current email as verified for change
        otpStore[`email_old_verified_${req.userId}`] = true;
        delete otpStore[`email_old_${req.userId}`];

        res.json({
            success: true,
            message: "Current email verified. Please provide your new email.",
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. EMAIL CHANGE - STEP 3: Send OTP to NEW Email
router.post("/email-change/new-initiate", verifyToken, async (req, res) => {
    try {
        const { newEmail } = req.body;
        if (!otpStore[`email_old_verified_${req.userId}`]) {
            return res
                .status(403)
                .json({
                    success: false,
                    message: "Must verify current email first",
                });
        }

        // Scope email uniqueness to the user's company to enforce multi-tenant isolation
        const existing = await User.findOne({
            email: newEmail,
            company_id: req.user.company_id,
        });
        if (existing)
            return res.status(409).json({
                success: false,
                message: "Email already in use in your company",
            });

        const otp = generateOTP();
        otpStore[`email_new_${req.userId}`] = {
            otp,
            newEmail,
            expiresAt: Date.now() + 10 * 60 * 1000,
        };

        if (EXPOSE_TEST_OTP) {
            console.log(`[Profile] OTP for new email ${newEmail}: ${otp}`);
        }
        await sendEmailOTP(newEmail, otp);

        res.json({ success: true, message: "OTP sent to your new email" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. EMAIL CHANGE - STEP 4: Verify OTP for NEW Email & Update
router.post("/email-change/verify-new", verifyToken, async (req, res) => {
    try {
        const { otp } = req.body;
        const record = otpStore[`email_new_${req.userId}`];

        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid or expired OTP" });
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            { $set: { email: record.newEmail, updatedAt: new Date() } },
            { returnDocument: "after", runValidators: true },
        ).select("-password");

        if (user) {
            clearUserCache(req.userId);
            cache.invalidate("dashboard");
            cache.invalidate("enquiries");
            cache.invalidate("followups");
        }

        delete otpStore[`email_new_${req.userId}`];
        delete otpStore[`email_old_verified_${req.userId}`];

        res.json({
            success: true,
            message: "Email updated successfully",
            user,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- MOBILE CHANGE (Similar logic, though Firebase is preferred, user asked for OTP based change) ---

// 7. MOBILE CHANGE - STEP 1: Verify current mobile
router.post("/mobile-change/initiate", verifyToken, async (req, res) => {
    try {
        const requestedMethod = String(req.body?.method || "whatsapp")
            .toLowerCase()
            .trim();
        const user = await User.findById(req.userId);

        if (!user.mobile) {
            otpStore[`mobile_old_verified_${req.userId}`] = true;
            return res.json({ success: true, bypass: true, message: "No current mobile to verify. Proceed to new mobile." });
        }

        const otp = generateOTP();

        otpStore[`mobile_old_${req.userId}`] = {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000,
        };

        if (EXPOSE_TEST_OTP) {
            console.log(
                `[Profile] OTP for current mobile ${user.mobile}: ${otp}`,
            );
        }
        const ok = await sendMobileOTP(user.mobile, otp, {
            ownerUserId: req.userId,
            method: requestedMethod || "whatsapp",
        });
        if (!ok) {
            return res.status(500).json({
                success: false,
                message:
                    "Failed to send OTP to mobile. WhatsApp template or fallback channel is not configured.",
            });
        }

        res.json({ success: true, message: "OTP sent to your current mobile" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 8. MOBILE CHANGE - STEP 2: Verify current mobile OTP
router.post("/mobile-change/verify-current", verifyToken, async (req, res) => {
    try {
        const { otp } = req.body;
        const record = otpStore[`mobile_old_${req.userId}`];

        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid or expired OTP" });
        }

        otpStore[`mobile_old_verified_${req.userId}`] = true;
        delete otpStore[`mobile_old_${req.userId}`];

        res.json({
            success: true,
            message:
                "Current mobile verified. Please provide your new mobile number.",
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 9. MOBILE CHANGE - STEP 3: Send OTP to NEW Mobile
router.post("/mobile-change/new-initiate", verifyToken, async (req, res) => {
    try {
        const { newMobile } = req.body;
        const requestedMethod = String(req.body?.method || "whatsapp")
            .toLowerCase()
            .trim();
        if (!otpStore[`mobile_old_verified_${req.userId}`]) {
            return res
                .status(403)
                .json({
                    success: false,
                    message: "Must verify current mobile first",
                });
        }

        // Scope mobile uniqueness to the user's company
        const existing = await User.findOne({
            mobile: newMobile,
            company_id: req.user.company_id,
        });
        if (existing)
            return res.status(409).json({
                success: false,
                message: "Mobile number already in use in your company",
            });

        const otp = generateOTP();
        otpStore[`mobile_new_${req.userId}`] = {
            otp,
            newMobile,
            expiresAt: Date.now() + 10 * 60 * 1000,
        };

        if (EXPOSE_TEST_OTP) {
            console.log(`[Profile] OTP for new mobile ${newMobile}: ${otp}`);
        }
        const ok = await sendMobileOTP(newMobile, otp, {
            ownerUserId: req.userId,
            method: requestedMethod || "whatsapp",
        });
        if (!ok) {
            return res.status(500).json({
                success: false,
                message:
                    "Failed to send OTP to new mobile. WhatsApp template or fallback channel is not configured.",
            });
        }

        res.json({ success: true, message: "OTP sent to your new mobile" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 10. MOBILE CHANGE - STEP 4: Verify NEW mobile OTP & Update
router.post("/mobile-change/verify-new", verifyToken, async (req, res) => {
    try {
        const { otp } = req.body;
        const record = otpStore[`mobile_new_${req.userId}`];

        if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid or expired OTP" });
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            { $set: { mobile: record.newMobile, updatedAt: new Date() } },
            { returnDocument: "after", runValidators: true },
        ).select("-password");

        if (user) {
            clearUserCache(req.userId);
            cache.invalidate("dashboard");
            cache.invalidate("enquiries");
            cache.invalidate("followups");
        }

        delete otpStore[`mobile_new_${req.userId}`];
        delete otpStore[`mobile_old_verified_${req.userId}`];

        res.json({
            success: true,
            message: "Mobile number updated successfully",
            user,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 11. GET EFFECTIVE PLAN (Resolved from plan + override + coupon)
router.get("/billing/effective-plan", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const resolved = await resolveEffectivePlan(
            req.user.company_id.toString(),
        );
        if (!resolved.hasPlan) {
            return res
                .status(404)
                .json({
                    success: false,
                    message: resolved.reason || "No active subscription",
                });
        }

        // Return only effective plan data required by client app
        return res.json({
            success: true,
            plan: resolved.plan,
            subscription: resolved.subscription,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 12. GET BILLING PLANS (Active plans for app pricing screen)
router.get("/billing/plans", verifyToken, async (req, res) => {
    try {
        const syncResult = await ensureFixedPlansSynced();
        syncResult.impactedCompanyIds.forEach((companyId) => {
            clearCompanyPlanCache(companyId);
        });

        const plansRaw = await Plan.find({
            isActive: true,
            code: { $in: ["FREE", "BASIC", "PRO"] },
        })
            .select(
                "code name basePrice extraAdminPrice extraStaffPrice trialDays maxAdmins maxStaff features",
            )
            .sort({ sortOrder: 1, createdAt: 1 })
            .lean();

        let plans = plansRaw;
        if (req.user?.company_id) {
            const override = await CompanyPlanOverride.findOne({
                companyId: req.user.company_id,
            }).lean();
            const now = new Date();
            const endOfExpiryDay = override?.customExpiry
                ? new Date(override.customExpiry)
                : null;
            if (endOfExpiryDay) {
                endOfExpiryDay.setHours(23, 59, 59, 999);
            }
            const overrideActive = Boolean(
                override &&
                override.isActive !== false &&
                (!endOfExpiryDay || endOfExpiryDay > now),
            );
            if (overrideActive) {
                const targetPlanId = override.targetPlanId
                    ? String(override.targetPlanId)
                    : null;
                plans = plansRaw.map((plan) => {
                    const match =
                        !targetPlanId || String(plan._id) === targetPlanId;
                    if (!match) return { ...plan, isOverrideApplied: false };

                    return {
                        ...plan,
                        basePrice:
                            typeof override.customPrice === "number"
                                ? override.customPrice
                                : plan.basePrice,
                        maxStaff:
                            typeof override.customMaxStaff === "number"
                                ? override.customMaxStaff
                                : plan.maxStaff,
                        trialDays:
                            typeof override.customTrialDays === "number"
                                ? override.customTrialDays
                                : plan.trialDays,
                        isOverrideApplied: Boolean(
                            typeof override.customPrice === "number" ||
                            typeof override.customMaxStaff === "number" ||
                            typeof override.customTrialDays === "number",
                        ),
                    };
                });
            } else {
                plans = plansRaw.map((plan) => ({
                    ...plan,
                    isOverrideApplied: false,
                }));
            }
        }

        plans = plans.map((plan) => normalizePlanForClient(plan));

        let effectivePlan = null;
        if (req.user?.company_id) {
            const resolved = await resolveEffectivePlan(
                req.user.company_id.toString(),
            );
            if (resolved?.hasPlan)
                effectivePlan = normalizePlanForClient(resolved.plan);
        }

        if (effectivePlan && String(effectivePlan.code).toUpperCase() === "PRO") {
            plans = plans.filter(p => String(p.code).toUpperCase() !== "FREE");
        }

        const usdInr = await getUsdInrRate();
        return res.json({
            success: true,
            plans,
            effectivePlan,
            rates: { USD_INR: usdInr },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 13. CHECKOUT PREVIEW (plan + coupon validation and final amount)
router.post("/billing/checkout/preview", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const {
            planId,
            couponCode = "",
            adminCount = 0,
            staffCount = 0,
        } = req.body || {};
        if (!planId) {
            return res
                .status(400)
                .json({ success: false, message: "planId is required" });
        }

        const plan = await Plan.findById(planId).lean();
        if (!plan || !plan.isActive) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid plan" });
        }

        if (isEnterprisePlan(plan)) {
            return res.json({
                success: true,
                requiresContact: true,
                plan: {
                    id: plan._id,
                    code: plan.code,
                    name: plan.name,
                    maxAdmins: plan.maxAdmins,
                    maxStaff: plan.maxStaff,
                    billingCycle: "Contact Sales",
                },
            });
        }

        const summary = await buildCheckoutSummary({
            companyId: req.user.company_id,
            planId,
            couponCode,
            requestedAdmins: adminCount,
            requestedStaff: staffCount,
        });

        return res.json({
            success: true,
            requiresContact: false,
            plan: {
                id: summary.plan._id,
                code: summary.plan.code,
                name: summary.plan.name,
                maxAdmins: summary.allocatedAdmins,
                maxStaff: summary.allocatedStaff,
                includedAdmins: summary.includedAdmins,
                includedStaff: summary.includedStaff,
                extraAdminPrice: summary.extraAdminPrice,
                extraStaffPrice: summary.extraStaffPrice,
                billingCycle: "Monthly",
            },
            pricing: {
                originalPrice: summary.originalPrice,
                basePrice: Number(summary.plan.basePrice || 0),
                extraAdminsAmount: summary.extraAdminsAmount,
                extraStaffAmount: summary.extraStaffAmount,
                discountAmount: summary.discountAmount,
                finalPrice: summary.finalPrice,
            },
            allocation: {
                adminCount: summary.allocatedAdmins,
                staffCount: summary.allocatedStaff,
                extraAdminsPurchased: summary.extraAdminsPurchased,
                extraStaffPurchased: summary.extraStaffPurchased,
            },
            coupon: summary.coupon
                ? {
                    code: summary.coupon.code,
                    discountType: summary.coupon.discountType,
                    discountValue: summary.coupon.discountValue,
                }
                : null,
            renewDate: summary.renewDate,
        });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
});

// 14. RAZORPAY: CREATE ORDER
router.post("/billing/razorpay/order", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const {
            planId,
            couponCode = "",
            adminCount = 0,
            staffCount = 0,
        } = req.body || {};
        if (!planId) {
            return res
                .status(400)
                .json({ success: false, message: "planId is required" });
        }

        const plan = await Plan.findById(planId).lean();
        if (!plan || !plan.isActive) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid plan" });
        }

        if (isEnterprisePlan(plan)) {
            return res.status(400).json({
                success: false,
                message:
                    "Enterprise requires contact flow, not direct purchase",
            });
        }

        const summary = await buildCheckoutSummary({
            companyId: req.user.company_id,
            planId,
            couponCode,
            requestedAdmins: adminCount,
            requestedStaff: staffCount,
        });

        if (Number(summary.finalPrice || 0) <= 0) {
            const subscription = await activateSubscription({
                companyId: req.user.company_id,
                userId: req.userId,
                ip: req.ip,
                summary,
                provider: "free",
                paymentReference: "free",
            });

            emitSubscriptionUpdate(req, {
                companyId: req.user.company_id,
                userId: req.userId,
                planId: String(summary.plan._id),
                planName: summary.plan.name,
                subscriptionId: String(subscription?._id || ""),
                status: "Active",
                renewDate: summary.renewDate,
            });

            const user = await User.findById(req.userId)
                .select("name email mobile company_id")
                .populate("company_id", "name")
                .lean();

            // Notify user via WhatsApp
            if (user?.mobile) {
                sendPlanUpgradeNotification({
                    phoneNumber: user.mobile,
                    customerName: user.name,
                    planName: summary.plan.name,
                    expiryDate: summary.renewDate,
                }).catch(() => { });
            }

            // Notify Admin via WhatsApp
            sendAdminPaymentAlert({
                customerName: user?.name,
                companyName: user?.company_id?.name || "NeoGroww Business",
                planName: summary.plan.name,
                amount: summary.finalPrice,
                paymentId: "Free/Trial",
            }).catch(() => { });

            return res.status(201).json({
                success: true,
                requiresPayment: false,
                message: "Plan activated (no payment required)",
                subscription,
                plan: {
                    id: summary.plan._id,
                    code: summary.plan.code,
                    name: summary.plan.name,
                    maxAdmins: summary.allocatedAdmins,
                    maxStaff: summary.allocatedStaff,
                },
                pricing: {
                    originalPrice: summary.originalPrice,
                    basePrice: Number(summary.plan.basePrice || 0),
                    extraAdminsAmount: summary.extraAdminsAmount,
                    extraStaffAmount: summary.extraStaffAmount,
                    discountAmount: summary.discountAmount,
                    finalPrice: summary.finalPrice,
                },
                allocation: {
                    adminCount: summary.allocatedAdmins,
                    staffCount: summary.allocatedStaff,
                    extraAdminsPurchased: summary.extraAdminsPurchased,
                    extraStaffPurchased: summary.extraStaffPurchased,
                },
                renewDate: summary.renewDate,
            });
        }

        if (!(await isRazorpayConfigured())) {
            return res.status(500).json({
                success: false,
                message: "Razorpay is not configured on the server",
            });
        }

        const usdInrRate = await getUsdInrRate();
        const amountUsd = Number(summary.finalPrice || 0);
        const amountInr = amountUsd * usdInrRate;
        const amountInrPaise = Math.round(amountInr * 100);

        const razorpay = await getRazorpayClientAsync();
        const receipt = buildRazorpayReceipt({
            companyId: req.user.company_id,
            planId,
        });
        const order = await razorpay.orders.create({
            amount: amountInrPaise,
            currency: "INR",
            receipt,
            notes: {
                companyId: String(req.user.company_id),
                userId: String(req.userId),
                planId: String(planId),
                couponCode: String(couponCode || ""),
                adminCount: String(summary.allocatedAdmins),
                staffCount: String(summary.allocatedStaff),
            },
        });

        await Payment.create({
            provider: "razorpay",
            companyId: req.user.company_id,
            userId: req.userId,
            planId: summary.plan._id,
            couponCode: String(couponCode || ""),
            amountUsd,
            amountInr,
            amountInrPaise,
            usdInrRate,
            razorpayOrderId: order.id,
            status: "created",
            notes: receipt,
            metadata: { order },
        });

        return res.json({
            success: true,
            requiresPayment: true,
            provider: "razorpay",
            keyId: (await getRazorpayConfig())?.keyId || "",
            orderId: order.id,
            currency: "INR",
            amountInrPaise,
            amountInr: Number(amountInr.toFixed(2)),
            amountUsd: Number(amountUsd.toFixed(2)),
            plan: {
                id: summary.plan._id,
                code: summary.plan.code,
                name: summary.plan.name,
                maxAdmins: summary.allocatedAdmins,
                maxStaff: summary.allocatedStaff,
            },
            allocation: {
                adminCount: summary.allocatedAdmins,
                staffCount: summary.allocatedStaff,
            },
        });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
});

// 15. RAZORPAY: VERIFY PAYMENT (signature) + ACTIVATE SUBSCRIPTION
router.post("/billing/razorpay/verify", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const {
            planId,
            couponCode = "",
            adminCount = 0,
            staffCount = 0,
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signature,
        } = req.body || {};

        if (!planId || !orderId || !paymentId || !signature) {
            return res
                .status(400)
                .json({
                    success: false,
                    message: "Missing required Razorpay fields",
                });
        }

        const payment = await Payment.findOne({
            provider: "razorpay",
            razorpayOrderId: orderId,
            companyId: req.user.company_id,
            userId: req.userId,
        });

        if (!payment) {
            return res
                .status(404)
                .json({ success: false, message: "Payment record not found" });
        }

        if (String(payment.planId) !== String(planId)) {
            return res
                .status(400)
                .json({
                    success: false,
                    message: "Plan mismatch for this payment",
                });
        }

        const existingSignature = String(payment.razorpaySignature || "");
        const existingPaymentId = String(payment.razorpayPaymentId || "");
        const alreadyVerified =
            payment.status === "verified" &&
            existingSignature &&
            existingSignature === String(signature) &&
            existingPaymentId &&
            existingPaymentId === String(paymentId);

        if (!alreadyVerified) {
            const ok = await verifyCheckoutSignatureAsync({
                orderId,
                paymentId,
                signature,
            });
            if (!ok) {
                await Payment.updateOne(
                    { _id: payment._id },
                    {
                        $set: {
                            status: "failed",
                            razorpayPaymentId: paymentId,
                            razorpaySignature: signature,
                        },
                    },
                );
                return res
                    .status(400)
                    .json({
                        success: false,
                        message: "Invalid Razorpay signature",
                    });
            }

            payment.status = "verified";
            payment.razorpayPaymentId = paymentId;
            payment.razorpaySignature = signature;
            await payment.save();
        }

        const plan = await Plan.findById(planId).lean();
        if (!plan || !plan.isActive) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid plan" });
        }
        if (isEnterprisePlan(plan)) {
            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        "Enterprise requires contact flow, not direct purchase",
                });
        }

        const summary = await buildCheckoutSummary({
            companyId: req.user.company_id,
            planId,
            couponCode,
            requestedAdmins: adminCount,
            requestedStaff: staffCount,
        });

        const paymentReference = `razorpay:${paymentId}`;
        let subscription = await CompanySubscription.findOne({
            companyId: req.user.company_id,
            notes: `paymentReference:${paymentReference}`,
        })
            .sort({ createdAt: -1 })
            .lean();

        if (!subscription) {
            subscription = await activateSubscription({
                companyId: req.user.company_id,
                userId: req.userId,
                ip: req.ip,
                summary,
                provider: "razorpay",
                paymentReference,
                paymentMeta: {
                    razorpayOrderId: orderId,
                    razorpayPaymentId: paymentId,
                },
            });
        }

        const user = await User.findById(req.userId)
            .select("name email company_id")
            .lean();
        const receipt = buildPaymentReceipt({
            companyName: req.user?.companyName || "NeoApp Workspace",
            customerName: user?.name || "",
            customerEmail: user?.email || "",
            planName: summary.plan.name || "",
            paymentId,
            orderId,
            amountUsd: payment.amountUsd,
            amountInr: payment.amountInr,
            currency: "INR",
            couponCode: summary.coupon?.code || couponCode,
            renewDate: summary.renewDate,
            subscriptionId: subscription?._id,
            paidAt: new Date(),
        });

        // Notify user via WhatsApp
        const userForNotify = await User.findById(req.userId)
            .select("name mobile company_id")
            .populate("company_id", "name")
            .lean();
        if (userForNotify?.mobile) {
            sendPlanUpgradeNotification({
                phoneNumber: userForNotify.mobile,
                customerName: userForNotify.name,
                planName: summary.plan.name,
                expiryDate: summary.renewDate,
            }).catch(() => { });
        }

        // Notify Admin via WhatsApp
        sendAdminPaymentAlert({
            customerName: userForNotify?.name || user?.name,
            companyName: userForNotify?.company_id?.name || "NeoGroww Business",
            planName: summary.plan.name,
            amount: payment.amountInr,
            paymentId: paymentId,
        }).catch(() => { });

        const receiptHash = crypto
            .createHash("sha256")
            .update(
                `${receipt.receiptNumber}|${receipt.paymentId}|${receipt.orderId}`,
            )
            .digest("hex");

        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    status: "verified",
                    razorpayPaymentId: paymentId,
                    razorpaySignature: signature,
                    metadata: {
                        ...(payment.metadata || {}),
                        receipt,
                        receiptHash,
                    },
                },
            },
        );

        sendPlanReceiptEmail({ user, receipt }).catch(() => { });
        emitSubscriptionUpdate(req, {
            companyId: req.user.company_id,
            userId: req.userId,
            planId: String(summary.plan._id),
            planName: summary.plan.name,
            subscriptionId: String(subscription?._id || ""),
            status: "Active",
            renewDate: summary.renewDate,
            receiptNumber: receipt.receiptNumber,
        });

        return res.status(201).json({
            success: true,
            message: "Payment verified and subscription activated",
            subscription,
            receipt,
            plan: {
                id: summary.plan._id,
                code: summary.plan.code,
                name: summary.plan.name,
                maxAdmins: summary.allocatedAdmins,
                maxStaff: summary.allocatedStaff,
            },
            pricing: {
                originalPrice: summary.originalPrice,
                basePrice: Number(summary.plan.basePrice || 0),
                extraAdminsAmount: summary.extraAdminsAmount,
                extraStaffAmount: summary.extraStaffAmount,
                discountAmount: summary.discountAmount,
                finalPrice: summary.finalPrice,
            },
            allocation: {
                adminCount: summary.allocatedAdmins,
                staffCount: summary.allocatedStaff,
                extraAdminsPurchased: summary.extraAdminsPurchased,
                extraStaffPurchased: summary.extraStaffPurchased,
            },
            renewDate: summary.renewDate,
        });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
});

// 16. RAZORPAY: WEBHOOK (no auth; raw body required)
router.post("/billing/razorpay/webhook", async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        const raw = Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(JSON.stringify(req.body || {}));
        const rawBody = raw.toString("utf8");

        if (!signature) {
            return res
                .status(400)
                .json({ success: false, message: "Missing webhook signature" });
        }

        const ok = await verifyWebhookSignatureAsync({ rawBody, signature });
        if (!ok) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid webhook signature" });
        }

        const payload = JSON.parse(rawBody || "{}");
        const event = payload?.event || "unknown";
        const entity = payload?.payload || {};

        const orderId =
            entity?.payment?.entity?.order_id ||
            entity?.order?.entity?.id ||
            entity?.refund?.entity?.order_id ||
            null;

        if (orderId) {
            const paymentId = entity?.payment?.entity?.id || null;
            const status = entity?.payment?.entity?.status || null;
            const captured = Boolean(entity?.payment?.entity?.captured);

            const update = { metadata: payload };
            if (paymentId) update.razorpayPaymentId = paymentId;
            if (captured) update.status = "verified";
            if (status) update.notes = `webhook:${status}`;

            await Payment.updateOne(
                { provider: "razorpay", razorpayOrderId: orderId },
                {
                    $set: update,
                },
            );
        }

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 17. CHECKOUT PURCHASE (legacy simulate payment success)
router.post("/billing/checkout/purchase", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const {
            planId,
            couponCode = "",
            paymentReference = "",
            adminCount = 0,
            staffCount = 0,
        } = req.body || {};
        if (!planId) {
            return res
                .status(400)
                .json({ success: false, message: "planId is required" });
        }

        if (
            (await isRazorpayConfigured()) &&
            String(
                process.env.ALLOW_MANUAL_PLAN_PURCHASE || "",
            ).toLowerCase() !== "true"
        ) {
            return res.status(400).json({
                success: false,
                message: "Manual purchase is disabled. Use Razorpay checkout.",
            });
        }

        const plan = await Plan.findById(planId).lean();
        if (!plan || !plan.isActive) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid plan" });
        }

        if (isEnterprisePlan(plan)) {
            return res.status(400).json({
                success: false,
                message:
                    "Enterprise requires contact flow, not direct purchase",
            });
        }

        const summary = await buildCheckoutSummary({
            companyId: req.user.company_id,
            planId,
            couponCode,
            requestedAdmins: adminCount,
            requestedStaff: staffCount,
        });

        const subscription = await activateSubscription({
            companyId: req.user.company_id,
            userId: req.userId,
            ip: req.ip,
            summary,
            provider: "manual",
            paymentReference,
        });

        const user = await User.findById(req.userId)
            .select("name email company_id")
            .lean();
        const receipt = buildPaymentReceipt({
            companyName: req.user?.companyName || "NeoApp Workspace",
            customerName: user?.name || "",
            customerEmail: user?.email || "",
            planName: summary.plan.name || "",
            paymentId: paymentReference,
            orderId: "MANUAL",
            amountUsd: summary.finalPriceUsd || 0,
            amountInr: summary.finalPrice,
            currency: "INR",
            couponCode: summary.coupon?.code || couponCode,
            renewDate: summary.renewDate,
            subscriptionId: subscription?._id,
            paidAt: new Date(),
        });
        sendPlanReceiptEmail({ user, receipt }).catch(() => { });

        return res.status(201).json({
            success: true,
            message: "Payment successful and subscription activated",
            subscription,
            plan: {
                id: summary.plan._id,
                code: summary.plan.code,
                name: summary.plan.name,
                maxAdmins: summary.allocatedAdmins,
                maxStaff: summary.allocatedStaff,
            },
            pricing: {
                originalPrice: summary.originalPrice,
                basePrice: Number(summary.plan.basePrice || 0),
                extraAdminsAmount: summary.extraAdminsAmount,
                extraStaffAmount: summary.extraStaffAmount,
                discountAmount: summary.discountAmount,
                finalPrice: summary.finalPrice,
            },
            allocation: {
                adminCount: summary.allocatedAdmins,
                staffCount: summary.allocatedStaff,
                extraAdminsPurchased: summary.extraAdminsPurchased,
                extraStaffPurchased: summary.extraStaffPurchased,
            },
            renewDate: summary.renewDate,
        });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
});

// 15. ENTERPRISE CONTACT
router.post("/billing/enterprise-contact", verifyToken, async (req, res) => {
    try {
        const {
            name = "",
            email = "",
            phone = "",
            company = "",
            requirements = "",
        } = req.body || {};

        return res.json({
            success: true,
            message:
                "Enterprise request submitted. Team will contact you soon.",
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 16. CURRENT PLAN (mobile sync)
router.get("/company/current-plan", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const resolved = await resolveEffectivePlan(
            req.user.company_id.toString(),
        );
        if (!resolved.hasPlan) {
            return res
                .status(404)
                .json({
                    success: false,
                    message: resolved.reason || "No active subscription",
                });
        }

        return res.json({
            success: true,
            plan: resolved.plan,
            subscription: resolved.subscription,
            override: resolved.override,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});
// 17. GET ACTIVE COUPONS (for app home screen)
router.get("/billing/coupons", verifyToken, async (req, res) => {
    try {
        if (!req.user?.company_id) {
            return res
                .status(400)
                .json({ success: false, message: "No company linked to user" });
        }

        const now = new Date();
        const companyId = req.user.company_id;

        if (await isCompanyOnProPlan(companyId)) {
            return res.json({ success: true, coupons: [] });
        }

        const coupons = await Coupon.find({
            isActive: true,
            $or: [
                { appliesToAllCompanies: true },
                { applicableCompanies: companyId },
            ],
        })
            .populate("applicablePlans", "name code")
            .sort({ createdAt: -1 })
            .lean();

        const result = coupons
            .filter((coupon) => {
                const couponExpiryEnd = coupon.expiryDate
                    ? new Date(coupon.expiryDate)
                    : null;
                if (couponExpiryEnd) couponExpiryEnd.setHours(23, 59, 59, 999);
                const { globalLimit, perCompanyLimit } =
                    getCouponLimits(coupon);
                const companyUsed = getCompanyCouponUsedCount(
                    coupon,
                    companyId,
                );
                return (
                    (!couponExpiryEnd || couponExpiryEnd > now) &&
                    Number(coupon.usedCount || 0) < globalLimit &&
                    companyUsed < perCompanyLimit
                );
            })
            .map((coupon) => {
                const planNames = (coupon.applicablePlans || [])
                    .map((plan) => plan.code || plan.name)
                    .filter(Boolean);
                const planScope = planNames.length
                    ? planNames.join(", ")
                    : "All";
                const { globalLimit, perCompanyLimit } =
                    getCouponLimits(coupon);
                const companyUsed = getCompanyCouponUsedCount(
                    coupon,
                    companyId,
                );

                return {
                    id: coupon._id,
                    code: coupon.code,
                    discountType: coupon.discountType,
                    discountValue: coupon.discountValue,
                    expiryDate: coupon.expiryDate,
                    usedCount: Number(coupon.usedCount || 0),
                    globalUsageLimit: globalLimit,
                    perCompanyUsageLimit: perCompanyLimit,
                    companyUsedCount: companyUsed,
                    planScope,
                    planScopeLabel: planNames.length
                        ? `${planScope} :`
                        : "All :",
                };
            });

        return res.json({ success: true, coupons: result });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
