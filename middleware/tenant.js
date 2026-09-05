// middleware/tenant.js
// Provides tenant scoping and role-check middleware
module.exports = {
  requireCompany(req, res, next) {
    if (!req.user || !req.user.company_id) {
      return res
        .status(403)
        .json({ error: "Tenant not found on authenticated user" });
    }
    req.companyId = req.user.company_id.toString();
    next();
  },

  requireRole(expected) {
    // expected can be a string or array of allowed roles
    const allowed = Array.isArray(expected) ? expected : [expected];
    return (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const userRole = String(req.user.role || "").toLowerCase();
      const allowedRoles = allowed.map((r) => String(r || "").toLowerCase());
      if (!allowedRoles.includes(userRole))
        return res.status(403).json({ error: "Forbidden" });
      next();
    };
  },
};
