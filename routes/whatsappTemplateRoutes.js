const express = require("express");
const router = express.Router();
const OfficialWhatsappTemplate = require("../models/OfficialWhatsappTemplate");
const { verifyToken } = require("../middleware/auth");

// GET /api/official-templates
router.get("/", verifyToken, async (req, res) => {
    try {
        const ownerId = req.user.role === "Staff" && req.user.parentUserId ? req.user.parentUserId : req.userId;
        const companyId = req.query.companyId || req.user.company_id || null;

        const query = companyId ? { companyId } : { ownerUserId: ownerId };
        const templates = await OfficialWhatsappTemplate.find(query).sort({ createdAt: -1 }).lean();
        
        return res.json({ ok: true, templates });
    } catch (e) {
        console.error("Error fetching templates:", e.message);
        return res.status(500).json({ ok: false, message: e.message });
    }
});

// POST /api/official-templates
router.post("/", verifyToken, async (req, res) => {
    try {
        const ownerId = req.user.role === "Staff" && req.user.parentUserId ? req.user.parentUserId : req.userId;
        const companyId = req.user.company_id || null;
        
        const { name, language, category, contentPreview, buttonIndex, status } = req.body;
        
        if (!name) return res.status(400).json({ ok: false, message: "Template Name is required" });

        const existing = await OfficialWhatsappTemplate.findOne({ 
            name: name.trim(), 
            ...(companyId ? { companyId } : { ownerUserId: ownerId }) 
        });

        if (existing) {
            return res.status(400).json({ ok: false, message: "A template with this name already exists" });
        }

        const template = new OfficialWhatsappTemplate({
            ownerUserId: ownerId,
            companyId,
            name: name.trim(),
            language: String(language || "en").trim(),
            category: String(category || "General").trim(),
            contentPreview: String(contentPreview || "").trim(),
            buttonIndex: typeof buttonIndex === "number" ? buttonIndex : 0,
            status: status === "Inactive" ? "Inactive" : "Active"
        });

        await template.save();
        return res.json({ ok: true, template });
    } catch (e) {
        console.error("Error creating template:", e.message);
        return res.status(500).json({ ok: false, message: e.message });
    }
});

// PUT /api/official-templates/:id
router.put("/:id", verifyToken, async (req, res) => {
    try {
        const ownerId = req.user.role === "Staff" && req.user.parentUserId ? req.user.parentUserId : req.userId;
        const companyId = req.user.company_id || null;
        
        const templateId = req.params.id;
        const query = { _id: templateId, ...(companyId ? { companyId } : { ownerUserId: ownerId }) };
        
        const template = await OfficialWhatsappTemplate.findOne(query);
        if (!template) {
            return res.status(404).json({ ok: false, message: "Template not found" });
        }

        const { name, language, category, contentPreview, buttonIndex, status } = req.body;
        
        if (name) template.name = name.trim();
        if (language !== undefined) template.language = String(language).trim();
        if (category !== undefined) template.category = String(category).trim();
        if (contentPreview !== undefined) template.contentPreview = String(contentPreview).trim();
        if (buttonIndex !== undefined) template.buttonIndex = typeof buttonIndex === "number" ? buttonIndex : 0;
        if (status) template.status = status === "Inactive" ? "Inactive" : "Active";

        await template.save();
        return res.json({ ok: true, template });
    } catch (e) {
        console.error("Error updating template:", e.message);
        return res.status(500).json({ ok: false, message: e.message });
    }
});

// DELETE /api/official-templates/:id
router.delete("/:id", verifyToken, async (req, res) => {
    try {
        const ownerId = req.user.role === "Staff" && req.user.parentUserId ? req.user.parentUserId : req.userId;
        const companyId = req.user.company_id || null;
        
        const templateId = req.params.id;
        const query = { _id: templateId, ...(companyId ? { companyId } : { ownerUserId: ownerId }) };
        
        const result = await OfficialWhatsappTemplate.deleteOne(query);
        if (result.deletedCount === 0) {
            return res.status(404).json({ ok: false, message: "Template not found" });
        }

        return res.json({ ok: true });
    } catch (e) {
        console.error("Error deleting template:", e.message);
        return res.status(500).json({ ok: false, message: e.message });
    }
});

module.exports = router;
