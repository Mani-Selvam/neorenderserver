const { resolveEffectivePlan } = require("../services/planResolver");
const { canonicalFeatureKey } = require("../services/planFeatures");

const planCache = new Map();
const PLAN_CACHE_TTL_MS = 60 * 1000;

const normalizeCompanyId = (companyId) => (companyId ? String(companyId) : "");

const getCachedEffectivePlan = (companyId) => {
  const key = normalizeCompanyId(companyId);
  if (!key) return null;

  const cached = planCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > PLAN_CACHE_TTL_MS) {
    planCache.delete(key);
    return null;
  }

  return cached.value;
};

const setCachedEffectivePlan = (companyId, value) => {
  const key = normalizeCompanyId(companyId);
  if (!key) return;
  planCache.set(key, { value, timestamp: Date.now() });
};

const clearCompanyPlanCache = (companyId) => {
  const key = normalizeCompanyId(companyId);
  if (!key) return;
  planCache.delete(key);
};

const requireActivePlan = async (req, res, next) => {
  try {
    // Superadmin routes are mounted elsewhere, but keep this safe.
    const role = String(req.user?.role || "").toLowerCase();
    if (role === "superadmin") return next();

    const companyId = req.user?.company_id;
    if (!companyId) {
      return res.status(403).json({
        success: false,
        code: "TENANT_MISSING",
        message: "No company linked to this account",
      });
    }

    const cached = getCachedEffectivePlan(companyId);
    const resolved = cached || (await resolveEffectivePlan(companyId.toString()));
    if (!cached) setCachedEffectivePlan(companyId, resolved);

    if (!resolved?.hasPlan) {
      return res.status(402).json({
        success: false,
        code: "NO_ACTIVE_PLAN",
        message: resolved?.reason || "No active plan",
      });
    }

    req.effectivePlan = resolved.plan;
    req.subscription = resolved.subscription;
    next();
  } catch (e) {
    return res.status(500).json({
      success: false,
      code: "PLAN_CHECK_FAILED",
      message: e?.message || "Plan check failed",
    });
  }
};

const requireFeature = (featureName) => (req, res, next) => {
  const expected = String(featureName || "").trim();
  if (!expected) return next();
  const expectedKey = canonicalFeatureKey(expected);

  const plan = req.effectivePlan;
  const features = Array.isArray(plan?.features) ? plan.features : [];
  const enabled = features.some((f) => canonicalFeatureKey(f) === expectedKey);

  if (!enabled) {
    return res.status(403).json({
      success: false,
      code: "FEATURE_DISABLED",
      message: `Feature not enabled: ${expected}`,
      feature: expected,
      plan: { code: plan?.code || null, name: plan?.name || null },
    });
  }

  return next();
};

module.exports = {
  requireActivePlan,
  requireFeature,
  clearCompanyPlanCache,
};
