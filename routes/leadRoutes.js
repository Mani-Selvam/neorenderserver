const express = require("express");
const router = express.Router();
const { sendNeoTemplateMessage } = require("../utils/enquiryTemplateService");
const WebsiteLead = require("../models/WebsiteLead");

const { ensureEnvLoaded } = require("../config/loadEnv");
ensureEnvLoaded();

/**
 * POST /api/lead/contact
 * Public endpoint — website "Get Started" form submission.
 * Saves the lead to the database and sends a WhatsApp template message.
 */
router.post("/contact", async (req, res) => {
    try {
        const { name, email, phone, company, city } = req.body || {};

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: "Name is required." });
        }
        if (!phone || !String(phone).trim()) {
            return res.status(400).json({ error: "Phone number is required." });
        }
        if (!company || !String(company).trim()) {
            return res.status(400).json({ error: "Company name is required." });
        }

        const cleanName    = String(name).trim();
        const cleanEmail   = String(email || "").trim();
        const cleanPhone   = String(phone).trim();
        const cleanCompany = String(company).trim();
        const cleanCity    = String(city || "").trim();

        // Save lead to database
        const lead = await WebsiteLead.create({
            name: cleanName,
            email: cleanEmail,
            phone: cleanPhone,
            company: cleanCompany,
            city: cleanCity,
            ip: req.ip || req.headers["x-forwarded-for"] || "",
            userAgent: req.headers["user-agent"] || "",
        });

        console.log(`[LeadRoute] Lead saved: _id=${lead._id}, name=${cleanName}, phone=${cleanPhone}`);

        const templateName = String(
            process.env.NEO_CLIENT_TEMPLATE_NAME ||
            process.env.NEO_ENQUIRY_TEMPLATE_NAME ||
            ""
        ).trim();

        const token = String(process.env.NEO_WHATSAPP_API_TOKEN || "").trim();

        if (!token) {
            console.warn("[LeadRoute] NEO_WHATSAPP_API_TOKEN not set. Lead saved without WhatsApp.");
            return res.json({ success: true, message: "Lead received (WhatsApp not configured)." });
        }

        // Template parameters: name, company, city (skip city if empty)
        const parameters = [cleanName, cleanCompany];
        if (cleanCity) parameters.push(cleanCity);

        const sent = await sendNeoTemplateMessage({
            phoneNumber: cleanPhone,
            templateName: templateName || "neo_client_welcome",
            parameters,
        });

        // Update WhatsApp delivery status
        if (sent) {
            await WebsiteLead.updateOne({ _id: lead._id }, { whatsappSent: true });
            console.log(`[LeadRoute] WhatsApp sent to ${cleanPhone} for ${cleanName} (${cleanCompany})`);
            return res.json({ success: true, message: "WhatsApp message sent successfully." });
        } else {
            console.warn(`[LeadRoute] WhatsApp send returned false for ${cleanPhone}`);
            return res.json({ success: true, message: "Lead received." });
        }
    } catch (err) {
        console.error("[LeadRoute] Error:", err.message || err);
        return res.status(500).json({ error: "Failed to process your request. Please try again." });
    }
});

module.exports = router;
