const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const AdminStaffPayment = require("../models/AdminStaffPayment");
const Company = require("../models/Company");
const CompanySubscription = require("../models/CompanySubscription");
const { verifyToken } = require("../middleware/auth");
const { requireActivePlan } = require("../middleware/planGuard");
const { sendEmail } = require("../utils/emailService");

const { getRazorpayClientAsync, verifyCheckoutSignatureAsync } = require("../services/razorpayService");
const { getRazorpayConfig } = require("../services/settingsService");

/**
 * POST /api/admin-staff-payments/razorpay/order
 * Create a Razorpay order for Admin/Staff Top-up
 */
router.post("/razorpay/order", verifyToken, requireActivePlan, async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(400).json({ success: false, message: "No company linked" });

        const effectivePlan = req.effectivePlan;
        if (!effectivePlan) return res.status(400).json({ success: false, message: "No active plan" });

        const { type, quantity } = req.body;
        if (!type || !["Admin", "Staff"].includes(type)) {
            return res.status(400).json({ success: false, message: "Invalid type. Must be Admin or Staff." });
        }
        if (!quantity || isNaN(quantity) || quantity < 1) {
            return res.status(400).json({ success: false, message: "Invalid quantity." });
        }

        const unitPriceUsd = type === "Admin" ? (effectivePlan.extraAdminPrice || 10) : (effectivePlan.extraStaffPrice || 5);
        const priceUsd = unitPriceUsd * quantity;

        const usdInrRate = 83; // Fixed conversion rate as requested
        const priceInr = Math.round(priceUsd * usdInrRate);
        const amountPaise = Math.round(priceInr * 100);

        const razorpay = await getRazorpayClientAsync();
        const order = await razorpay.orders.create({
            amount: amountPaise,
            currency: "INR",
            receipt: `as_topup_${Date.now().toString().slice(-8)}`,
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
            priceUsd: priceUsd,
            type,
            quantity
        });
    } catch (error) {
        console.error("Admin/Staff Top-up Order Error:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to create order" });
    }
});

/**
 * POST /api/admin-staff-payments/razorpay/verify
 * Verify Razorpay payment and credit slots
 */
router.post("/razorpay/verify", verifyToken, requireActivePlan, async (req, res) => {
    try {
        const userId = req.userId;
        const companyId = req.user?.company_id;
        
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, type, quantity } = req.body;
        
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !type || !quantity) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
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
        const unitPriceUsd = type === "Admin" ? (effectivePlan.extraAdminPrice || 10) : (effectivePlan.extraStaffPrice || 5);
        const priceUsd = unitPriceUsd * quantity;
        
        const usdInrRate = 83; // Fixed conversion rate as requested
        const priceInr = Math.round(priceUsd * usdInrRate);

        const payment = new AdminStaffPayment({
            companyId,
            userId,
            type,
            quantityAdded: quantity,
            amountPaid: priceInr,
            status: "Completed",
            transactionId: razorpay_payment_id,
        });
        await payment.save();

        // Update active subscription with the new slots
        const subscription = await CompanySubscription.findOne({ companyId, status: { $in: ["Trial", "Active"] } })
            .sort({ createdAt: -1 });

        if (subscription) {
            if (type === "Admin") {
                subscription.extraAdminsPurchased = (subscription.extraAdminsPurchased || 0) + quantity;
                // Ensure allocatedAdmins is at least the base plan's admins before adding
                const baseAdmins = effectivePlan.maxAdmins || 0;
                subscription.allocatedAdmins = Math.max(subscription.allocatedAdmins || 0, baseAdmins) + quantity;
            } else {
                subscription.extraStaffPurchased = (subscription.extraStaffPurchased || 0) + quantity;
                // Ensure allocatedStaff is at least the base plan's staff before adding
                const baseStaff = effectivePlan.maxStaff || 0;
                subscription.allocatedStaff = Math.max(subscription.allocatedStaff || 0, baseStaff) + quantity;
            }
            await subscription.save();
        }

        const userDoc = await mongoose.model("User").findById(userId);

        let emailSent = false;
        try {
            if (userDoc && userDoc.email) {
                await sendEmail({
                    to: userDoc.email,
                    subject: `${type} Top-Up Successful`,
                    text: `Your purchase of ${quantity} extra ${type} slot(s) for ₹${priceInr} was successful.`,
                    html: `<h3>Payment Successful!</h3><p>Your purchase of <b>${quantity} ${type} slot(s)</b> for ₹${priceInr} was successfully applied to your account.</p>`
                });
                emailSent = true;
                payment.receiptEmailSent = true;
            }
        } catch (e) {
            console.error("Failed to send Admin/Staff top-up email", e);
        }

        let whatsappSent = false;
        try {
            console.log(`[${type} Top-Up] Preparing to send WhatsApp. User mobile:`, userDoc?.mobile);
            if (userDoc && userDoc.mobile) {
                const { sendNeoTemplateMessage } = require("../utils/otpService");
                const templateName = process.env.NEO_ADMIN_STAFF_UPGRADE_TEMPLATE_NAME || "admin_staff_upgrade";
                
                const sent = await sendNeoTemplateMessage({
                    phoneNumber: userDoc.mobile,
                    templateName: templateName,
                    parameters: [
                        String(quantity),
                        String(type),
                        String(priceInr)
                    ]
                });
                
                if (sent) {
                    whatsappSent = true;
                    payment.whatsappSent = true;
                }
            } else {
                console.log(`[${type} Top-Up] User does not have a mobile number set, skipping WhatsApp.`);
            }
        } catch (e) {
            console.error(`Failed to send ${type} top-up WhatsApp`, e);
        }

        await payment.save();

        const receipt = {
            receiptNumber: `UPG-${payment._id.toString().slice(-6).toUpperCase()}`,
            customerName: userDoc?.name || "-",
            customerEmail: userDoc?.email || "-",
            planName: `Extra ${type} Top-Up`,
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
            pricing: { finalPrice: priceUsd }, // Sent as USD to avoid frontend double multiplication
            plan: { name: `Extra ${type} Top-Up` }
        });
    } catch (error) {
        console.error("Admin/Staff Payment Verify Error:", error);
        return res.status(500).json({ success: false, message: "Verification failed" });
    }
});

module.exports = router;
