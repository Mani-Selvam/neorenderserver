const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { resolveEffectivePlan } = require("../services/planResolver");

router.get("/current-plan", verifyToken, async (req, res) => {
  try {
    if (!req.user?.company_id) {
      return res.status(400).json({ success: false, message: "No company linked to user" });
    }

    const resolved = await resolveEffectivePlan(req.user.company_id.toString());
    if (!resolved.hasPlan) {
      return res.status(404).json({ success: false, message: resolved.reason || "No active subscription" });
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

module.exports = router;
