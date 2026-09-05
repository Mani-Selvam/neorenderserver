const { getClientIp, isIpAllowed } = require("../utils/ipAllowlist");
const { getSecurityPolicy } = require("../services/settingsService");

const enforceSuperadminIpAllowlist = async (req, res, next) => {
  try {
    const policy = await getSecurityPolicy();
    const enabled = Boolean(policy?.restrictSuperadminLoginsByIp);
    const allowlist = policy?.superadminIpAllowlist || "";
    if (!enabled || !String(allowlist).trim()) return next();

    const ip = getClientIp(req);
    if (isIpAllowed(ip, allowlist)) return next();

    return res.status(403).json({
      success: false,
      code: "IP_NOT_ALLOWED",
      message: "Login is restricted by IP allowlist",
      ip,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "Security policy check failed" });
  }
};

module.exports = { enforceSuperadminIpAllowlist };

