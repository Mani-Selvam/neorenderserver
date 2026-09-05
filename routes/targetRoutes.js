const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Target = require("../models/Target");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const { verifyToken } = require("../middleware/auth");
const { requireCompany, requireRole } = require("../middleware/tenant");

const parseIntSafe = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
};

const monthRange = (year, month) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start, end };
};

router.get("/progress", verifyToken, requireCompany, requireRole(["admin", "staff"]), async (req, res) => {
  try {
    const companyId = req.companyId;
    const year = parseIntSafe(req.query.year);
    const month = parseIntSafe(req.query.month);

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: "Valid year and month are required" });
    }

    const { start, end } = monthRange(year, month);

    const allUsers = await User.find({
      company_id: companyId,
      status: "Active",
    }).select("_id name").lean();

    const ownerIds = allUsers.map((u) => u._id);
    const baseMatch = ownerIds.length
      ? { userId: { $in: ownerIds.map((id) => new mongoose.Types.ObjectId(id)) } }
      : { userId: { $in: [] } };

    const createdMatch = { ...baseMatch, createdAt: { $gte: start, $lt: end } };
    const convertedMatch = {
      ...baseMatch,
      status: "Converted",
      $or: [
        { conversionDate: { $gte: start, $lt: end } },
        { conversionDate: null, updatedAt: { $gte: start, $lt: end } },
      ],
    };

    const [target, agg] = await Promise.all([
      Target.findOne({ company_id: companyId, year, month }).lean(),
      Enquiry.aggregate([
        {
          $facet: {
            leadsCreated: [
              { $match: createdMatch },
              { $count: "count" },
            ],
            converted: [
              { $match: convertedMatch },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  revenue: { $sum: { $toDouble: "$cost" } },
                },
              },
            ],
            statusBreakdown: [
              { $match: createdMatch },
              { $group: { _id: "$status", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            topAssigneesConverted: [
              { $match: convertedMatch },
              {
                $group: {
                  _id: { $ifNull: ["$assignedTo", "$userId"] },
                  converted: { $sum: 1 },
                  revenue: { $sum: { $toDouble: "$cost" } },
                },
              },
              { $sort: { converted: -1, revenue: -1 } },
              { $limit: 6 },
              {
                $lookup: {
                  from: "users",
                  localField: "_id",
                  foreignField: "_id",
                  as: "user",
                },
              },
              { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
              {
                $project: {
                  userId: "$_id",
                  name: "$user.name",
                  role: "$user.role",
                  converted: 1,
                  revenue: 1,
                },
              },
            ],
            topAssigneesLeads: [
              { $match: createdMatch },
              { $group: { _id: { $ifNull: ["$assignedTo", "$userId"] }, leads: { $sum: 1 } } },
              { $sort: { leads: -1 } },
              { $limit: 12 },
            ],
          },
        },
      ]),
    ]);

    const leadsCreated = agg?.[0]?.leadsCreated?.[0]?.count || 0;
    const convertedCount = agg?.[0]?.converted?.[0]?.count || 0;
    const revenue = agg?.[0]?.converted?.[0]?.revenue || 0;
    const statusBreakdown = agg?.[0]?.statusBreakdown || [];

    const leadsByAssignee = new Map();
    (agg?.[0]?.topAssigneesLeads || []).forEach((row) => {
      leadsByAssignee.set(String(row._id || ""), row.leads || 0);
    });

    const topAssignees = (agg?.[0]?.topAssigneesConverted || []).map((row) => {
      let displayName = row.name || "Unassigned";
      
      if (row.role && ["admin", "superadmin", "Admin", "SuperAdmin"].includes(row.role)) {
         displayName = `${row.name} (Admin)`;
      }

      return {
        userId: row.userId || null,
        name: displayName,
        leads: leadsByAssignee.get(String(row.userId || "")) || 0,
        converted: row.converted || 0,
        revenue: row.revenue || 0,
      };
    });

    return res.status(200).json({
      year,
      month,
      target: target || null,
      actuals: {
        leadsCreated,
        convertedCount,
        revenue,
      },
      statusBreakdown,
      topAssignees,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get("/", verifyToken, requireCompany, requireRole(["admin", "staff"]), async (req, res) => {
  try {
    const companyId = req.companyId;
    const year = parseIntSafe(req.query.year);
    const month = parseIntSafe(req.query.month);

    const baseFilter = { company_id: companyId };

    const target = year && month
      ? await Target.findOne({ ...baseFilter, year, month }).lean()
      : null;

    const targets = await Target.find(baseFilter)
      .sort({ year: -1, month: -1 })
      .limit(24)
      .lean();

    return res.status(200).json({ target: target || null, targets });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/", verifyToken, requireCompany, requireRole("admin"), async (req, res) => {
  try {
    const companyId = req.companyId;
    const year = parseIntSafe(req.body.year);
    const month = parseIntSafe(req.body.month);

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: "Valid year and month are required" });
    }

    const update = {
      leadsTarget: parseIntSafe(req.body.leadsTarget),
      confirmedProjectsTarget: parseIntSafe(req.body.confirmedProjectsTarget),
      marketingBudget: parseIntSafe(req.body.marketingBudget),
      incomeTarget: parseIntSafe(req.body.incomeTarget),
      updatedBy: req.userId,
    };

    const exists = await Target.findOne({ company_id: companyId, year, month }).select("_id").lean();
    if (!exists) {
      const doc = new Target({
        company_id: companyId,
        year,
        month,
        ...update,
        createdBy: req.userId,
      });
      const saved = await doc.save();
      return res.status(201).json(saved);
    }

    const updated = await Target.findOneAndUpdate(
      { company_id: companyId, year, month },
      { $set: update },
      { returnDocument: "after", runValidators: true },
    );
    return res.status(200).json(updated);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "Target already exists for this month" });
    }
    return res.status(500).json({ error: error.message });
  }
});

router.put("/:id", verifyToken, requireCompany, requireRole("admin"), async (req, res) => {
  try {
    const companyId = req.companyId;
    const id = req.params.id;

    const update = {
      leadsTarget: parseIntSafe(req.body.leadsTarget),
      confirmedProjectsTarget: parseIntSafe(req.body.confirmedProjectsTarget),
      marketingBudget: parseIntSafe(req.body.marketingBudget),
      incomeTarget: parseIntSafe(req.body.incomeTarget),
      updatedBy: req.userId,
    };

    const updated = await Target.findOneAndUpdate(
      { _id: id, company_id: companyId },
      { $set: update },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) return res.status(404).json({ error: "Target not found" });
    return res.status(200).json(updated);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", verifyToken, requireCompany, requireRole("admin"), async (req, res) => {
  try {
    const companyId = req.companyId;
    const id = req.params.id;
    const deleted = await Target.findOneAndDelete({ _id: id, company_id: companyId });
    if (!deleted) return res.status(404).json({ error: "Target not found" });
    return res.status(200).json({ message: "Target deleted successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
