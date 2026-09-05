const express = require("express");
const router = express.Router();
const MessageTemplate = require("../models/MessageTemplate");
const { verifyToken } = require("../middleware/auth");
const cache = require("../utils/responseCache");

// GET all templates for user
router.get("/", verifyToken, async (req, res) => {
    const _start = Date.now();
    try {
        const cacheKey = cache.key('templates', { userId: req.userId });

        const { data: templates, source } = await cache.wrap(cacheKey, async () => {
            return await MessageTemplate.find({ userId: req.userId })
                .sort({ createdAt: -1 })
                .lean();
        }, 60000);

        res.json(templates);
        console.log(`⚡ GET /templates — ${Date.now() - _start}ms ${source}`);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// CREATE template
router.post("/", verifyToken, async (req, res) => {
    try {
        const newTemplate = new MessageTemplate({
            ...req.body,
            userId: req.userId
        });
        const saved = await newTemplate.save();

        cache.invalidate('templates');
        res.status(201).json(saved);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: "Keyword already exists" });
        }
        res.status(400).json({ message: err.message });
    }
});

// UPDATE template
router.put("/:id", verifyToken, async (req, res) => {
    try {
        const updated = await MessageTemplate.findOneAndUpdate(
            { _id: req.params.id, userId: req.userId },
            req.body,
            { returnDocument: "after" }
        );
        if (!updated) return res.status(404).json({ message: "Template not found" });

        cache.invalidate('templates');
        res.json(updated);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// DELETE template
router.delete("/:id", verifyToken, async (req, res) => {
    try {
        const deleted = await MessageTemplate.findOneAndDelete({
            _id: req.params.id,
            userId: req.userId
        });
        if (!deleted) return res.status(404).json({ message: "Template not found" });

        cache.invalidate('templates');
        res.json({ message: "Template deleted" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
