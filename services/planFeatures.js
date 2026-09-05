const Plan = require("../models/Plan");
const CompanySubscription = require("../models/CompanySubscription");

const FIXED_PLAN_DEFINITIONS = {
    FREE: {
        code: "FREE",
        name: "Free CRM",
        sortOrder: 0,
        basePrice: 0,
        trialDays: 14,
        maxAdmins: 1,
        maxStaff: 1,
        extraAdminPrice: 0,
        extraStaffPrice: 0,
        features: [
            "lead_sources",
            "products",
            "staff_management",
            "targets",
            "support",
            "enquiries",
            "followups",
            "reports",
        ],
    },
    BASIC: {
        code: "BASIC",
        name: "Basic CRM",
        sortOrder: 1,
        basePrice: 84,
        trialDays: 7,
        maxAdmins: 1,
        maxStaff: 2,
        extraAdminPrice: 12,
        extraStaffPrice: 8,
        features: [
            "lead_sources",
            "products",
            "staff_management",
            "targets",
            "support",
            "enquiries",
            "followups",
            "reports",
            "team_chat",
        ],
    },
    PRO: {
        code: "PRO",
        name: "Pro CRM",
        sortOrder: 2,
        basePrice: 199,
        trialDays: 7,
        maxAdmins: 2,
        maxStaff: 10,
        extraAdminPrice: 15,
        extraStaffPrice: 10,
        features: [
            "lead_sources",
            "products",
            "staff_management",
            "targets",
            "support",
            "enquiries",
            "followups",
            "reports",
            "team_chat",
            "whatsapp",
            "email",
            "voice_assistant",
        ],
    },
};

const LEGACY_FEATURE_MAP = {
    basiccrm: "enquiries",
    leadcapture: "enquiries",
    enquiries: "enquiries",
    followups: "followups",
    followup: "followups",
    reports: "reports",
    leadsources: "lead_sources",
    leadsource: "lead_sources",
    products: "products",
    product: "products",
    staffmanagement: "staff_management",
    adminstaff: "staff_management",
    staff: "staff_management",
    admins: "staff_management",
    admin: "staff_management",
    targets: "targets",
    target: "targets",
    helpsupport: "support",
    support: "support",
    prioritysupport: "support",
    teamchat: "team_chat",
    communication: "team_chat",
    whatsappintegration: "whatsapp",
    whatsapp: "whatsapp",
    email: "email",
    emails: "email",
    voiceassistant: "voice_assistant",
    voice: "voice_assistant",
    assistant: "voice_assistant",
};

const FIXED_PLAN_CODES = Object.keys(FIXED_PLAN_DEFINITIONS);
let lastSyncAt = 0;
let lastSyncResult = null;
const SYNC_TTL_MS = 60 * 1000;

const invalidatePlanSyncCache = () => {
    lastSyncAt = 0;
    lastSyncResult = null;
};

const normalizeFeatureKey = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");

const canonicalFeatureKey = (value) => {
    const normalized = normalizeFeatureKey(value);
    return LEGACY_FEATURE_MAP[normalized] || normalized;
};

const normalizeFeatureList = (features) => {
    const list = Array.isArray(features) ? features : [];
    return [...new Set(list.map(canonicalFeatureKey).filter(Boolean))];
};

const getPlanDefinition = (code) => {
    const safeCode = String(code || "")
        .trim()
        .toUpperCase();
    return FIXED_PLAN_DEFINITIONS[safeCode] || FIXED_PLAN_DEFINITIONS.FREE;
};

const getPlanFeatureKeys = (code) => [...getPlanDefinition(code).features];

const inferPlanCode = (planLike) => {
    const rawCode = String(planLike?.code || "")
        .trim()
        .toUpperCase();
    if (FIXED_PLAN_CODES.includes(rawCode)) return rawCode;

    const rawName =
        `${planLike?.code || ""} ${planLike?.name || ""}`.toLowerCase();
    const features = normalizeFeatureList(planLike?.features);

    if (
        rawName.includes("pro") ||
        rawName.includes("premium") ||
        features.includes("whatsapp") ||
        features.includes("email") ||
        features.includes("voice_assistant")
    ) {
        return "PRO";
    }

    if (
        rawName.includes("basic") ||
        rawName.includes("starter") ||
        rawName.includes("trial") ||
        features.includes("team_chat")
    ) {
        return "BASIC";
    }

    return "FREE";
};

