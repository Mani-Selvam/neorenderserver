const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Company = require("../models/Company");
const CompanySubscription = require("../models/CompanySubscription");
const Enquiry = require("../models/Enquiry");
const FollowUp = require("../models/FollowUp");
const CommunicationMessage = require("../models/CommunicationMessage");
const CommunicationTask = require("../models/CommunicationTask");
const bcrypt = require("bcryptjs");
const { resolveEffectivePlan } = require("../services/planResolver");
const cache = require("../utils/responseCache");

// Auth + tenant middlewares
const { verifyToken } = require("../middleware/auth");
const { requireCompany, requireRole } = require("../middleware/tenant");

// GET ALL STAFF (Scoped to current Admin)
// List admins + staff for the authenticated user's company (Admin-only)
router.get(
    "/",
    verifyToken,
    requireCompany,
    requireRole("Admin"),
    async (req, res) => {
        try {
            const team = await User.find({
                company_id: req.companyId,
                role: { $in: ["Admin", "admin", "Staff", "staff"] },
            })
                .sort({ role: 1, createdAt: -1 })
                .select("-password")
                .lean();
            res.status(200).json(team);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    },
);

const mapMongoUserError = (error) => {
    if (error?.code === 11000) {
        if (
            error?.keyPattern?.email ||
            String(error?.message || "").includes("email_1")
        ) {
            return {
                status: 409,
                body: { error: "This email already exists in your company" },
            };
        }
        if (
            error?.keyPattern?.mobile ||
            String(error?.message || "").includes("mobile_1")
        ) {
            return {
                status: 409,
                body: {
                    error: "This mobile number is already used by another account",
                },
            };
        }
    }
    return null;
};

const normalizeEmail = (value) =>
    String(value || "")
        .trim()
        .toLowerCase();

const isPrimaryCompanyUser = async (user) => {
    if (!user?.company_id) return false;
    const primary = await User.findOne({ company_id: user.company_id })
        .sort({ createdAt: 1, _id: 1 })
        .select("_id company_id")
        .lean();
    return Boolean(primary?._id && String(primary._id) === String(user._id));
};

// GET STAFF BY COMPANY
// Get staff by company (only allowed for admins of that company)
router.get("/company/:companyId", verifyToken, async (req, res) => {
    try {
        // Only allow if requesting own company
        if (
            !req.user ||
            !req.user.company_id ||
            req.user.company_id.toString() !== req.params.companyId
        ) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const staff = await User.find({
            role: { $in: ["Staff", "staff"] },
            company_id: req.params.companyId,
        })
            .select("-password")
            .lean();
        res.status(200).json(staff);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET SINGLE STAFF
// Get single staff (must belong to requester's company)
router.get("/:id", verifyToken, requireCompany, async (req, res) => {
    try {
        const staff = await User.findById(req.params.id)
            .select("-password")
            .lean();
        if (!staff) return res.status(404).json({ error: "Staff not found" });
        if (staff.company_id && staff.company_id.toString() !== req.companyId) {
            return res.status(403).json({ error: "Forbidden" });
        }
        res.status(200).json(staff);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// CREATE STAFF (Admin-only, enforces company plan staffLimit)
router.post(
    "/",
    verifyToken,
    requireCompany,
    requireRole("Admin"),
    async (req, res) => {
        try {
            const { name, email, mobile, password, status, role } = req.body;
            const normalizedEmail = normalizeEmail(email);
            const normalizedRole = String(role || "Staff").trim();
            const isAdminRole =
                String(normalizedRole).toLowerCase() === "admin";
            const targetRole = isAdminRole ? "Admin" : "Staff";

            if (!name || !normalizedEmail || !password) {
                return res
                    .status(400)
                    .json({ error: "Name, email, and password are required" });
            }

            const companyId = req.companyId;

            const company = await Company.findById(companyId).lean();
            if (!company)
                return res.status(400).json({ error: "Company not found" });

            let maxStaff = 0;
            let maxAdmins = 0;
            let currentStaff = 0;
            let currentAdmins = 0;
            try {
                const anySubscription = await CompanySubscription.findOne({
                    companyId,
                })
                    .select("_id")
                    .sort({ createdAt: -1 })
                    .lean();

                const resolved = await resolveEffectivePlan(companyId);
                if (resolved?.hasPlan) {
                    maxStaff = Number(resolved?.plan?.maxStaff || 0);
                    maxAdmins = Number(resolved?.plan?.maxAdmins || 0);
                    currentStaff = Number(resolved?.plan?.staffUsed || 0);
                    currentAdmins = Number(resolved?.plan?.adminsUsed || 0);
                } else if (!anySubscription) {
                    maxStaff = Number(
                        (company.plan && company.plan.staffLimit) || 0,
                    );
                    maxAdmins = 1;
                } else {
                    maxStaff = 0;
                    maxAdmins = 0;
                }
            } catch (e) {
                maxStaff = Number(
                    (company.plan && company.plan.staffLimit) || 0,
                );
                maxAdmins = 1;
                [currentStaff, currentAdmins] = await Promise.all([
                    User.countDocuments({
                        company_id: companyId,
                        role: { $in: ["Staff", "staff"] },
                    }),
                    User.countDocuments({
                        company_id: companyId,
                        role: { $in: ["Admin", "admin"] },
                    }),
                ]);
            }

            if (!isAdminRole && maxStaff > 0 && currentStaff >= maxStaff) {
                return res.status(403).json({
                    error: "Staff limit reached for your plan",
                    code: "STAFF_LIMIT_REACHED",
                    limit: maxStaff,
                    current: currentStaff,
                });
            }

            if (isAdminRole && maxAdmins > 0 && currentAdmins >= maxAdmins) {
                return res.status(403).json({
                    error: "Admin limit reached for your plan",
                    code: "ADMIN_LIMIT_REACHED",
                    limit: maxAdmins,
                    current: currentAdmins,
                });
            }

            if (
                (!isAdminRole && maxStaff === 0) ||
                (isAdminRole && maxAdmins === 0)
            ) {
                return res.status(403).json({
                    error: `No active plan. Please choose a plan to add ${isAdminRole ? "admin" : "staff"}.`,
                    code: "NO_ACTIVE_PLAN",
                });
            }

            // Check email uniqueness within company
            const existingUser = await User.findOne({
                company_id: companyId,
                email: normalizedEmail,
            });
            if (existingUser)
                return res
                    .status(400)
                    .json({
                        error: "This email already exists in your company",
                    });

            const usersWithSameEmail = await User.find({
                email: normalizedEmail,
                company_id: { $ne: companyId },
            })
                .select("_id company_id password")
                .lean();

            for (const candidate of usersWithSameEmail) {
                if (await isPrimaryCompanyUser(candidate)) {
                    return res.status(409).json({
                        error: "This email is already used as another company's main account",
                    });
                }

                if (
                    candidate?.password &&
                    (await bcrypt.compare(password, candidate.password))
                ) {
                    return res.status(409).json({
                        error: "This email and password already exist in another company. Please change email or password.",
                    });
                }
            }

            const newStaff = new User({
                name,
                email: normalizedEmail,
                mobile,
                password,
                visiblePassword: password,
                status: status || "Active",
                role: targetRole,
                company_id: companyId,
            });

            const savedStaff = await newStaff.save();

            res.status(201).json({
                id: savedStaff._id,
                name: savedStaff.name,
                email: savedStaff.email,
                mobile: savedStaff.mobile,
                status: savedStaff.status,
                role: savedStaff.role,
                company_id: savedStaff.company_id,
            });
        } catch (error) {
            const mapped = mapMongoUserError(error);
            if (mapped) return res.status(mapped.status).json(mapped.body);
            res.status(500).json({ error: error.message });
        }
    },
);

// UPDATE STAFF (Scoped check recommended)
router.put(
    "/:id",
    verifyToken,
    requireCompany,
    requireRole("Admin"),
    async (req, res) => {
        try {
            const { name, mobile, status, company_id, password, role } =
                req.body;

            const updateData = {};
            if (name) updateData.name = name;
            if (mobile) updateData.mobile = mobile;
            if (status) updateData.status = status;
            if (company_id) updateData.company_id = company_id;

            // If password provided, hash it before updating
            if (password) {
                const salt = await bcrypt.genSalt(10);
                updateData.password = await bcrypt.hash(password, salt);
                updateData.visiblePassword = password;
            }

            const staff = await User.findById(req.params.id);
            if (!staff)
                return res.status(404).json({ error: "Staff not found" });
            if (
                staff.company_id &&
                staff.company_id.toString() !== req.companyId
            )
                return res.status(403).json({ error: "Forbidden" });

            if (role) {
                const normalizedRole = String(role || "Staff")
                    .trim()
                    .toLowerCase();
                if (!["admin", "staff"].includes(normalizedRole)) {
                    return res.status(400).json({ error: "Invalid role" });
                }

                const nextRole = normalizedRole === "admin" ? "Admin" : "Staff";
                const currentRole = String(staff.role || "Staff")
                    .trim()
                    .toLowerCase();

                if (currentRole !== normalizedRole) {
                    const companyId = req.companyId;
                    const company = await Company.findById(companyId).lean();
                    if (!company) {
                        return res
                            .status(400)
                            .json({ error: "Company not found" });
                    }

                    let maxStaff = 0;
                    let maxAdmins = 0;
                    let currentStaff = 0;
                    let currentAdmins = 0;

                    try {
                        const anySubscription =
                            await CompanySubscription.findOne({ companyId })
                                .select("_id")
                                .sort({ createdAt: -1 })
                                .lean();

                        const resolved = await resolveEffectivePlan(companyId);
                        if (resolved?.hasPlan) {
                            maxStaff = Number(resolved?.plan?.maxStaff || 0);
                            maxAdmins = Number(resolved?.plan?.maxAdmins || 0);
                            currentStaff = Number(
                                resolved?.plan?.staffUsed || 0,
                            );
                            currentAdmins = Number(
                                resolved?.plan?.adminsUsed || 0,
                            );
                        } else if (!anySubscription) {
                            maxStaff = Number(
                                (company.plan && company.plan.staffLimit) || 0,
                            );
                            maxAdmins = 1;
                        } else {
                            maxStaff = 0;
                            maxAdmins = 0;
                        }
                    } catch (_) {
                        maxStaff = Number(
                            (company.plan && company.plan.staffLimit) || 0,
                        );
                        maxAdmins = 1;
                        currentStaff = await User.countDocuments({
                            company_id: companyId,
                            role: { $in: ["Staff", "staff"] },
                        });
                        currentAdmins = await User.countDocuments({
                            company_id: companyId,
                            role: { $in: ["Admin", "admin"] },
                        });
                    }

                    if (
                        normalizedRole === "staff" &&
                        maxStaff > 0 &&
                        currentStaff >= maxStaff
                    ) {
                        return res.status(403).json({
                            error: "Your current plan does not allow more staff members",
                            code: "STAFF_LIMIT_REACHED",
                            limit: maxStaff,
                        });
                    }

                    if (
                        normalizedRole === "admin" &&
                        maxAdmins > 0 &&
                        currentAdmins >= maxAdmins
                    ) {
                        return res.status(403).json({
                            error: "Your current plan does not allow more admins",
                            code: "ADMIN_LIMIT_REACHED",
                            limit: maxAdmins,
                        });
                    }

                    if (
                        (normalizedRole === "staff" && maxStaff === 0) ||
                        (normalizedRole === "admin" && maxAdmins === 0)
                    ) {
                        return res.status(403).json({
                            error: "No active plan found. Please upgrade to add team members.",
                            code: "NO_ACTIVE_PLAN",
                        });
                    }
                }

                updateData.role = nextRole;
            }

            Object.assign(staff, updateData);
            await staff.save();

            res.status(200).json(staff);
        } catch (error) {
            const mapped = mapMongoUserError(error);
            if (mapped) return res.status(mapped.status).json(mapped.body);
            res.status(500).json({ error: error.message });
        }
    },
);

// UPDATE STAFF STATUS (Toggle Active/Inactive)
router.patch(
    "/:id/status",
    verifyToken,
    requireCompany,
    requireRole("Admin"),
    async (req, res) => {
        try {
            const { status } = req.body;

            if (!status || !["Active", "Inactive"].includes(status)) {
                return res.status(400).json({
                    error: "Status must be 'Active' or 'Inactive'",
                });
            }

            const staff = await User.findByIdAndUpdate(
                req.params.id,
                { status },
                { returnDocument: "after", runValidators: true },
            ).select("-password");

            if (!staff)
                return res.status(404).json({ error: "Staff not found" });
            if (
                staff.company_id &&
                staff.company_id.toString() !== req.companyId
            )
                return res.status(403).json({ error: "Forbidden" });
            staff.status = status;
            await staff.save();
            res.status(200).json({
                message: `Staff status updated to ${status}`,
                staff,
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    },
);

// DELETE STAFF
router.delete(
    "/:id",
    verifyToken,
    requireCompany,
    requireRole("Admin"),
    async (req, res) => {
        try {
            const staff = await User.findById(req.params.id);
            if (!staff)
                return res.status(404).json({ error: "Staff not found" });
            if (
                staff.company_id &&
                staff.company_id.toString() !== req.companyId
            )
                return res.status(403).json({ error: "Forbidden" });

            const staffId = staff._id;

            const relatedEnquiries = await Enquiry.find({
                companyId: req.companyId,
                assignedTo: staffId,
            })
                .select("_id enqNo")
                .lean();
            const relatedEnquiryIds = relatedEnquiries.map((item) => item._id);
            const relatedEnquiryNos = relatedEnquiries
                .map((item) => item.enqNo)
                .filter(Boolean);

            const followUpDeleteOr = [{ assignedTo: staffId }];
            const communicationTaskDeleteOr = [
                { assignedTo: staffId },
                { createdBy: staffId },
            ];

            if (relatedEnquiryIds.length > 0) {
                followUpDeleteOr.push({ enqId: { $in: relatedEnquiryIds } });
                communicationTaskDeleteOr.push({
                    relatedEnquiryId: { $in: relatedEnquiryIds },
                });
            }

            if (relatedEnquiryNos.length > 0) {
                followUpDeleteOr.push({ enqNo: { $in: relatedEnquiryNos } });
            }

            await Promise.all([
                Enquiry.deleteMany({
                    companyId: req.companyId,
                    assignedTo: staffId,
                }),
                FollowUp.deleteMany({
                    companyId: req.companyId,
                    $or: followUpDeleteOr,
                }),
                CommunicationMessage.deleteMany({
                    companyId: req.companyId,
                    $or: [{ senderId: staffId }, { receiverId: staffId }],
                }),
                CommunicationTask.deleteMany({
                    companyId: req.companyId,
                    $or: communicationTaskDeleteOr,
                }),
            ]);

            await staff.deleteOne();

            cache.invalidate("dashboard");
            cache.invalidate("enquiries");
            cache.invalidate("followups");

            res.status(200).json({ message: "Staff deleted successfully" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    },
);

module.exports = router;
