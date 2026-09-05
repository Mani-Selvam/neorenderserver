const mongoose = require("mongoose");

const FOLLOWUP_ACTIVITIES = [
    "Phone Call",
    "Email",
    "WhatsApp",
    "Meeting",
    "Note",
    // Backward compatibility
    "Visit",
    "System",
];

const followUpSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Company",
        index: true,
    },
    enqId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Enquiry",
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Assigned staff member
    enqNo: { type: String, required: true },
    name: { type: String, required: true }, // Cached for easy display
    mobile: { type: String }, // Cached for easy display
    image: { type: String }, // Cached for easy display
    product: { type: String }, // Cached for easy display
    date: { type: String, required: true },
    time: String,
    type: {
        type: String,
        enum: FOLLOWUP_ACTIVITIES,
        default: "WhatsApp",
    },
    activityType: {
        type: String,
        enum: FOLLOWUP_ACTIVITIES,
    },
    note: { type: String },
    voiceNote: { type: String },
    remarks: { type: String, required: true },
    enquiryStatus: { type: String },
    followUpDate: { type: String }, // YYYY-MM-DD
    nextFollowUpDate: { type: String }, // YYYY-MM-DD
    dueAt: { type: Date }, // Computed from nextFollowUpDate + time (for real-time missed logic)
    activityTime: { type: Date, default: Date.now },
    staffName: { type: String },
    nextAction: {
        type: String,
        enum: ["Followup", "Sales", "Drop"],
        required: true,
    },
    status: { type: String, default: "Scheduled" }, // Scheduled, Missed, Completed
    // Only one follow-up per enquiry should be considered "current"/priority at a time.
    // When a new follow-up is created for the same enquiry, older ones are marked isCurrent=false
    // so they don't keep showing in Today/Missed/Dashboard lists.
    isCurrent: { type: Boolean, default: true },
    supersededAt: { type: Date },
    amount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
});

// Indexes for performance
followUpSchema.index({ userId: 1, date: -1, status: 1 });
followUpSchema.index({ createdBy: 1, date: -1, status: 1 });
followUpSchema.index({ assignedTo: 1, date: -1, status: 1 });
followUpSchema.index({ userId: 1, nextAction: 1 });
followUpSchema.index({ enqId: 1 });
followUpSchema.index({ enqNo: 1 });
followUpSchema.index({ userId: 1, nextFollowUpDate: 1, status: 1 });
followUpSchema.index({ assignedTo: 1, nextFollowUpDate: 1, status: 1 });
followUpSchema.index({ userId: 1, enqNo: 1, isCurrent: 1, date: -1 });

// Multi-tenant + list endpoints (preferred: companyId first)
followUpSchema.index({ companyId: 1, date: -1, status: 1, isCurrent: 1 });
followUpSchema.index({ companyId: 1, userId: 1, isCurrent: 1, status: 1, date: -1, dueAt: 1 });
followUpSchema.index({ companyId: 1, assignedTo: 1, isCurrent: 1, status: 1, date: -1, dueAt: 1 });
followUpSchema.index({
    companyId: 1,
    assignedTo: 1,
    date: 1,
    isCurrent: 1,
    enqId: 1,
});
followUpSchema.index({
    companyId: 1,
    enqId: 1,
    isCurrent: 1,
    activityTime: -1,
    createdAt: -1,
});

// Optimization for "Missed" status auto-update and dashboard counts
followUpSchema.index({ companyId: 1, isCurrent: 1, status: 1, dueAt: 1 });
followUpSchema.index({ userId: 1, isCurrent: 1, status: 1, dueAt: 1 });
followUpSchema.index({ assignedTo: 1, isCurrent: 1, status: 1, dueAt: 1 });
followUpSchema.index({ companyId: 1, isCurrent: 1, status: 1, date: -1 });

// Fast "followUpDate -> enquiryIds" lookup and "latest followup per enquiry" for /enquiries
followUpSchema.index({
    userId: 1,
    assignedTo: 1,
    date: 1,
    isCurrent: 1,
    enqId: 1,
});
followUpSchema.index({
    userId: 1,
    enqId: 1,
    isCurrent: 1,
    activityTime: -1,
    createdAt: -1,
});

