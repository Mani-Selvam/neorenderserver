const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const FollowUp = require("../models/FollowUp");

/**
 * ⚡ Enquiry Denormalization Service
 * 
 * Ensures Enquiry documents always have the latest followup info 
 * for lightning-fast list performance (avoiding aggregations).
 */
const syncEnquiryDenormalized = async (enquiryId) => {
    if (!enquiryId || !mongoose.Types.ObjectId.isValid(String(enquiryId))) return null;

    try {
        // Find the LATEST follow-up for this enquiry that is "Current"
        const latestFollowUp = await FollowUp.findOne({ 
            enqId: enquiryId,
            isCurrent: { $ne: false },
            activityType: { $ne: "System" },
            type: { $ne: "System" }
        })
        .sort({ activityTime: -1, createdAt: -1 })
        .lean();

        // Also search for the NEXT scheduled follow-up
        const nextFollowUp = await FollowUp.findOne({
            enqId: enquiryId,
            isCurrent: { $ne: false },
            status: "Scheduled",
            date: { $gte: new Date().toISOString().split('T')[0] }
        })
        .sort({ date: 1, dueAt: 1 })
        .lean();

        const update = {
            lastActivityAt: new Date()
        };

        if (latestFollowUp) {
            update.lastFollowUpDate = latestFollowUp.date || latestFollowUp.followUpDate;
            update.lastFollowUpStatus = latestFollowUp.status;
            update.lastActivityAt = latestFollowUp.activityTime || latestFollowUp.createdAt || new Date();
            
            // Logic to derive status if it's not explicitly set in Enquiry
            if (latestFollowUp.nextAction === "Sales") update.status = "Converted";
            else if (latestFollowUp.nextAction === "Drop") update.status = "Not Interested";
            else if (latestFollowUp.status === "Completed" || latestFollowUp.status === "Missed") {
                // If it's a regular followup, it's at least "Contacted"
                update.status = "Contacted";
            }
        }

        if (nextFollowUp) {
            update.nextFollowUpDate = nextFollowUp.nextFollowUpDate || nextFollowUp.date;
        } else {
            update.nextFollowUpDate = null;
        }

        const result = await Enquiry.findByIdAndUpdate(enquiryId, { $set: update }, { returnDocument: "after" });
        return result;
    } catch (error) {
        console.error(`[Denormalizer] Error syncing enquiry ${enquiryId}:`, error.message);
        return null;
    }
};

module.exports = {
    syncEnquiryDenormalized
};

