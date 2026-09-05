const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const FollowUp = require("../models/FollowUp");
const { verifyToken } = require("../middleware/auth");

// Get All Stats
router.get("/stats", verifyToken, async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0];
        let query = {};
        if (req.user.role === "Staff" && req.user.parentUserId) {
            query.userId = new mongoose.Types.ObjectId(req.user.parentUserId);
            query.assignedTo = new mongoose.Types.ObjectId(req.userId);
        } else {
            query.userId = new mongoose.Types.ObjectId(req.userId);
        }

        // Enquiry stats
        const enqCounts = await Enquiry.aggregate([
            { $match: query },
            { $group: { _id: "$status", count: { $sum: 1 } } }
        ]);

        const enqStats = {
            newEnqs: 0,
            contacted: 0,
            interested: 0,
            notInterested: 0,
            converted: 0,
            closed: 0,
        };

        enqCounts.forEach(c => {
            if (c._id === "New") enqStats.newEnqs = c.count;
            if (c._id === "Contacted" || c._id === "In Progress") enqStats.contacted = c.count;
            if (c._id === "Interested") enqStats.interested = c.count;
            if (c._id === "Not Interested" || c._id === "Dropped") enqStats.notInterested = c.count;
            if (c._id === "Converted") enqStats.converted = c.count;
            if (c._id === "Closed") enqStats.closed = c.count;
        });

        // Followup stats
        const todayFollowups = await FollowUp.countDocuments({ ...query, isCurrent: { $ne: false }, date: today });
        const upcomingFollowups = await FollowUp.countDocuments({ ...query, isCurrent: { $ne: false }, date: { $gt: today } });
        const completedFollowups = await FollowUp.countDocuments({ ...query, status: "Completed" });

        // Conversion rate
        const totalEnqs = await Enquiry.countDocuments(query);
        const convertedEnqs = enqStats.converted;
        const conversionRate = totalEnqs > 0 ? Math.round((convertedEnqs / totalEnqs) * 100) : 0;

        const stats = {
            enquiry: enqStats,
            followup: {
                today: todayFollowups,
                upcoming: upcomingFollowups,
                missed: 0, // Logic for missed could be added if needed
                completed: completedFollowups,
            },
            conversion: {
                total: totalEnqs,
                converted: convertedEnqs,
                rate: conversionRate,
            },
        };

        res.json(stats);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Get Detailed Lists
router.get("/list", verifyToken, async (req, res) => {
    try {
        const { type, filter } = req.query;
        const today = new Date().toISOString().split("T")[0];
        let baseQuery = {};
        if (req.user.role === "Staff" && req.user.parentUserId) {
            baseQuery.userId = new mongoose.Types.ObjectId(req.user.parentUserId);
            baseQuery.assignedTo = new mongoose.Types.ObjectId(req.userId);
        } else {
            baseQuery.userId = new mongoose.Types.ObjectId(req.userId);
        }

        let data = [];

        if (type === "enquiry") {
            let query = { ...baseQuery };
            if (filter === "new") query.status = "New";
            else if (filter === "inprogress") query.status = "Contacted";
            else if (filter === "contacted") query.status = "Contacted";
            else if (filter === "interested") query.status = "Interested";
            else if (filter === "notinterested") query.status = "Not Interested";
            else if (filter === "converted") query.status = "Converted";
            else if (filter === "closed") query.status = "Closed";
            else if (filter === "dropped") query.status = "Not Interested";

            data = await Enquiry.find(query).sort({ createdAt: -1 }).lean();
        } else if (type === "followup") {
            let query = { ...baseQuery };
            if (filter === "today") query.date = today;
            else if (filter === "completed") query.status = "Completed";

            if (filter !== "completed") query.isCurrent = { $ne: false };
            data = await FollowUp.find(query).sort({ date: -1 }).populate("enqId").lean();
        } else if (type === "conversion") {
            data = await Enquiry.find({ ...baseQuery, status: "Converted" }).sort({ createdAt: -1 }).lean();
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
