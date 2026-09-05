const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const {
  requireSuperadmin,
  logSuperadminRequest,
} = require("../middleware/role.middleware");
const { enforceSuperadminIpAllowlist } = require("../middleware/superadminSecurity");
const superadminController = require("../controllers/superadmin.controller");

router.use(enforceSuperadminIpAllowlist, verifyToken, requireSuperadmin, logSuperadminRequest);

router.get("/dashboard", superadminController.getDashboard);

router.get("/companies", superadminController.getCompanies);
router.patch("/companies/:companyId/status", superadminController.updateCompanyStatus);
router.patch("/companies/:companyId/env-confirmation", superadminController.updateCompanyEnvConfirmation);
router.delete("/companies/:companyId", superadminController.deleteCompany);
router.get("/companies/:companyId/effective-plan", superadminController.getEffectivePlanByCompany);

router.get("/users", superadminController.getUsers);
router.patch("/users/:userId/status", superadminController.updateUserStatus);
router.patch("/users/:userId/role", superadminController.updateUserRole);
router.post("/users/:userId/reset-password", superadminController.resetUserPassword);

router.get("/plans", superadminController.getPlans);
router.post("/plans", superadminController.createPlan);
router.patch("/plans/:planId", superadminController.updatePlan);
router.delete("/plans/:planId", superadminController.deletePlan);

router.get("/settings/exchange-rates", superadminController.getExchangeRates);
router.patch("/settings/exchange-rates", superadminController.updateExchangeRates);
router.get("/settings/workspace", superadminController.getWorkspaceSettings);
router.patch("/settings/workspace", superadminController.updateWorkspaceSettings);
router.get("/settings/security-policy", superadminController.getSecurityPolicySettings);
router.patch("/settings/security-policy", superadminController.updateSecurityPolicySettings);
router.get("/settings/razorpay", superadminController.getRazorpaySettings);
router.patch("/settings/razorpay", superadminController.updateRazorpaySettings);
router.put("/settings/change-password", superadminController.changeSuperadminPassword);

router.get("/coupons", superadminController.getCoupons);
router.post("/coupons", superadminController.createCoupon);
router.patch("/coupons/:couponId", superadminController.updateCoupon);
router.delete("/coupons/:couponId", superadminController.deleteCoupon);

router.get("/overrides", superadminController.getOverrides);
router.post("/overrides", superadminController.upsertOverride);
router.delete("/overrides/:overrideId", superadminController.deleteOverride);

router.get("/subscriptions", superadminController.getSubscriptions);
router.post("/subscriptions", superadminController.assignSubscription);
router.patch("/subscriptions/:subscriptionId", superadminController.updateSubscription);
router.delete("/subscriptions/:subscriptionId", superadminController.deleteSubscription);

router.get("/revenue", superadminController.getRevenue);
router.get("/logs", superadminController.getLogs);

router.get("/website-leads", superadminController.getWebsiteLeads);

router.get("/support/tickets", superadminController.getSupportTickets);
router.post("/support/tickets/:ticketId/respond", superadminController.respondSupportTicket);

router.get("/admin-staff-payments", superadminController.getAdminStaffPayments);

module.exports = router;
