
const normalizeRole = (role) => (role || "").toString().toLowerCase();

const isSuperadmin = (role) => normalizeRole(role) === "superadmin";

const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
  if (normalizeRole(req.user.role) !== normalizeRole(role)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  next();
};

const requireSuperadmin = requireRole("superadmin");

const logSuperadminRequest = async (req, _res, next) => {
  try {
  } catch (_err) {
    // Logging should not block request processing
  }
  next();
};

module.exports = {
  isSuperadmin,
  requireRole,
  requireSuperadmin,
  logSuperadminRequest,
};
