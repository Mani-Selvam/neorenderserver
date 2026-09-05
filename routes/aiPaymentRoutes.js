const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const AIPayment = require("../models/AIPayment");
const Company = require("../models/Company");
const { verifyToken } = require("../middleware/auth");
const { requireActivePlan } = require("../middleware/planGuard");
const { sendEmail } = require("../utils/emailService");
const { sendWhatsAppMessage } = require("../utils/whatsappConfigService");

const { getRazorpayClientAsync, verifyCheckoutSignatureAsync } = require("../services/razorpayService");
const { getRazorpayConfig, getUsdInrRate } = require("../services/settingsService");

/**
 * POST /api/ai-payments/razorpay/order
 * Create a Razorpay order for AI Top-up
 */
router.post("/razorpay/order", verifyToken, requireActivePlan, async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(400).json({ success: false, message: "No company linked" });

        const effectivePlan = req.effectivePlan;
        if (!effectivePlan) return res.status(400).json({ success: false, message: "No active plan" });

        const priceUsd = effectivePlan.aiVoiceExtraPrice || 500;
        const usdInrRate = 83; // Fixed conversion rate as requested
        const priceInr = Math.round(priceUsd * usdInrRate);
        const amountPaise = Math.round(priceInr * 100);

        const razorpay = await getRazorpayClientAsync();
        const order = await razorpay.orders.create({
            amount: amountPaise,
            currency: "INR",
            receipt: `ai_topup_${Date.now().toString().slice(-8)}`,
        });

        const cfg = await getRazorpayConfig();

        res.json({
            success: true,
            provider: "razorpay",
            keyId: cfg?.keyId || "",
            razorpayOrderId: order.id,
            amountInrPaise: amountPaise,
            amountInr: priceInr,
            currency: "INR",
            priceUsd: priceUsd
        });
    } catch (error) {
        console.error("AI Top-up Order Error:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to create order" });
    }
});

/**
 * POST /api/ai-payments/razorpay/verify
 * Verify Razorpay payment and credit requests
 */
router.post("/razorpay/verify", verifyToken, requireActivePlan, async (req, res) => {
    try {
        const userId = req.userId;
        const companyId = req.user?.company_id;
        
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: "Missing Razorpay fields" });
        }

        const isValid = await verifyCheckoutSignatureAsync({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            signature: razorpay_signature
        });

        if (!isValid) {
            return res.status(400).json({ success: false, message: "Invalid Razorpay signature" });
        }

        const effectivePlan = req.effectivePlan;
        const priceUsd = effectivePlan.aiVoiceExtraPrice || 500;
        const requests = effectivePlan.aiVoiceExtraRequests || 1000;
        
        const usdInrRate = 83; // Fixed conversion rate as requested
        const priceInr = Math.round(priceUsd * usdInrRate);

        const payment = new AIPayment({
            companyId,
            userId,
            amountPaid: priceInr,
            requestsAdded: requests,
            status: "Completed",
            transactionId: razorpay_payment_id,
        });
        await payment.save();

        const company = await Company.findById(companyId);
        if (company) {
            let usage = company.assistantUsage || { yearlyUsed: 0, extraPurchased: 0 };
            usage.extraPurchased = (usage.extraPurchased || 0) + requests;
            company.assistantUsage = usage;
            await company.save();
        }

        const userDoc = await mongoose.model("User").findById(userId);

        let emailSent = false;
        try {
            if (userDoc && userDoc.email) {
                await sendEmail({
                    to: userDoc.email,
                    subject: "AI Voice Assistant Top-Up Successful",
                    text: `Your purchase of ${requests} AI Voice Requests for ₹${priceInr} was successful.`,
                    html: `<h3>Payment Successful!</h3><p>Your purchase of <b>${requests} AI Voice Requests</b> for ₹${priceInr} was successfully applied to your account.</p>`
                });
                emailSent = true;
                payment.receiptEmailSent = true;
            }
        } catch (e) {
            console.error("Failed to send AI top-up email", e);
        }

        let whatsappSent = false;
        try {
            console.log("[AI Top-Up] Preparing to send WhatsApp. User mobile:", userDoc?.mobile);
            if (userDoc && userDoc.mobile) {
                const { sendNeoTemplateMessage } = require("../utils/otpService");
                const templateName = process.env.NEO_AI_PLAN_TEMPLATE_NAME || "voice_plan_upgrade";
                
                const sent = await sendNeoTemplateMessage({
                    phoneNumber: userDoc.mobile,
                    templateName: templateName,
                    parameters: [
                        String(requests),
                        String(priceInr)
                    ]
                });
                
                if (sent) {
                    whatsappSent = true;
                    payment.whatsappSent = true;
                }
            } else {
                console.log("[AI Top-Up] User does not have a mobile number set, skipping WhatsApp.");
            }
        } catch (e) {
            console.error("Failed to send AI top-up WhatsApp", e);
        }

        await payment.save();

        const receipt = {
            receiptNumber: `AI-${payment._id.toString().slice(-6).toUpperCase()}`,
            customerName: userDoc?.name || "-",
            customerEmail: userDoc?.email || "-",
            planName: "AI Voice Top-Up",
            paymentId: razorpay_payment_id,
            orderId: razorpay_order_id,
            amountInr: priceInr,
            paidAtLabel: new Date().toLocaleString("en-IN", { hour12: true }),
        };

        return res.json({
            success: true,
            message: "Top-up successful",
            payment,
            receipt,
            emailSent,
            whatsappSent,
            pricing: { finalPrice: priceUsd },
            plan: { name: "AI Voice Top-Up" }
        });
    } catch (error) {
        console.error("AI Payment Verify Error:", error);
        return res.status(500).json({ success: false, message: "Verification failed" });
    }
});

/**
 * GET /api/ai-payments
 * Fetch AI payment history for the Super Admin
 */
router.get("/", verifyToken, async (req, res) => {
    try {
        const role = String(req.user?.role || "").toLowerCase();
        if (role !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const payments = await AIPayment.find()
            .populate("companyId", "name code")
            .populate("userId", "name email")
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, payments });
    } catch (error) {
        console.error("Fetch AI Payments Error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch payments" });
    }
});

/**
 * DELETE /api/ai-payments/:id
 * Delete an AI payment record (for testing)
 */
router.delete("/:id", verifyToken, async (req, res) => {
    try {
        const role = String(req.user?.role || "").toLowerCase();
        if (role !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const payment = await AIPayment.findById(req.params.id);
        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        const requestsToDeduct = payment.requestsAdded || 0;
        
        await AIPayment.findByIdAndDelete(req.params.id);

        if (requestsToDeduct > 0 && payment.companyId) {
            const company = await Company.findById(payment.companyId);
            if (company && company.assistantUsage) {
                company.assistantUsage.extraPurchased = Math.max(0, (company.assistantUsage.extraPurchased || 0) - requestsToDeduct);
                await company.save();
            }
        }

        res.json({ success: true, message: "Payment record deleted and usage limit reverted" });
    } catch (error) {
        console.error("Delete AI Payment Error:", error);
        res.status(500).json({ success: false, message: "Failed to delete payment" });
    }
});

module.exports = router;
