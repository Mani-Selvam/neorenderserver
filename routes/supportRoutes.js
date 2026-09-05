const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Company = require("../models/Company");
const SupportTicket = require("../models/SupportTicket");
const optionalAuth = require("../middleware/optionalAuth");
const { verifyToken } = require("../middleware/auth");
const { getClientIp } = require("../utils/ipAllowlist");

router.use(optionalAuth);

const maskEmail = (email) => {
  const value = String(email || "").trim();
  if (!value.includes("@")) return value ? "***" : "";
  const [user, domain] = value.split("@");
  const safeUser = user.length <= 2 ? `${user.charAt(0)}*` : `${user.slice(0, 2)}***`;
  return `${safeUser}@${domain}`;
};

router.get("/ping", async (_req, res) => {
  res.json({ success: true, message: "support ok" });
});

router.post("/tickets", async (req, res) => {
  try {
    const { name, email, mobile, message, source } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "message is required" });
    }

    const cleanEmail = email ? String(email).trim().toLowerCase() : "";
    const cleanMobile = mobile ? String(mobile).trim() : "";

    let user = req.user || null;
    if (!user && (cleanEmail || cleanMobile)) {
      user = await User.findOne({
        $or: [...(cleanEmail ? [{ email: cleanEmail }] : []), ...(cleanMobile ? [{ mobile: cleanMobile }] : [])],
      }).select("company_id email mobile name").lean();
    }

    let company = null;
    if (user?.company_id) {
      company = await Company.findById(user.company_id).select("status").lean();
    }

    const ticket = await SupportTicket.create({
      name: name ? String(name).trim() : user?.name || "",
      email: cleanEmail || user?.email || "",
      mobile: cleanMobile || user?.mobile || "",
      message: String(message).trim(),
      source: source ? String(source).trim() : "mobile",
      userId: user?._id,
      companyId: user?.company_id,
      companyStatusAtSubmit: company?.status || "",
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] || "",
    });

    console.log("[Support] Ticket created", {
      id: ticket._id?.toString?.() || String(ticket._id),
      email: maskEmail(ticket.email),
      companyId: ticket.companyId?.toString?.() || "",
    });
    res.json({ success: true, ticketId: ticket._id });
  } catch (_error) {
    console.error("[Support] Ticket submit failed:", _error?.message || _error);
    res.status(500).json({ success: false, message: "Failed to submit support request" });
  }
});

router.get("/my-tickets", verifyToken, async (req, res) => {
  try {
    const user = req.user || (await User.findById(req.userId).select("company_id email mobile name").lean());
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const companyId = user.company_id || null;
    const company = companyId
      ? await Company.findById(companyId).select("name status code").lean()
      : null;

    const filter = companyId ? { companyId } : { userId: user._id };
    const tickets = await SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .select("message status source createdAt respondedAt responseMessage")
      .lean();

    return res.json({
      success: true,
      company: company
        ? { id: company._id, name: company.name || "", status: company.status || "", code: company.code || "" }
        : null,
      tickets,
    });
  } catch (_error) {
    return res.status(500).json({ success: false, message: "Failed to load tickets" });
  }
});

router.post("/my-tickets", verifyToken, async (req, res) => {
  try {
    const { message, source } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "message is required" });
    }

    const user = req.user || (await User.findById(req.userId).select("company_id email mobile name").lean());
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const company = user?.company_id
      ? await Company.findById(user.company_id).select("status").lean()
      : null;

    const ticket = await SupportTicket.create({
      name: user?.name || "",
      email: user?.email || "",
      mobile: user?.mobile || "",
      message: String(message).trim(),
      source: source ? String(source).trim() : "mobile_app",
      userId: user?._id,
      companyId: user?.company_id,
      companyStatusAtSubmit: company?.status || "",
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] || "",
    });

    return res.json({ success: true, ticketId: ticket._id });
  } catch (_error) {
    return res.status(500).json({ success: false, message: "Failed to submit ticket" });
  }
});

module.exports = router;
