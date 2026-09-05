const Plan = require("../models/Plan");
const Coupon = require("../models/Coupon");
const CompanySubscription = require("../models/CompanySubscription");
const CompanyPlanOverride = require("../models/CompanyPlanOverride");
const User = require("../models/User");
const { ensureFixedPlansSynced, normalizePlanForClient } = require("./planFeatures");

const calcDiscount = (price, coupon) => {
  if (!coupon) return { discountAmount: 0, finalPrice: price };

  let discountAmount = 0;
  if (coupon.discountType === "percentage") {
    discountAmount = (price * coupon.discountValue) / 100;
  } else {
    discountAmount = coupon.discountValue;
  }

  if (discountAmount > price) discountAmount = price;
  const finalPrice = Math.max(0, Number((price - discountAmount).toFixed(2)));
  return { discountAmount, finalPrice };
};

const resolveEffectivePlan = async (companyId) => {
  await ensureFixedPlansSynced();
  const subscription = await CompanySubscription.findOne({ companyId, status: { $in: ["Trial", "Active"] } })
    .sort({ createdAt: -1 })
    .populate("planId")
    .populate("couponId")
    .lean();

  if (!subscription || !subscription.planId) {
    const isDev = String(process.env.NODE_ENV || "").toLowerCase() === "development";
    if (isDev) {
      return {
        hasPlan: true,
        companyId,
        isMock: true,
        plan: {
          id: "mock_plan_id",
          code: "DEV_MOCK",
          name: "Development Mock Plan",
          features: ["enquiries", "followups", "reports", "lead_sources", "products", "targets", "team_chat", "staff_management", "whatsapp", "email"],
          maxAdmins: 100,
          maxStaff: 100,
          trialDays: 0,
          basePrice: 0,
          originalPrice: 0,
          extraAdminPrice: 0,
          extraStaffPrice: 0,
          extraAdminsPurchased: 0,
          extraStaffPurchased: 0,
          adminsUsed: 0,
          staffUsed: 0,
          finalPrice: 0,
          discountAmount: 0,
          couponCode: null,
          aiVoiceLimitYearly: 3000,
          aiVoiceExtraPrice: 500,
          aiVoiceExtraRequests: 1000,
        },
        subscription: {
          id: "mock_sub_id",
          status: "Active",
          startDate: new Date(),
          endDate: new Date(Date.now() + 86400000 * 365),
          effectiveEndDate: new Date(Date.now() + 86400000 * 365),
          originalEndDate: new Date(Date.now() + 86400000 * 365),
          manualOverrideExpiry: null,
          allocatedAdmins: 100,
          allocatedStaff: 100,
          extraAdminsPurchased: 0,
          extraStaffPurchased: 0,
        },
        override: null,
      };
    }
    return { hasPlan: false, reason: "No active subscription" };
  }

  const plan = normalizePlanForClient(subscription.planId);
  const override = await CompanyPlanOverride.findOne({ companyId }).lean();
  const now = new Date();
  const overrideExpiry = override?.customExpiry ? new Date(override.customExpiry) : null;
  if (overrideExpiry) {
    overrideExpiry.setHours(23, 59, 59, 999);
  }
  const overrideExpired = overrideExpiry ? overrideExpiry <= now : false;
  const overridePlanMatch =
    !override?.targetPlanId || String(override.targetPlanId) === String(plan._id);
  const canUseOverride = Boolean(
    override && override.isActive !== false && !overrideExpired && overridePlanMatch,
  );

  let coupon = null;
  if (subscription.couponId) {
    const c = await Coupon.findById(subscription.couponId).lean();
    const couponExpiryEnd = c?.expiryDate ? new Date(c.expiryDate) : null;
    if (couponExpiryEnd) couponExpiryEnd.setHours(23, 59, 59, 999);
    if (
      c &&
      c.isActive &&
      c.usedCount < c.usageLimit &&
      (!couponExpiryEnd || couponExpiryEnd > new Date()) &&
      (!c.applicablePlans || c.applicablePlans.length === 0 || c.applicablePlans.some((id) => id.toString() === plan._id.toString()))
    ) {
      coupon = c;
    }
  }

  const basePrice = canUseOverride && typeof override?.customPrice === "number" ? override.customPrice : plan.basePrice;
  const planMaxStaff =
    canUseOverride && typeof override?.customMaxStaff === "number" ? override.customMaxStaff : plan.maxStaff;
  const trialDays = canUseOverride && typeof override?.customTrialDays === "number" ? override.customTrialDays : plan.trialDays;
  const maxAdmins = Number(subscription.allocatedAdmins || plan.maxAdmins || 0);
  const maxStaff = Number(subscription.allocatedStaff || planMaxStaff || 0);
  let effectiveExpiry =
    (canUseOverride ? override?.customExpiry : null) || subscription.manualOverrideExpiry || subscription.endDate;

  if (
    String(subscription.status || "").toLowerCase() === "trial" &&
    !subscription.manualOverrideExpiry &&
    !(canUseOverride && override?.customExpiry) &&
    subscription.startDate
  ) {
    const trialStart = new Date(subscription.startDate);
    const dynamicTrialEnd = new Date(trialStart);
    dynamicTrialEnd.setDate(dynamicTrialEnd.getDate() + Number(trialDays || 0));
    effectiveExpiry = dynamicTrialEnd;
  }

  if (effectiveExpiry) {
    const expiry = new Date(effectiveExpiry);
    expiry.setHours(23, 59, 59, 999);
    if (expiry <= now) {
      const isDev = String(process.env.NODE_ENV || "").toLowerCase() === "development";
      if (!isDev) {
        return { hasPlan: false, reason: "Subscription expired" };
      }
      // If dev, we continue and it will return hasPlan: true below
    }
  }

  const includedAdmins = Number(plan.maxAdmins || 0);
  const includedStaff = Number(planMaxStaff || 0);
  const extraAdminPrice = Number(subscription.extraAdminPrice || plan.extraAdminPrice || 0);
  const extraStaffPrice = Number(subscription.extraStaffPrice || plan.extraStaffPrice || 0);
  const extraAdminsPurchased = Math.max(
    Number(subscription.extraAdminsPurchased || 0),
    Math.max(0, maxAdmins - includedAdmins),
  );
  const extraStaffPurchased = Math.max(
    Number(subscription.extraStaffPurchased || 0),
    Math.max(0, maxStaff - includedStaff),
  );
  const originalPrice = Number(
    (
      Number(basePrice || 0) +
      extraAdminsPurchased * extraAdminPrice +
      extraStaffPurchased * extraStaffPrice
    ).toFixed(2),
  );
  const computedPricing = calcDiscount(originalPrice, coupon);
  const finalPrice = Number(subscription.finalPrice || computedPricing.finalPrice || 0);
  const discountAmount = Number(
    Math.max(0, originalPrice - finalPrice).toFixed(2),
  );
  const [adminsUsed, staffUsed] = await Promise.all([
    User.countDocuments({
      company_id: companyId,
      role: { $in: ["Admin", "admin"] },
    }),
    User.countDocuments({
      company_id: companyId,
      role: { $in: ["Staff", "staff"] },
    }),
  ]);

  return {
    hasPlan: true,
    companyId,
    plan: {
      id: plan._id,
      code: plan.code,
      name: plan.name,
      features: plan.features || [],
      maxAdmins,
      maxStaff,
      trialDays,
      basePrice,
      originalPrice,
      extraAdminPrice,
      extraStaffPrice,
      extraAdminsPurchased,
      extraStaffPurchased,
      adminsUsed: Number(adminsUsed || 0),
      staffUsed: Number(staffUsed || 0),
      finalPrice,
      discountAmount,
      couponCode: coupon?.code || null,
      aiVoiceLimitYearly: Number(plan.aiVoiceLimitYearly || 3000),
      aiVoiceExtraPrice: Number(plan.aiVoiceExtraPrice || 500),
      aiVoiceExtraRequests: Number(plan.aiVoiceExtraRequests || 1000),
    },
    subscription: {
      id: subscription._id,
      status: subscription.status,
      startDate: subscription.startDate,
      endDate: effectiveExpiry,
      effectiveEndDate: effectiveExpiry,
      originalEndDate: subscription.endDate,
      manualOverrideExpiry: subscription.manualOverrideExpiry || null,
      allocatedAdmins: maxAdmins,
      allocatedStaff: maxStaff,
      extraAdminsPurchased,
      extraStaffPurchased,
    },
    override: override || null,
  };
};

module.exports = {
  resolveEffectivePlan,
};
