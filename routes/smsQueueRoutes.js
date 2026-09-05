const express = require("express");
const router = express.Router();

const { verifyToken } = require("../middleware/auth");
const { requireSuperadmin } = require("../middleware/role.middleware");
const { getStats } = require("../services/smsQueue");

router.get("/queue-stats", verifyToken, requireSuperadmin, async (_req, res) => {
  try {
    return res.status(200).json({ ok: true, stats: getStats() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "error" });
  }
});

module.exports = router;

