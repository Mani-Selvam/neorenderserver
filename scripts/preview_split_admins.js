const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });
const mongoose = require("mongoose");

const MONGO_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DB_URI ||
    "mongodb://127.0.0.1:27017/crm_db";

(async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to", MONGO_URI);

        const User = require("../models/User");
        const Company = require("../models/Company");
        const Enquiry = require("../models/Enquiry");
        const FollowUp = require("../models/FollowUp");
        const ChatMessage = require("../models/ChatMessage");

        // Find companies that have more than one Admin
        const agg = await User.aggregate([
            { $match: { role: "Admin", company_id: { $ne: null } } },
            {
                $group: {
                    _id: "$company_id",
                    admins: {
                        $push: { _id: "$_id", name: "$name", email: "$email" },
                    },
                    count: { $sum: 1 },
                },
            },
            { $match: { count: { $gt: 1 } } },
        ]).allowDiskUse(true);

        if (!agg || agg.length === 0) {
            console.log(
                "No companies found with multiple Admins. Preview complete.",
            );
            await mongoose.disconnect();
            return;
        }

        console.log(`Found ${agg.length} companies with multiple Admins.`);

        for (const item of agg) {
            const companyId = item._id;
            const company = await Company.findById(companyId).lean();
            console.log("\n---");
            console.log(
                "Company:",
                companyId.toString(),
                company ? company.name : "(missing)",
                company ? company.code : "(no code)",
            );
            console.log(`Admins (${item.count}):`);
            for (const a of item.admins) {
                const adminId = a._id;
                const staffCount = await User.countDocuments({
                    parentUserId: adminId,
                });
                const enquiries = await Enquiry.countDocuments({
                    userId: adminId,
                });
                const followups = await FollowUp.countDocuments({
                    userId: adminId,
                });
                const messages = await ChatMessage.countDocuments({
                    userId: adminId,
                });

                console.log(
                    ` - ${a.name} <${a.email}> (id: ${adminId.toString()})`,
                );
                console.log(
                    `    staff (parentUserId): ${staffCount}, enquiries: ${enquiries}, followups: ${followups}, messages: ${messages}`,
                );
            }

            const companyStaff = await User.countDocuments({
                company_id: companyId,
                role: "Staff",
            });
            console.log(`Company-level Staff count: ${companyStaff}`);

            console.log(
                "Suggested action: For each Admin above create a new Company and reassign that Admin and their direct staff and records (enquiries, followups, messages) to that new Company.\nThis script is preview-only and does NOT perform changes.",
            );
        }

        await mongoose.disconnect();
        console.log("\nPreview complete.");
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
})();