followUpSchema.pre("validate", function syncLegacyFields() {
    if (!this.activityType) this.activityType = this.type || "WhatsApp";
    if (!this.type) this.type = this.activityType || "WhatsApp";
    if (!this.note && this.remarks) this.note = this.remarks;
    if (!this.remarks && this.note) this.remarks = this.note;
    if (!this.followUpDate && this.date) this.followUpDate = this.date;
    if (!this.nextFollowUpDate && this.date) this.nextFollowUpDate = this.date;
    if (!this.activityTime) this.activityTime = new Date();
    if (this.isCurrent === undefined) this.isCurrent = true;

    const dateStr = this.nextFollowUpDate || this.followUpDate || this.date;
    const timeStr = this.time;
    const parseDueAt = (iso, time) => {
        if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
        if (!time || typeof time !== "string") return null;
        const t = time.trim();
        const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(?:\s*([AaPp][Mm]))?$/);
        if (!m) return null;
        let hh = Number(m[1]);
        const mm = Number(m[2] ?? "0");
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59) return null;
        const mer = String(m[3] || "").toUpperCase();
        if (mer) {
            if (hh < 1 || hh > 12) return null;
            if (mer === "AM") {
                if (hh === 12) hh = 0;
            } else if (mer === "PM") {
                if (hh !== 12) hh += 12;
            }
        }
        hh = Math.min(23, Math.max(0, hh));
        const [yy, mo, dd] = iso.split("-").map((n) => Number(n));
        const dt = new Date(yy, (mo || 1) - 1, dd || 1, hh, mm, 0, 0);
        return Number.isNaN(dt.getTime()) ? null : dt;
    };

    const currentDueAt = this.dueAt instanceof Date ? this.dueAt : this.dueAt ? new Date(this.dueAt) : null;
    const hasValidDueAt = currentDueAt && !Number.isNaN(currentDueAt.getTime());

    // IMPORTANT:
    // `dueAt` should represent the true scheduled moment (absolute time). Routes may already set it
    // using the user's timezone offset. Avoid overwriting it here using server-local time (production
    // servers often run UTC, which would shift dueAt and break "Missed" logic).
    if (!hasValidDueAt) {
        const dueAt = parseDueAt(dateStr, timeStr);
        if (dueAt) this.dueAt = dueAt;
    }
});

// Ensure indexes + backfill companyId for multi-tenant queries.
const FollowUp = mongoose.models.FollowUp || mongoose.model("FollowUp", followUpSchema);

const backfillMissingCompanyIds = async () => {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const UserModel = mongoose.models.User;
        if (!UserModel) return;

        const start = Date.now();
        const maxMs = Number(process.env.BACKFILL_COMPANY_IDS_MAX_MS || 45000);
        while (Date.now() - start < maxMs) {
            const rows = await FollowUp.find({
                $or: [{ companyId: { $exists: false } }, { companyId: null }],
            })
                .select("_id userId")
                .limit(1000)
                .lean();
            if (!rows.length) break;

            const userIds = [
                ...new Set(
                    rows
                        .map((item) => String(item?.userId || ""))
                        .filter((value) => mongoose.Types.ObjectId.isValid(value)),
                ),
            ];
            if (!userIds.length) break;

            const users = await UserModel.find({ _id: { $in: userIds } })
                .select("_id company_id")
                .lean();
            const companyByUserId = new Map(
                users
                    .filter((item) => item?.company_id)
                    .map((item) => [String(item._id), item.company_id]),
            );

            const ops = rows
                .map((item) => {
                    const companyId = companyByUserId.get(String(item?.userId || ""));
                    if (!companyId) return null;
                    return {
                        updateOne: {
                            filter: { _id: item._id },
                            update: { $set: { companyId } },
                        },
                    };
                })
                .filter(Boolean);

            if (!ops.length) break;
            await FollowUp.bulkWrite(ops, { ordered: false });
        }
    } catch (_error) {
        // ignore startup migration issues
    }
};

const backfillMissingIsCurrent = async () => {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const start = Date.now();
        const maxMs = Number(process.env.BACKFILL_IS_CURRENT_MAX_MS || 20000);
        while (Date.now() - start < maxMs) {
            const rows = await FollowUp.find({
                $or: [{ isCurrent: { $exists: false } }, { isCurrent: null }],
            })
                .select("_id")
                .limit(500)
                .lean();
            if (!rows.length) break;
            const ids = rows.map((r) => r._id);
            await FollowUp.updateMany(
                { _id: { $in: ids } },
                { $set: { isCurrent: true } },
            );
        }
    } catch (_error) {
        // ignore startup migration issues
    }
};

const ensureFollowUpIndexes = async () => {
    try {
        if (mongoose.connection.readyState !== 1) return;
        await backfillMissingCompanyIds();
        await backfillMissingIsCurrent();
        await FollowUp.syncIndexes().catch(() => { });
    } catch (_error) {
        // ignore startup index migration issues
    }
};

if (mongoose.connection.readyState === 1) {
    ensureFollowUpIndexes();
} else {
    mongoose.connection.once("connected", ensureFollowUpIndexes);
}
module.exports = FollowUp;
