const User = require("../models/User");
const Company = require("../models/Company");
const FollowUp = require("../models/FollowUp");
const Enquiry = require("../models/Enquiry");
const { sendNeoTemplateMessage } = require("../utils/otpService");

const toLocalIsoDate = (d = new Date()) => {
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

const getRangeBounds = ({ range = "day", date = new Date() } = {}) => {
    const dt = date instanceof Date ? date : new Date(date);
    const normalized = String(range || "day").trim().toLowerCase();
    if (normalized === "month") {
        const start = new Date(dt.getFullYear(), dt.getMonth(), 1);
        const end = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
        return { rangeFrom: toLocalIsoDate(start), rangeTo: toLocalIsoDate(end) };
    }
    const iso = toLocalIsoDate(dt);
    return { rangeFrom: iso, rangeTo: iso };
};

/**
 * Calculates and sends daily morning reports to all active company admins.
 */
const sendDailyMorningReports = async () => {
    try {
        console.log("[DailyReport] Starting morning report cycle...");

        // 1. Find all active companies
        const companies = await Company.find({ status: "Active" }).lean();

        for (const company of companies) {
            try {
                // 2. Get Admins for this company
                const admins = await User.find({
                    company_id: company._id,
                    role: "Admin",
                    status: "Active"
                }).select("name mobile");

                if (admins.length === 0) continue;

                // 3. Calculate Metrics (Once per company)
                const now = new Date();
                const istOffset = 5.5 * 60 * 60 * 1000;
                const istDate = new Date(now.getTime() + istOffset);
                const todayIso = istDate.toISOString().split("T")[0]; // YYYY-MM-DD
                const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

                // A. Today's Follow-ups (Matching Home Screen "Due Today")
                const todayCount = await FollowUp.countDocuments({
                    companyId: company._id,
                    date: todayIso,
                    isCurrent: { $ne: false },
                    status: { $nin: ["Missed", "Completed", "completed", "Converted", "converted", "Dropped", "dropped", "Rejected", "rejected"] }
                });

                // B. Missed Leads (Matching Home Screen "Missed")
                const missedCount = await FollowUp.countDocuments({
                    companyId: company._id,
                    isCurrent: { $ne: false },
                    status: "Missed"
                });

                // C. Monthly Conversions (Matching Home Screen Month Logic)
                const { rangeFrom: monthFrom, rangeTo: monthTo } = getRangeBounds({ range: "month", date: now });

                const convertedMonthCount = await Enquiry.countDocuments({
                    companyId: company._id,
                    status: { $in: ["Converted", "converted"] },
                    date: { $gte: monthFrom, $lte: monthTo }
                });

                const totalMonthCount = await Enquiry.countDocuments({
                    companyId: company._id,
                    date: { $gte: monthFrom, $lte: monthTo }
                });

                // D. Monthly Revenue (Sum of 'cost' field based on Enquiry Date)
                const revenueResult = await Enquiry.aggregate([
                    {
                        $match: {
                            companyId: company._id,
                            status: { $in: ["Converted", "converted"] },
                            date: { $gte: monthFrom, $lte: monthTo }
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            total: {
                                $sum: {
                                    $convert: {
                                        input: "$cost",
                                        to: "double",
                                        onError: 0,
                                        onNull: 0
                                    }
                                }
                            }
                        }
                    }
                ]);
                const revenue = revenueResult[0]?.total || 0;
                const conversionRate = totalMonthCount > 0
                    ? ((convertedMonthCount / totalMonthCount) * 100).toFixed(1)
                    : "0";

                // 4. Send to each admin
                const templateName = process.env.NEO_DAILY_REPORT_TEMPLATE_NAME || "daily_summary_report";

                console.log(`[DailyReport] Attempting to send report for company: ${company.name} to ${admins.length} admins`);

                for (const admin of admins) {
                    if (!admin.mobile) continue;

                    console.log(`[DailyReport] Sending report to ${admin.mobile} (${admin.name})`);

                    await sendNeoTemplateMessage({
                        phoneNumber: admin.mobile,
                        templateName,
                        parameters: [
                            String(admin.name || "Admin").trim(),
                            String(todayCount),
                            String(missedCount),
                            String(revenue),
                            String(conversionRate),
                        ],
                    }).catch(err => console.error(`[DailyReport] Error sending to ${admin.mobile}:`, err.message));
                }

                console.log(`[DailyReport] ✓ Sent report for company: ${company.name}`);
            } catch (companyErr) {
                console.error(`[DailyReport] Error processing company ${company._id}:`, companyErr.message);
            }
        }

        console.log("[DailyReport] Morning report cycle complete.");
    } catch (err) {
        console.error("[DailyReport] Fatal error:", err.message);
    }
};

module.exports = {
    sendDailyMorningReports,
};