const buildPlanPayload = (source, code) => {
    const definition = getPlanDefinition(code);
    return {
        code,
        name: definition.name,
        sortOrder: definition.sortOrder,
        features: [...definition.features],
        basePrice: Number(source?.basePrice ?? definition.basePrice),
        trialDays: Number(source?.trialDays ?? definition.trialDays),
        maxAdmins: Number(source?.maxAdmins ?? definition.maxAdmins),
        maxStaff: Number(source?.maxStaff ?? definition.maxStaff),
        extraAdminPrice: Number(
            source?.extraAdminPrice ?? definition.extraAdminPrice,
        ),
        extraStaffPrice: Number(
            source?.extraStaffPrice ?? definition.extraStaffPrice,
        ),
        isActive:
            typeof source?.isActive === "boolean" ? source.isActive : true,
    };
};

const ensureFixedPlansSynced = async () => {
    if (lastSyncResult && Date.now() - lastSyncAt < SYNC_TTL_MS) {
        return lastSyncResult;
    }

    const existingPlans = await Plan.find()
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean();
    const unusedPlans = [...existingPlans];
    const preferredSourceForCode = new Map();

    for (const code of FIXED_PLAN_CODES) {
        const exact = unusedPlans.find(
            (plan) => String(plan.code || "").toUpperCase() === code,
        );
        if (exact) {
            preferredSourceForCode.set(code, exact);
            unusedPlans.splice(unusedPlans.indexOf(exact), 1);
            continue;
        }

        const inferred = unusedPlans.find(
            (plan) => inferPlanCode(plan) === code,
        );
        if (inferred) {
            preferredSourceForCode.set(code, inferred);
            unusedPlans.splice(unusedPlans.indexOf(inferred), 1);
        }
    }

    for (const code of FIXED_PLAN_CODES) {
        const payload = buildPlanPayload(
            preferredSourceForCode.get(code),
            code,
        );
        await Plan.findOneAndUpdate(
            { code },
            { $set: payload },
            {
                upsert: true,
                returnDocument: "after",
                setDefaultsOnInsert: true,
                runValidators: true,
            },
        );
    }

    const canonicalPlans = await Plan.find({ code: { $in: FIXED_PLAN_CODES } })
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean();
    const plansByCode = new Map(
        canonicalPlans.map((plan) => [plan.code, plan]),
    );
    const impactedCompanyIds = new Set();

    const subscriptions = await CompanySubscription.find({})
        .populate("planId")
        .select("_id companyId planId")
        .lean();

    for (const subscription of subscriptions) {
        const currentPlan = subscription?.planId;
        if (!currentPlan?._id) continue;

        const targetCode = inferPlanCode(currentPlan);
        const targetPlan =
            plansByCode.get(targetCode) || plansByCode.get("FREE");
        if (!targetPlan?._id) continue;

        if (String(currentPlan._id) !== String(targetPlan._id)) {
            await CompanySubscription.updateOne(
                { _id: subscription._id },
                { $set: { planId: targetPlan._id } },
            );
            impactedCompanyIds.add(String(subscription.companyId || ""));
        }
    }

    lastSyncResult = {
        plans: canonicalPlans,
        plansByCode,
        impactedCompanyIds: [...impactedCompanyIds].filter(Boolean),
    };
    lastSyncAt = Date.now();
    return lastSyncResult;
};

const normalizePlanForClient = (plan) => {
    if (!plan) return plan;
    const code = inferPlanCode(plan);
    const definition = getPlanDefinition(code);
    return {
        ...plan,
        code,
        name: definition.name,
        features: normalizeFeatureList(
            plan.features?.length ? plan.features : definition.features,
        ),
    };
};

module.exports = {
    FIXED_PLAN_CODES,
    FIXED_PLAN_DEFINITIONS,
    canonicalFeatureKey,
    normalizeFeatureKey,
    normalizeFeatureList,
    inferPlanCode,
    getPlanDefinition,
    getPlanFeatureKeys,
    ensureFixedPlansSynced,
    invalidatePlanSyncCache,
    normalizePlanForClient,
};
