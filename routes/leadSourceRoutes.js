const express = require("express");
const router = express.Router();
const LeadSource = require("../models/LeadSource");
const { verifyToken } = require("../middleware/auth");

const DEFAULT_LEAD_SOURCE_NAMES = ["Direct", "Walkin", "Website"];

const getLeadSourceOwnerId = async (req) => {
    const isStaff = String(req.user?.role || "").toLowerCase() === "staff";
    if (isStaff && req.user?.company_id) {
        if (req.user.parentUserId) return req.user.parentUserId;
        const User = require("../models/User");
        const admin = await User.findOne({
            company_id: req.user.company_id,
            role: { $in: ["admin", "Admin"] },
            status: "Active"
        }).sort({ createdAt: 1 }).select("_id").lean();
        if (admin) return admin._id;
    }
    return req.userId;
};

const ensureGlobalLeadSources = async () => {
    const existing = await LeadSource.find({ isGlobal: true }).select("name").lean();
    const existingNames = new Set(
        (existing || []).map((item) => String(item?.name || "").trim().toLowerCase()),
    );
    const missing = DEFAULT_LEAD_SOURCE_NAMES.filter(
        (name) => !existingNames.has(name.toLowerCase()),
    ).map((name) => ({
        name,
        isGlobal: true,
    }));

    if (!missing.length) return;
    await LeadSource.insertMany(missing, { ordered: false }).catch(() => { });
};

// GET ALL LEAD SOURCES
router.get("/", verifyToken, async (req, res) => {
    try {
        const filterUserId = await getLeadSourceOwnerId(req);
        await ensureGlobalLeadSources();

        const leadSources = await LeadSource.find({ 
            $or: [{ isGlobal: true }, { createdBy: filterUserId }] 
        }).lean();
        res.status(200).json(leadSources);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET SINGLE LEAD SOURCE
router.get("/:id", verifyToken, async (req, res) => {
    try {
        const filterUserId = await getLeadSourceOwnerId(req);

        const leadSource = await LeadSource.findOne({ 
            _id: req.params.id, 
            $or: [{ isGlobal: true }, { createdBy: filterUserId }] 
        }).lean();
        if (!leadSource) {
            return res.status(404).json({ error: "Lead source not found or unauthorized" });
        }
        res.status(200).json(leadSource);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// CREATE LEAD SOURCE
router.post("/", verifyToken, async (req, res) => {
    try {
        const { name } = req.body;

        // Validate input
        if (!name?.trim()) {
            return res.status(400).json({
                error: "Lead source name is required",
            });
        }

        // Determine Owner ID (Main User)
        // If Staff creates it, assign ownership to Main User (parentUserId)
        const ownerId = await getLeadSourceOwnerId(req);

        await ensureGlobalLeadSources();

        // Prevent creating duplicate of a global source
        const existingGlobal = await LeadSource.findOne({ name: { $regex: new RegExp(`^${name.trim()}$`, "i") }, isGlobal: true }).lean();
        if (existingGlobal) {
            return res.status(400).json({ error: "A global lead source with this name already exists" });
        }

        const newLeadSource = new LeadSource({
            name: name.trim(),
            createdBy: ownerId,
            isGlobal: false,
        });

        const savedLeadSource = await newLeadSource.save();
        res.status(201).json(savedLeadSource);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPDATE LEAD SOURCE
router.put("/:id", verifyToken, async (req, res) => {
    try {
        const { name } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({ error: "Lead source name is required" });
        }

        const filterUserId = await getLeadSourceOwnerId(req);

        const leadSource = await LeadSource.findOneAndUpdate(
            { _id: req.params.id, createdBy: filterUserId },
            {
                $set: {
                    name: name.trim(),
                    updatedAt: new Date(),
                },
                $unset: {
                    sources: 1,
                    enquiryFields: 1,
                },
            },
            { returnDocument: "after", runValidators: true },
        );

        if (!leadSource) {
            return res.status(404).json({ error: "Lead source not found or unauthorized" });
        }

        res.status(200).json(leadSource);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE LEAD SOURCE
router.delete("/:id", verifyToken, async (req, res) => {
    try {
        const filterUserId = await getLeadSourceOwnerId(req);

        const leadSource = await LeadSource.findOneAndDelete({ _id: req.params.id, createdBy: filterUserId });

        if (!leadSource) {
            return res.status(404).json({ error: "Lead source not found or unauthorized" });
        }

        res.status(200).json({ message: "Lead source deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
