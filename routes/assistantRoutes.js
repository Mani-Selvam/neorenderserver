const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const FormData = require("form-data");

const Enquiry = require("../models/Enquiry");
const FollowUp = require("../models/FollowUp");
const User = require("../models/User");
const CommunicationTask = require("../models/CommunicationTask");
const Company = require("../models/Company");
const LeadSource = require("../models/LeadSource");
const Target = require("../models/Target");
const MessageTemplate = require("../models/MessageTemplate");
const CommunicationMessage = require("../models/CommunicationMessage");
const VoiceConversation = require("../models/VoiceConversation");
const { verifyToken } = require("../middleware/auth");
const { requireActivePlan, requireFeature } = require("../middleware/planGuard");

// Configure Multer for temp audio uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, "../uploads");
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, "voice-" + uniqueSuffix + path.extname(file.originalname || ".m4a"));
    }
});
const upload = multer({ storage: storage });

/**
 * Helper to get the current date in YYYY-MM-DD client-timezone-friendly format
 */
const toLocalIsoDate = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};

/**
 * GET /api/assistant/voice-sessions
 * Retrieves all voice conversation sessions for the user (for the sidebar).
 */
router.get("/voice-sessions", verifyToken, async (req, res) => {
    try {
        const userId = req.userId;
        const companyId = req.user?.company_id;

        const query = { userId };
        if (companyId) {
            query.companyId = companyId;
        }

        const sessions = await VoiceConversation.find(query)
            .select("_id title updatedAt")
            .sort({ updatedAt: -1 });

        return res.json({ success: true, sessions });
    } catch (error) {
        console.error("[Voice Assistant Sessions Error]:", error);
        return res.status(500).json({ success: false, error: "Failed to fetch sessions" });
    }
});

/**
 * GET /api/assistant/voice-history
 * Retrieves the persistent voice conversation history for a specific chat.
 */
router.get("/voice-history", verifyToken, async (req, res) => {
    try {
        const userId = req.userId;
        const companyId = req.user?.company_id;
        const chatId = req.query.chatId;

        const query = { userId };
        if (companyId) {
            query.companyId = companyId;
        }
        if (chatId) {
            query._id = new mongoose.Types.ObjectId(chatId);
        }

        let conversation = chatId
            ? await VoiceConversation.findOne(query)
            : await VoiceConversation.findOne(query).sort({ updatedAt: -1 });

        if (!conversation) {
            conversation = new VoiceConversation({
                userId,
                companyId: companyId || null,
                title: "New Chat",
                messages: []
            });
            await conversation.save();
        }

        // Return max last 50 messages to frontend to avoid huge payloads
        const messages = conversation.messages.slice(-50);

        return res.json({ success: true, history: messages });
    } catch (error) {
        console.error("[Voice Assistant History Error]:", error);
        return res.status(500).json({ success: false, error: "Failed to fetch history" });
    }
});

/**
 * DELETE /api/assistant/voice-history
 * Clears a specific voice conversation history for the logged-in user.
 */
router.delete("/voice-history", verifyToken, async (req, res) => {
    try {
        const userId = req.userId;
        const companyId = req.user?.company_id;
        const chatId = req.query.chatId;

        const query = { userId };
        if (companyId) {
            query.companyId = companyId;
        }
        if (chatId) {
            query._id = new mongoose.Types.ObjectId(chatId);
        }

        await VoiceConversation.deleteOne(query);

        return res.json({ success: true });
    } catch (error) {
        console.error("[Voice Assistant Delete History Error]:", error);
        return res.status(500).json({ success: false, error: "Failed to delete history" });
    }
});

/**
 * PUT /api/assistant/voice-history
 * Renames a specific voice conversation history.
 */
router.put("/voice-history", verifyToken, async (req, res) => {
    try {
        const userId = req.userId;
        const companyId = req.user?.company_id;
        const { chatId, title } = req.body;

        if (!chatId || !title) {
            return res.status(400).json({ success: false, error: "chatId and title are required" });
        }

        const query = { userId, _id: new mongoose.Types.ObjectId(chatId) };
        if (companyId) {
            query.companyId = companyId;
        }

        await VoiceConversation.updateOne(query, { $set: { title } });

        return res.json({ success: true });
    } catch (error) {
        console.error("[Voice Assistant Rename History Error]:", error);
        return res.status(500).json({ success: false, error: "Failed to rename history" });
    }
});

/**
 * GET /api/assistant/usage
 * Fetch yearly assistant usage limit and count for the UI dashboard
 */
router.get("/usage", verifyToken, requireActivePlan, async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(400).json({ success: false, error: "Not part of a company" });

        const Company = mongoose.model("Company");
        const companyDoc = await Company.findById(companyId).select("assistantUsage");

        let usage = companyDoc?.assistantUsage || { yearlyUsed: 0, extraPurchased: 0 };

        const baseLimit = req.effectivePlan?.aiVoiceLimitYearly || 3000;
        const totalLimit = baseLimit + (usage.extraPurchased || 0);
        const remaining = Math.max(0, totalLimit - (usage.yearlyUsed || 0));

        res.json({
            success: true,
            usage: {
                limit: totalLimit,
                used: usage.yearlyUsed || 0,
                remaining,
                extraPrice: req.effectivePlan?.aiVoiceExtraPrice || 500,
                extraRequests: req.effectivePlan?.aiVoiceExtraRequests || 1000
            }
        });
    } catch (error) {
        console.error("[Voice Assistant Usage Error]:", error);
        res.status(500).json({ success: false, error: "Failed to fetch usage data" });
    }
});

/**
 * POST /api/assistant/voice-command
 * Main endpoint to analyze voice command using AI (Gemini/OpenAI) or local fallback
 * Accepts either JSON body `{ text }` OR multi-part form data with `audio` file.
 */
router.post("/voice-command", verifyToken, requireActivePlan, requireFeature("voice_assistant"), upload.single("audio"), async (req, res) => {
    let tempFilePath = null;
    try {
        const role = String(req.user?.role || "").toLowerCase();
        const userId = req.userId;
        const companyId = req.user?.company_id;
        const tzOffsetMinutes = req.body.tzOffsetMinutes || new Date().getTimezoneOffset();

        // -------------------------------------------------------------
        // Company Yearly Usage Limit Tracking
        // -------------------------------------------------------------
        if (companyId) {
            const Company = mongoose.model("Company");
            const companyDoc = await Company.findById(companyId);
            if (companyDoc) {
                let usage = companyDoc.assistantUsage || { yearlyUsed: 0, extraPurchased: 0 };

                const baseLimit = req.effectivePlan?.aiVoiceLimitYearly || 3000;
                const totalLimit = baseLimit + (usage.extraPurchased || 0);

                // Check Quota
                if ((usage.yearlyUsed || 0) >= totalLimit) {
                    const errorMsg = `You have reached your company's yearly AI limit of ${totalLimit} queries. Please ask an admin to purchase a top-up.`;
                    console.log(`[Voice Assistant] Rate limit exceeded for Company ${companyId}: ${usage.yearlyUsed}/${totalLimit}`);

                    // Cleanup any uploaded temp audio
                    if (req.file && req.file.path) {
                        try { require("fs").unlinkSync(req.file.path); } catch (e) { }
                    }

                    return res.json({
                        success: true,
                        spokenText: errorMsg,
                        reply: errorMsg,
                        replyAudioData: null,
                        enquiries: [],
                        intent: "ERROR_LIMIT_EXCEEDED"
                    });
                }

                // Increment Usage
                usage.yearlyUsed = (usage.yearlyUsed || 0) + 1;
                companyDoc.assistantUsage = usage;
                await companyDoc.save();
            }
        }
        // -------------------------------------------------------------

        let contextObj = null;
        if (req.body.context) {
            try {
                contextObj = typeof req.body.context === "string" ? JSON.parse(req.body.context) : req.body.context;
            } catch (e) {
                console.warn("[Voice Assistant] Failed to parse context:", e);
            }
        }

        let voiceDoc;
        const chatId = req.body.chatId;

        if (chatId) {
            voiceDoc = await VoiceConversation.findOne({ _id: new mongoose.Types.ObjectId(chatId), userId });
        }

        if (!voiceDoc) {
            voiceDoc = new VoiceConversation({
                userId,
                companyId: companyId || null,
                title: "New Chat",
                messages: []
            });
        }

        // Pass last 15 messages to AI to save tokens but retain context
        let historyObj = voiceDoc.messages.slice(-15);

        // Check if an audio file was uploaded
        const audioFile = req.file;
        if (audioFile) {
            tempFilePath = audioFile.path;
            console.log(`[Voice Assistant] Audio file received: ${audioFile.filename} (${audioFile.size} bytes)`);
        }

        // Gather all users belonging to this company for scoping
        let usersInCompany = [];
        let userIdsInCompany = [];
        if (companyId) {
            usersInCompany = await User.find({ company_id: companyId }).select("_id name email role status").lean();
            userIdsInCompany = (usersInCompany || []).map((u) => u._id);
        } else {
            // Standalone user fallback
            const selfUser = await User.findById(userId).select("_id name email role status").lean();
            if (selfUser) {
                usersInCompany = [selfUser];
                userIdsInCompany = [selfUser._id];
            }
        }

        // 1. Build context query (align with your database isolation model)
        const query = {};
        if (role === "staff") {
            query.userId = new mongoose.Types.ObjectId(req.user?.parentUserId || userId);
            query.assignedTo = new mongoose.Types.ObjectId(userId);
        } else if (companyId) {
            const companyObjId = mongoose.Types.ObjectId.isValid(String(companyId))
                ? new mongoose.Types.ObjectId(companyId)
                : null;
            if (companyObjId) {
                query.$or = [{ companyId: companyObjId }];
                const ids = userIdsInCompany;
                if (ids.length > 0) {
                    query.$or.push({ userId: { $in: ids } });
                }
            } else {
                query.userId = new mongoose.Types.ObjectId(userId);
            }
        } else {
            query.userId = new mongoose.Types.ObjectId(userId);
        }

        const todayDateStr = toLocalIsoDate(new Date());

        let taskQuery = {};
        if (role === "staff") {
            if (companyId) {
                taskQuery.companyId = new mongoose.Types.ObjectId(companyId);
            }
            taskQuery.assignedTo = new mongoose.Types.ObjectId(userId);
        } else if (companyId) {
            const companyObjId = mongoose.Types.ObjectId.isValid(String(companyId))
                ? new mongoose.Types.ObjectId(companyId)
                : null;
            if (companyObjId) {
                taskQuery.companyId = companyObjId;
            }
        } else {
            taskQuery.createdBy = new mongoose.Types.ObjectId(userId);
        }
        taskQuery.status = { $in: ["Pending", "In Progress"] };

        // 2. Fetch live metrics from Database in parallel
        const [
            totalEnquiries,
            convertedCount,
            activeCount,
            todayFollowups,
            overallMissedFollowups,
            todayMissedFollowups,
            contactedCount,
            droppedCount,
            activeTasksCount,
            missedFollowupsList,
            todayFollowupsList,
            upcomingFollowupsList,
            companyDetails,
            leadSources,
            targets,
            templates,
            unreadTeamMessagesCount,
            recentTeamMessages,
            todayEnquiriesCount,
            todayEnquiriesList
        ] = await Promise.all([
            Enquiry.countDocuments(query),
            Enquiry.countDocuments({ ...query, status: "Converted" }),
            Enquiry.countDocuments({ ...query, status: { $in: ["New", "Contacted", "In Progress", "Interested"] } }),
            FollowUp.countDocuments({
                ...query,
                date: todayDateStr,
                isCurrent: { $ne: false },
                status: { $nin: ["Missed", "Completed", "Drop", "Dropped", "Converted"] }
            }),
            FollowUp.countDocuments({
                ...query,
                isCurrent: { $ne: false },
                status: "Missed"
            }),
            FollowUp.countDocuments({
                ...query,
                date: todayDateStr,
                isCurrent: { $ne: false },
                status: "Missed"
            }),
            Enquiry.countDocuments({ ...query, status: "Contacted" }),
            Enquiry.countDocuments({ ...query, status: "Dropped" }),
            CommunicationTask.countDocuments(taskQuery),
            FollowUp.find({
                ...query,
                isCurrent: { $ne: false },
                status: "Missed"
            }).populate("enqId", "address mobile").select("name").limit(5).lean(),
            FollowUp.find({
                ...query,
                date: todayDateStr,
                isCurrent: { $ne: false },
                status: { $nin: ["Missed", "Completed", "Drop", "Dropped", "Converted"] }
            }).populate("enqId", "address mobile").select("name").limit(5).lean(),
            FollowUp.find({
                ...query,
                date: { $gt: todayDateStr },
                isCurrent: { $ne: false },
                status: { $nin: ["Missed", "Completed", "Drop", "Dropped", "Converted"] }
            }).sort({ date: 1 }).populate("enqId", "address mobile").select("name date time").limit(10).lean(),
            companyId ? Company.findById(companyId).select("name plan status").lean() : Promise.resolve(null),
            LeadSource.find({ createdBy: { $in: userIdsInCompany } }).select("name").lean(),
            companyId ? Target.find({ company_id: companyId }).sort({ year: -1, month: -1 }).limit(3).lean() : Promise.resolve([]),
            MessageTemplate.find({ userId: { $in: userIdsInCompany } }).select("name keyword category status").lean(),
            CommunicationMessage.countDocuments({ receiverId: userId, readBy: { $ne: userId } }),
            companyId ? CommunicationMessage.find({ companyId: companyId }).sort({ createdAt: -1 }).limit(5).populate("senderId", "name").populate("receiverId", "name").lean() : Promise.resolve([]),
            Enquiry.countDocuments({ ...query, createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
            Enquiry.find({ ...query, createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }).select("name mobile status").limit(10).lean()
        ]);

        const missedNames = (missedFollowupsList || []).map(f => f.name).filter(Boolean);
        const todayNames = (todayFollowupsList || []).map(f => f.name).filter(Boolean);
        const missedDetails = (missedFollowupsList || []).map(f => ({ name: f.name, mobile: f.mobile || f.enqId?.mobile || "Not provided", address: f.enqId?.address || "Not provided" }));
        const todayDetails = (todayFollowupsList || []).map(f => ({ name: f.name, mobile: f.mobile || f.enqId?.mobile || "Not provided", address: f.enqId?.address || "Not provided" }));
        const leadSourceNames = (leadSources || []).map(s => s.name);
        const upcomingFollowupsSummary = (upcomingFollowupsList || []).map(f => ({ name: f.name, date: f.date, time: f.time, mobile: f.mobile || f.enqId?.mobile || "Not provided", address: f.enqId?.address || "Not provided" }));

        const targetsSummary = (targets || []).map(t => ({
            year: t.year,
            month: t.month,
            leadsTarget: t.leadsTarget,
            confirmedProjectsTarget: t.confirmedProjectsTarget,
            marketingBudget: t.marketingBudget,
            incomeTarget: t.incomeTarget
        }));
        const templatesSummary = (templates || []).map(t => ({
            name: t.name,
            keyword: t.keyword,
            category: t.category,
            status: t.status
        }));
        const recentMessagesSummary = (recentTeamMessages || []).map(m => ({
            sender: m.senderId?.name || "System",
            receiver: m.receiverId?.name || "System",
            message: m.message,
            time: m.createdAt
        }));
        const staffList = (usersInCompany || []).map(u => ({
            name: u.name,
            role: u.role,
            status: u.status
        }));

        const dbStatsSummary = {
            todayDate: todayDateStr,
            totalEnquiries,
            convertedEnquiries: convertedCount,
            activeLeads: activeCount,
            contactedLeadsCount: contactedCount,
            salesDropLeadsCount: droppedCount,
            todayScheduledFollowups: todayFollowups,
            todayMissedFollowups: todayMissedFollowups,
            overallMissedFollowups: overallMissedFollowups,
            staffCount: staffList.length,
            staffList,
            activeTasks: activeTasksCount,
            missedNames,
            todayNames,
            missedDetails,
            todayDetails,
            upcomingFollowupsList: upcomingFollowupsSummary,
            companyDetails: companyDetails ? {
                name: companyDetails.name,
                plan: companyDetails.plan?.type || "Starter",
                staffLimit: companyDetails.plan?.staffLimit || 5,
                status: companyDetails.status || "Active"
            } : null,
            leadSources: leadSourceNames,
            targets: targetsSummary,
            templates: templatesSummary,
            unreadTeamMessagesCount,
            recentTeamMessages: recentMessagesSummary,
            todayEnquiriesCount,
            todayEnquiriesList: (todayEnquiriesList || []).map(e => ({ name: e.name, mobile: e.mobile, status: e.status }))
        };

        console.log("[Voice Assistant] Live database stats fetched:", dbStatsSummary);

        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        const openaiKey = process.env.OPENAI_API_KEY;

        let responsePayload = null;

        // --- SCENARIO A: Audio Recording Processing ---
        if (audioFile) {
            try {
                if (geminiKey) {
                    console.log("[Voice Assistant] Routing audio input directly to Multimodal Gemini API...");
                    responsePayload = await callGeminiMultimodalAudio(tempFilePath, audioFile.mimetype, dbStatsSummary, geminiKey, contextObj, historyObj);
                } else if (openaiKey) {
                    console.log("[Voice Assistant] Transcribing audio with OpenAI Whisper first...");
                    const recognizedText = await transcribeAudioWithWhisper(tempFilePath, openaiKey);
                    console.log(`[Voice Assistant] Whisper transcribed text: "${recognizedText}"`);

                    responsePayload = await callOpenAI(recognizedText, dbStatsSummary, openaiKey);
                    responsePayload.recognizedText = recognizedText;
                } else {
                    throw new Error("No API keys found for voice transcription.");
                }
            } catch (err) {
                console.warn("[Voice Assistant Warning] Audio AI API failed. Self-healing to premium stats overview:", err.message || err);
                const isTamil = (req.body.language === "ta" || req.headers["accept-language"]?.includes("ta"));
                responsePayload = {
                    spokenText: isTamil
                        ? `கூகிள் சேவை தற்போது இணைக்கப்படவில்லை. இருப்பினும், உங்களிடம் மொத்தம் ${dbStatsSummary.totalEnquiries} கோரிக்கைகள், ${dbStatsSummary.overallMissedFollowups} தவறவிட்ட தொடர்புகள், ${dbStatsSummary.staffCount} பணியாளர்கள் மற்றும் ${dbStatsSummary.activeTasks} வேலைகள் நிலுவையில் உள்ளன.`
                        : `I am having trouble connecting to Google AI. But overall, you have ${dbStatsSummary.totalEnquiries} enquiries, ${dbStatsSummary.overallMissedFollowups} missed follow-ups, ${dbStatsSummary.staffCount} staff members, and ${dbStatsSummary.activeTasks} pending tasks.`,
                    intent: "GET_GENERAL_STATS",
                    language: isTamil ? "ta" : "en",
                    recognizedText: "Voice Command (Offline Fallback)"
                };
            }
        }
        // --- SCENARIO B: Preset Chip / Manual Typing Text Processing ---
        else {
            const transcript = String(req.body.text || "").trim();
            if (!transcript) {
                return res.status(400).json({ error: "No voice text transcript or audio file provided." });
            }

            try {
                if (geminiKey) {
                    console.log("[Voice Assistant] Routing text to Gemini API...");
                    responsePayload = await callGeminiAI(transcript, dbStatsSummary, geminiKey, contextObj, historyObj);
                } else if (openaiKey) {
                    console.log("[Voice Assistant] Routing text to OpenAI API...");
                    responsePayload = await callOpenAI(transcript, dbStatsSummary, openaiKey);
                } else {
                    console.log("[Voice Assistant] No API key found. Falling back to local smart-regex parser...");
                    responsePayload = handleLocalFallback(transcript, dbStatsSummary, historyObj, contextObj);
                }
            } catch (err) {
                console.warn("[Voice Assistant Warning] Text AI API failed. Self-healing to local fallback:", err.message || err);
                responsePayload = handleLocalFallback(transcript, dbStatsSummary, historyObj, contextObj);
            }
            responsePayload.recognizedText = transcript;
        }

        // Clean up temp audio file asynchronously to avoid locking
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlink(tempFilePath, () => { });
        }

        // --- CRITICAL FIX: Enforce Context Preservation ---
        // If the user is in the middle of ADD_ENQUIRY, do not let the AI reset the conversation accidentally!
        if (contextObj && contextObj.mode === "ADD_ENQUIRY") {
            if (responsePayload.intent !== "SUBMIT_ENQUIRY" && responsePayload.intent !== "CANCEL_ENQUIRY") {
                if (!responsePayload.context || !responsePayload.context.draft) {
                    console.log("[Voice Assistant] AI hallucinated or lost the draft. Restoring context!");
                    responsePayload.context = contextObj;
                    if (responsePayload.intent === "UNKNOWN" || responsePayload.intent === "GET_GENERAL_STATS") {
                        responsePayload.intent = "GATHER_ENQUIRY_FIELD";
                        if (!responsePayload.spokenText || responsePayload.spokenText.length < 5) {
                            responsePayload.spokenText = "I didn't quite catch that. Can you repeat?";
                        }
                    }
                }
            }
        }

        // --- DATA ENGINE: Intercept Intents and Generate Widgets ---
        let widgetObj = null;
        try {
            if (responsePayload.intent === "QUERY_ENQUIRIES") {
                const params = responsePayload.queryParams || {};
                let eqQuery = { ...query };
                if (params.dateFilter && params.dateFilter.toLowerCase() === "today") {
                    eqQuery.createdAt = { $gte: new Date(new Date().setHours(0, 0, 0, 0)) };
                } else if (params.dateFilter && params.dateFilter.toLowerCase() === "yesterday") {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    yesterday.setHours(0, 0, 0, 0);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    eqQuery.createdAt = { $gte: yesterday, $lt: today };
                }
                if (params.nameQuery) eqQuery.name = { $regex: params.nameQuery, $options: "i" };
                const list = await Enquiry.find(eqQuery).select("name mobile status createdAt").limit(20).lean();
                widgetObj = { type: "ENQUIRY_LIST", data: list };
                if (!responsePayload.spokenText || responsePayload.spokenText.length < 5) {
                    responsePayload.spokenText = `I found ${list.length} matching enquiries.`;
                }
            }
            else if (responsePayload.intent === "SHOW_PIE_CHART") {
                const target = responsePayload.chartTarget || "staff";
                let chartData = [];
                const colors = ["#0A84FF", "#30D158", "#FF9F0A", "#FF375F", "#BF5AF2", "#32ADE6"];

                if (target === "leads") {
                    const leadStats = await Enquiry.aggregate([
                        { $match: query },
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ]);
                    chartData = leadStats.map((s, i) => ({
                        name: s._id || "Unknown",
                        count: s.count,
                        color: colors[i % colors.length],
                        legendFontColor: "#1C1C1E",
                        legendFontSize: 13
                    }));
                    if (!responsePayload.spokenText || responsePayload.spokenText.length < 5) {
                        responsePayload.spokenText = "Here is the leads pie chart by status.";
                    }
                } else {
                    const staffStats = await Enquiry.aggregate([
                        { $match: query },
                        { $group: { _id: "$assignedTo", count: { $sum: 1 } } }
                    ]);
                    const populatedStats = await User.populate(staffStats, { path: "_id", select: "name" });
                    chartData = populatedStats.map((s, i) => ({
                        name: (s._id && s._id.name) ? s._id.name : "Unassigned",
                        count: s.count,
                        color: colors[i % colors.length],
                        legendFontColor: "#1C1C1E",
                        legendFontSize: 13
                    }));
                    if (!responsePayload.spokenText || responsePayload.spokenText.length < 5) {
                        responsePayload.spokenText = "Here is the staff performance chart.";
                    }
                }
                widgetObj = { type: "PIE_CHART", data: chartData };
            }
            else if (responsePayload.intent === "EXPORT_DATA") {
                const fs = require("fs");
                const path = require("path");

                const target = responsePayload.exportTarget || "enquiries";
                const format = responsePayload.exportFormat || "excel";
                let rawData = [];

                if (target === "staff") {
                    const staffStats = await Enquiry.aggregate([
                        { $match: query },
                        { $group: { _id: "$assignedTo", count: { $sum: 1 } } }
                    ]);
                    const populatedStats = await User.populate(staffStats, { path: "_id", select: "name" });
                    rawData = populatedStats.map(s => ({
                        "Staff Name": (s._id && s._id.name) ? s._id.name : "Unassigned",
                        "Enquiries Handled": s.count
                    }));
                } else {
                    const enquiries = await Enquiry.find(query).select("name mobile email status source product cost address remarks createdAt").lean();
                    rawData = enquiries.map(e => ({
                        "Name": e.name || "",
                        "Mobile": e.mobile || "",
                        "Email": e.email || "",
                        "Status": e.status || "",
                        "Source": e.source || "",
                        "Product": e.product || "",
                        "Cost": e.cost || "",
                        "Address": e.address || "",
                        "Created": e.createdAt ? new Date(e.createdAt).toLocaleDateString() : ""
                    }));
                }

                if (format === "pdf") {
                    let html = `<html><head><style>body{font-family:sans-serif;} table{width:100%;border-collapse:collapse;margin-top:20px;} th,td{border:1px solid #ddd;padding:8px;text-align:left;} th{background-color:#0A84FF;color:white;}</style></head><body><h2>${target === "staff" ? "Staff Performance" : "Enquiries"} Report</h2><table><tr>`;
                    const keys = rawData.length > 0 ? Object.keys(rawData[0]) : [];
                    keys.forEach(k => html += `<th>${k}</th>`);
                    html += `</tr>`;
                    rawData.forEach(row => {
                        html += `<tr>`;
                        keys.forEach(k => html += `<td>${row[k]}</td>`);
                        html += `</tr>`;
                    });
                    html += `</table></body></html>`;

                    widgetObj = { type: "DOWNLOAD_LINK", html, format: "pdf", label: "Download PDF" };
                    if (!responsePayload.spokenText || responsePayload.spokenText.length < 5) {
                        responsePayload.spokenText = `I have generated the ${target} report in PDF format.`;
                    }
                } else {
                    const XLSX = require("xlsx");
                    const worksheet = XLSX.utils.json_to_sheet(rawData);
                    const workbook = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(workbook, worksheet, "Report");

                    const uploadsDir = path.join(__dirname, "../uploads");
                    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
                    const fileName = `export_${Date.now()}.xlsx`;
                    XLSX.writeFile(workbook, path.join(uploadsDir, fileName));

                    widgetObj = { type: "DOWNLOAD_LINK", url: `${req.protocol}://${req.get('host')}/uploads/${fileName}`, format: "excel", label: "Download Excel" };
                    if (!responsePayload.spokenText || responsePayload.spokenText.length < 5) {
                        responsePayload.spokenText = `I have generated the ${target} report in Excel format.`;
                    }
                }
            }
        } catch (e) {
            console.error("[Data Engine Error]:", e);
        }

        // Save the conversation to persistent history
        if (responsePayload.recognizedText) {
            // Auto-generate title for new chats based on first user message
            if (voiceDoc.messages.length === 0 && responsePayload.recognizedText) {
                let shortTitle = responsePayload.recognizedText.replace(/^"|"$/g, "").substring(0, 30);
                if (shortTitle.length === 30) shortTitle += "...";
                voiceDoc.title = shortTitle || "New Chat";
            }

            voiceDoc.messages.push({
                role: "user",
                text: responsePayload.recognizedText,
                timestamp: new Date()
            });
        }
        if (responsePayload.spokenText) {
            const aiMsg = {
                role: "assistant",
                text: responsePayload.spokenText,
                timestamp: new Date()
            };
            if (widgetObj) aiMsg.widget = widgetObj;
            voiceDoc.messages.push(aiMsg);
        }
        await voiceDoc.save();

        return res.json({
            success: true,
            chatId: voiceDoc._id,
            spokenText: responsePayload.spokenText,
            intent: responsePayload.intent,
            language: responsePayload.language,
            context: responsePayload.context || null,
            widget: widgetObj || null,
            statsUsed: {
                ...dbStatsSummary,
                recognizedText: responsePayload.recognizedText || "Preset/Type"
            }
        });

    } catch (error) {
        console.error("[Voice Assistant Backend Error]:", error);

        // Clean up temp audio file on error
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlink(tempFilePath, () => { });
        }

        return res.status(500).json({
            success: false,
            error: error.message || "Failed to process voice assistant command.",
        });
    }
});

async function callGeminiMultimodalAudio(filePath, mimetype, stats, apiKey, context, history) {
    const base64Audio = fs.readFileSync(filePath).toString("base64");

    const prompt = `
You are a highly efficient voice assistant for the NeoGroww CRM database.
Below are the actual real-time CRM statistics and configuration for the logged-in user:
- Today's Date: ${stats.todayDate}
- Total Enquiries: ${stats.totalEnquiries}
- Today's Enquiries Added: ${stats.todayEnquiriesCount}
- Today's Enquiries List (Up to 10): ${stats.todayEnquiriesList ? JSON.stringify(stats.todayEnquiriesList) : "None"}
- Active Leads (In Progress): ${stats.activeLeads}
- Converted Leads (Success): ${stats.convertedEnquiries}
- Contacted Leads: ${stats.contactedLeadsCount}
- Sales Drop Leads: ${stats.salesDropLeadsCount}
- Today's Scheduled Follow-ups: ${stats.todayScheduledFollowups}
- Today's Missed Follow-ups (scheduled for today but missed): ${stats.todayMissedFollowups}
- Overall Missed Follow-ups (all-time missed): ${stats.overallMissedFollowups}
- Total Staff Members: ${stats.staffCount}
- Staff Members List: ${JSON.stringify(stats.staffList)}
- Active Pending Tasks: ${stats.activeTasks}
- Missed Follow-up Client Names (Up to 5): ${stats.missedNames ? stats.missedNames.join(", ") : "None"}
- Today's Scheduled Follow-up Client Names (Up to 5): ${stats.todayNames ? stats.todayNames.join(", ") : "None"}
- Upcoming Follow-ups (Next 7 Days): ${stats.upcomingFollowupsList ? JSON.stringify(stats.upcomingFollowupsList) : "None"}
- Company Details: ${stats.companyDetails ? `${stats.companyDetails.name} (Plan: ${stats.companyDetails.plan}, Staff Limit: ${stats.companyDetails.staffLimit}, Status: ${stats.companyDetails.status})` : "None"}
- Lead Sources: ${stats.leadSources ? stats.leadSources.join(", ") : "None"}
- Monthly Targets: ${JSON.stringify(stats.targets)}
- Message Templates: ${JSON.stringify(stats.templates)}
- Team Chat Unread Message Count: ${stats.unreadTeamMessagesCount}
- Recent Team Chat Messages: ${JSON.stringify(stats.recentTeamMessages)}
- Conversation Context: ${context ? JSON.stringify(context) : "None"}
- Chat History: ${history && history.length > 0 ? JSON.stringify(history) : "None"}

Listen carefully to the user's spoken voice command inside the attached audio file.
Instructions:
1. Transcribe the audio file exactly to text.
2. Formulate a natural, professional spoken reply to directly answer their query using the database stats provided above.
3. Speak clearly and concisely (limit to 1-2 short sentences maximum), UNLESS the user explicitly asks for "full details" or "address/mobile/etc". In that case, read out the full details (date, time, mobile, address etc.) clearly.
4. If they ask about missed follow-ups, carefully check if they are asking about *today's* missed follow-ups or *overall* missed follow-ups, and tell them the exact number and/or client names directly. Don't tell them overall missed if they asked for today's missed.
5. If they ask about Company Name, subscription plan, lead sources, admin/staff details, monthly targets, message templates, or team chat messages, read them the exact details from the metrics provided.

ADD ENQUIRY INSTRUCTIONS:
If the user asks to add or create an enquiry, OR if the Conversation Context mode is "ADD_ENQUIRY":
1. ALWAYS set context "mode" to "ADD_ENQUIRY".
2. ALWAYS preserve the existing "draft" fields from the Conversation Context. If starting a new draft, IMMEDIATELY set "priority", "source", and "assignedTo" to "skip" by default so you don't ask for them.
3. Look at the user's message. If they provided MULTIPLE enquiries (like a table or list of multiple people), extract ALL of them into a "drafts" array in the context JSON, where each item has {name, mobile, email, product, cost, address}.
4. If they provided a single enquiry's details in a sentence or form, extract ALL of them at once and save them into the single "draft" object. If they say "skip", save "skip".
5. Check the "draft" for missing fields in this exact strict order: name -> mobile -> email -> product -> cost -> address.
6. If there are missing fields, set intent to "GATHER_ENQUIRY_FIELD".
7. IMPORTANT: When asking for missing fields for the VERY FIRST TIME, provide this exact copy-paste form in your spokenText so the user can optionally fill everything at once:
"I can help with that! Please provide the details, or simply copy and fill this form:
Full name: 
Phone: 
Email: 
Product/Service: 
Estimate amount: 
Address: "
8. For subsequent turns, explicitly ask the user for the NEXT missing field in "spokenText" (e.g. "What is the phone number?"). DO NOT ask the same question twice in a row.
9. If ALL 9 fields are filled (or marked as skip), OR if you extracted multiple records into the "drafts" array, set intent to "SUBMIT_ENQUIRY" and say "All details captured. Submitting the enquiries now."

DATA ENGINE INSTRUCTIONS:
If the user asks for specific enquiries (e.g., "particular enq name", "today enquiries", "yesterday", "any date"):
- Set intent to "QUERY_ENQUIRIES".
- Add "queryParams": { "dateFilter": "today" | "yesterday" | "all" | "YYYY-MM-DD", "nameQuery": "optional name" } to the JSON.
If the user asks for "staff performance" or "leads pie chart" or "pie chart":
- Set intent to "SHOW_PIE_CHART".
- Add "chartTarget": "staff" (for staff performance) or "leads" (for lead status) to the JSON.
If the user asks to "send pdf", "export to excel", "give record for pdf/excel":
- Set intent to "EXPORT_DATA".
- Add "exportFormat": "pdf" | "excel" and "exportTarget": "enquiries" | "staff" to the JSON.

OTHER INSTRUCTIONS:
6. If they ask how to create/add an enquiry but do not want to use the voice assistant to do it, explain how to do it in the app.
7. If they ask how to schedule/make a follow-up, explain: "Open any enquiry, click 'Schedule Follow-up', choose the date and time, and save." (or in Tamil).
8. If they say "Good morning" or other greetings, respond warmly and professionally.
9. If they ask funny or playful questions, respond with a lighthearted, humorous, yet professional AI-themed reply.
10. If the user spoke in Tamil (e.g., uses Tamil text or sounds like "இன்று", "தவறவிட்ட"), reply in perfect, friendly, natural spoken Tamil. 
11. If they spoke in English, reply in English.
12. Keep the numbers and names 100% aligned with the stats provided above. Do not hallucinate.

You MUST respond with a JSON object in this exact structure:
{
  "recognizedText": "The exact transcription of what the user said in the audio",
  "spokenText": "The spoken answer text goes here.",
  "intent": "GET_GENERAL_STATS" or "GATHER_ENQUIRY_FIELD" or "SUBMIT_ENQUIRY" or "QUERY_ENQUIRIES" or "SHOW_PIE_CHART" or "EXPORT_DATA" or "UNKNOWN",
  "language": "en" or "ta",
  "context": { "mode": "ADD_ENQUIRY", "draft": { "priority": "...", "source": "...", "assignedTo": "...", "name": "...", "mobile": "...", "email": "...", "product": "...", "cost": "...", "address": "..." } },
  "queryParams": { "dateFilter": "today", "nameQuery": "" },
  "chartTarget": "staff",
  "exportFormat": "pdf",
  "exportTarget": "enquiries"
}
`;

    const models = [
        // Gemini 2.5
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-pro",

        // Gemini 2.0
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",

        // Gemini 1.5
        "gemini-1.5-flash",
        "gemini-1.5-flash-latest",
        "gemini-1.5-pro",
        "gemini-1.5-pro-latest",

        // Latest aliases
        "gemini-flash-latest",
        "gemini-pro",

        // Embedding
        "text-embedding-004",

        // Image / multimodal
        "gemini-2.0-flash-exp",
        "gemini-exp-1206"
    ];
    let lastError = null;

    for (const model of models) {
        let retries = 2;
        while (retries > 0) {
            try {
                console.log(`[Gemini API] Trying model ${model} (retries remaining: ${retries - 1})`);
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

                const response = await axios.post(url, {
                    contents: [{
                        parts: [
                            {
                                inlineData: {
                                    mimeType: (mimetype && mimetype.includes("m4a")) ? "audio/aac" : (mimetype || "audio/aac"),
                                    data: base64Audio
                                }
                            },
                            {
                                text: prompt
                            }
                        ]
                    }],
                    generationConfig: {
                        responseMimeType: "application/json"
                    }
                }, {
                    timeout: 11000
                });

                const resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!resultText) throw new Error(`Empty response from Gemini model ${model}`);

                console.log(`[Gemini API] Model ${model} successfully processed audio!`);
                return JSON.parse(resultText.trim());
            } catch (err) {
                console.warn(`[Gemini API Warning] Model ${model} failed: ${err.message || err}`);
                lastError = err;

                const status = err.response?.status;
                if (status === 400) {
                    console.log(`[Gemini API] Aborting candidacy early due to status ${status}`);
                    throw err; // Fail-fast to local stats fallback instantly!
                }

                // If model not found or rate limited, don't waste time retrying it, jump to next candidate!
                if (status === 404 || status === 429) {
                    console.log(`[Gemini API] Skipping model ${model} immediately due to status ${status}`);
                    break;
                }

                retries -= 1;
                if (retries > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                }
            }
        }
    }

    throw lastError || new Error("Failed to communicate with Gemini after trying candidates");
}

/**
 * Transcribes audio using OpenAI's Whisper API
 */
async function transcribeAudioWithWhisper(filePath, apiKey) {
    const url = "https://api.openai.com/v1/audio/transcriptions";

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    form.append("model", "whisper-1");

    const response = await axios.post(url, form, {
        headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${apiKey}`
        }
    });

    const text = response.data?.text;
    if (!text) throw new Error("Whisper transcription failed to return text.");
    return text;
}

/**
 * Interacts with Gemini Text API
 */
async function callGeminiAI(transcript, stats, apiKey, context, history) {
    const prompt = `
You are a highly efficient voice assistant for the Neogroww CRM database.
Below are the actual real-time CRM statistics and configuration for the logged-in user:
- Today's Date: ${stats.todayDate}
- Total Enquiries: ${stats.totalEnquiries}
- Today's Enquiries Added: ${stats.todayEnquiriesCount}
- Today's Enquiries List (Up to 10): ${stats.todayEnquiriesList ? JSON.stringify(stats.todayEnquiriesList) : "None"}
- Active Leads (In Progress): ${stats.activeLeads}
- Converted Leads (Success): ${stats.convertedEnquiries}
- Contacted Leads: ${stats.contactedLeadsCount}
- Sales Drop Leads: ${stats.salesDropLeadsCount}
- Today's Scheduled Follow-ups: ${stats.todayScheduledFollowups}
- Today's Missed Follow-ups (scheduled for today but missed): ${stats.todayMissedFollowups}
- Overall Missed Follow-ups (all-time missed): ${stats.overallMissedFollowups}
- Total Staff Members: ${stats.staffCount}
- Staff Members List: ${JSON.stringify(stats.staffList)}
- Active Pending Tasks: ${stats.activeTasks}
- Missed Follow-up Client Names (Up to 5): ${stats.missedNames ? stats.missedNames.join(", ") : "None"}
- Today's Scheduled Follow-up Client Names (Up to 5): ${stats.todayNames ? stats.todayNames.join(", ") : "None"}
- Upcoming Follow-ups (Next 7 Days): ${stats.upcomingFollowupsList ? JSON.stringify(stats.upcomingFollowupsList) : "None"}
- Company Details: ${stats.companyDetails ? `${stats.companyDetails.name} (Plan: ${stats.companyDetails.plan}, Staff Limit: ${stats.companyDetails.staffLimit}, Status: ${stats.companyDetails.status})` : "None"}
- Lead Sources: ${stats.leadSources ? stats.leadSources.join(", ") : "None"}
- Monthly Targets: ${JSON.stringify(stats.targets)}
- Message Templates: ${JSON.stringify(stats.templates)}
- Team Chat Unread Message Count: ${stats.unreadTeamMessagesCount}
- Recent Team Chat Messages: ${JSON.stringify(stats.recentTeamMessages)}
- Conversation Context: ${context ? JSON.stringify(context) : "None"}
- Chat History: ${history && history.length > 0 ? JSON.stringify(history) : "None"}

The user just spoke this query: "${transcript}"

Generate a natural, conversational spoken reply to directly answer their spoken query.
Instructions:
1. Speak clearly and concisely (limit to 1-2 short sentences maximum). Ideal for voice playback, UNLESS the user explicitly asks for "full details" or "address/mobile/etc". In that case, read out the full details (date, time, mobile, address etc.) clearly.
2. If they ask about missed follow-ups, carefully check if they are asking about *today's* missed follow-ups or *overall* missed follow-ups, and tell them the exact number and/or client names directly. Don't tell them overall missed if they asked for today's missed.
3. If they ask about Company Name, subscription plan, lead sources, admin/staff details, monthly targets, message templates, or team chat messages, read them the exact details from the metrics provided.

ADD ENQUIRY INSTRUCTIONS:
If the user asks to add or create an enquiry, OR if the Conversation Context mode is "ADD_ENQUIRY":
1. ALWAYS set context "mode" to "ADD_ENQUIRY".
2. ALWAYS preserve the existing "draft" fields from the Conversation Context. If starting a new draft, IMMEDIATELY set "priority", "source", and "assignedTo" to "skip" by default so you don't ask for them.
3. Look at the user's message. If they provided MULTIPLE enquiries (like a table or list of multiple people), extract ALL of them into a "drafts" array in the context JSON, where each item has {name, mobile, email, product, cost, address}.
4. If they provided a single enquiry's details in a sentence or form, extract ALL of them at once and save them into the single "draft" object. If they say "skip", save "skip".
5. Check the "draft" for missing fields in this exact strict order: name -> mobile -> email -> product -> cost -> address.
6. If there are missing fields, set intent to "GATHER_ENQUIRY_FIELD".
7. IMPORTANT: When asking for missing fields for the VERY FIRST TIME, provide this exact copy-paste form in your spokenText so the user can optionally fill everything at once:
"I can help with that! Please provide the details, or simply copy and fill this form:
Full name: 
Phone: 
Email: 
Product/Service: 
Estimate amount: 
Address: "
8. For subsequent turns, explicitly ask the user for the NEXT missing field in "spokenText" (e.g. "What is the phone number?"). DO NOT ask the same question twice in a row.
9. If ALL 9 fields are filled (or marked as skip), OR if you extracted multiple records into the "drafts" array, set intent to "SUBMIT_ENQUIRY" and say "All details captured. Submitting the enquiries now."

DATA ENGINE INSTRUCTIONS:
If the user asks for specific enquiries (e.g., "particular enq name", "today enquiries", "yesterday", "any date"):
- Set intent to "QUERY_ENQUIRIES".
- Add "queryParams": { "dateFilter": "today" | "yesterday" | "all" | "YYYY-MM-DD", "nameQuery": "optional name" } to the JSON.
If the user asks for "staff performance" or "leads pie chart" or "pie chart":
- Set intent to "SHOW_PIE_CHART".
- Add "chartTarget": "staff" (for staff performance) or "leads" (for lead status) to the JSON.
If the user asks to "send pdf", "export to excel", "give record for pdf/excel":
- Set intent to "EXPORT_DATA".
- Add "exportFormat": "pdf" | "excel" and "exportTarget": "enquiries" | "staff" to the JSON.

OTHER INSTRUCTIONS:
6. If they ask how to schedule/make a follow-up, explain: "Open any enquiry, click 'Schedule Follow-up', choose the date and time, and save." (or in Tamil).
7. If they ask what your name is (e.g. "tumhara naam Kaise" or "who are you"), politely reply that you are the NeoGroww Voice Assistant.
8. If they say "Good morning" or other greetings, respond warmly and professionally.
9. If they ask funny or playful questions, respond with a lighthearted, humorous, yet professional AI-themed reply.
10. LANGUAGE SUPPORT: If the user spoke in Tamil, reply in perfect Tamil. If they spoke in Hindi (e.g. "tumhara naam kya hai"), reply in Hindi. If English, reply in English.
11. BACKGROUND NOISE FILTER: If the user's transcript appears to be random background noise, gibberish, or incomplete fragments without a clear question (e.g. just "what this" or "hmm" or "come check"), do NOT try to answer. Set intent to "UNKNOWN" and spokenText to "I am listening, how can I help?"
12. Keep the numbers and names 100% aligned with the stats provided above. Do not hallucinate.

You MUST respond with a JSON object in this exact structure:
{
  "spokenText": "The spoken answer text goes here.",
  "intent": "GET_GENERAL_STATS" or "GATHER_ENQUIRY_FIELD" or "SUBMIT_ENQUIRY" or "QUERY_ENQUIRIES" or "SHOW_PIE_CHART" or "EXPORT_DATA" or "UNKNOWN",
  "language": "en" or "ta",
  "context": { "mode": "ADD_ENQUIRY", "draft": { "priority": "...", "source": "...", "assignedTo": "...", "name": "...", "mobile": "...", "email": "...", "product": "...", "cost": "...", "address": "..." } },
  "queryParams": { "dateFilter": "today", "nameQuery": "" },
  "chartTarget": "staff",
  "exportFormat": "pdf",
  "exportTarget": "enquiries"
}
`;

    const models = [
        "gemini-2.5-flash",
        "gemini-1.5-flash",
        "gemini-1.5-flash-latest",
        "gemini-flash-latest"
    ];

    let lastError = null;

    for (const model of models) {
        let retries = 2;
        while (retries > 0) {
            try {
                console.log(`[Gemini Text API] Trying model ${model} (retries remaining: ${retries - 1})`);
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

                const response = await axios.post(url, {
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }],
                    generationConfig: {
                        responseMimeType: "application/json"
                    }
                }, {
                    timeout: 7000
                });

                const resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!resultText) throw new Error(`Empty response from Gemini model ${model}`);

                console.log(`[Gemini Text API] Model ${model} successfully replied!`);
                return JSON.parse(resultText.trim());
            } catch (err) {
                console.warn(`[Gemini Text API Warning] Model ${model} failed: ${err.message || err}`);
                lastError = err;

                const status = err.response?.status;
                if (status === 400) {
                    console.log(`[Gemini Text API] Aborting candidacy early due to status ${status}`);
                    throw err; // Fail-fast to local stats fallback instantly!
                }

                // If model not found or rate limited, don't waste time retrying it, jump to next candidate!
                if (status === 404 || status === 429) {
                    console.log(`[Gemini Text API] Skipping model ${model} immediately due to status ${status}`);
                    break;
                }

                retries -= 1;
                if (retries > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                }
            }
        }
    }

    throw lastError || new Error("Failed to communicate with Gemini after trying candidates");
}

/**
 * Interacts with OpenAI GPT-4o-mini API
 */
async function callOpenAI(transcript, stats, apiKey) {
    const url = "https://api.openai.com/v1/chat/completions";

    const prompt = `
You are a voice assistant for the Neogroww CRM.
Real-time CRM Stats:
- Total Enquiries: ${stats.totalEnquiries}
- Today's Enquiries Added: ${stats.todayEnquiriesCount}
- Today's Enquiries List (Up to 10): ${stats.todayEnquiriesList ? JSON.stringify(stats.todayEnquiriesList) : "None"}
- Active Leads: ${stats.activeLeads}
- Converted Leads: ${stats.convertedEnquiries}
- Today's Scheduled Follow-ups: ${stats.todayScheduledFollowups}
- Overall Missed Follow-ups: ${stats.overallMissedFollowups}
- Upcoming Follow-ups (Next 7 Days): ${stats.upcomingFollowupsList ? JSON.stringify(stats.upcomingFollowupsList) : "None"}

User command: "${transcript}"

Generate a natural reply. If they speak Tamil, speak back in Tamil. If English, answer in English. 1-2 sentences max, UNLESS the user explicitly asks for full details or specific fields (address, mobile, etc.), in which case provide all requested details clearly.`;

    const response = await axios.post(
        url,
        {
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an assistant that outputs 100% valid JSON with these keys: 'spokenText' (string), 'intent' (string), and 'language' (string: 'en' or 'ta')."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            response_format: { type: "json_object" }
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            }
        }
    );

    const resultText = response.data?.choices?.[0]?.message?.content;
    if (!resultText) throw new Error("Empty response from OpenAI");

    return JSON.parse(resultText.trim());
}

/**
 * Smart Regex Local Fallback (zero-cost, runs offline if no AI API key is set)
 */
function handleLocalFallback(transcript, stats, history = [], context = null) {
    let t = transcript.toLowerCase();

    // --- Auto-detect Bulk Enquiries from Table or Context ---
    const isAddIntent = t.includes("add enq") || t.includes("add lead") || t.includes("bulk assign");
    const hasTable = transcript.includes("|") && transcript.split("\n").length >= 2;

    if (hasTable || isAddIntent || (context && context.mode === "ADD_ENQUIRY")) {
        let drafts = [];
        const lines = transcript.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        if (hasTable || lines.some(l => l.includes("|"))) {
            const tableLines = lines.filter(l => l.includes("|") && !l.includes("---") && !l.toLowerCase().includes("full name"));
            for (const line of tableLines) {
                const cols = line.split("|").map(c => c.trim()).filter(Boolean);
                if (cols.length >= 2) {
                    drafts.push({
                        name: cols[0] || "Unknown",
                        mobile: cols[1] || "0000000000",
                        email: (cols[2] || "").replace(/\[.*?\]\(.*?\)/g, (match) => match.split("]")[0].replace("[", "")) || "",
                        product: cols[3] || "",
                        cost: (cols[4] || "").replace(/[^0-9]/g, "") || "0",
                        address: cols[5] || ""
                    });
                }
            }
        } else if (lines.length >= 2 && !t.includes("full name:")) {
            // Simple line-by-line fallback for a single enquiry
            drafts.push({
                name: lines[0] || "Unknown",
                mobile: lines[1] || "0000000000",
                email: lines[2] || "",
                product: lines[3] || "",
                cost: (lines[4] || "").replace(/[^0-9]/g, "") || "0",
                address: lines[5] || ""
            });
        }

        if (drafts.length > 0) {
            return {
                spokenText: `Offline Mode: Extracted ${drafts.length} enquiries from text. Adding them now.`,
                intent: "SUBMIT_ENQUIRY",
                language: "en",
                context: { mode: "ADD_ENQUIRY", drafts }
            };
        }

        // If no drafts could be parsed but they want to add
        return {
            spokenText: "Offline Mode: I understand you want to add enquiries, but I couldn't parse the details. Please provide them clearly.",
            intent: "GATHER_ENQUIRY_FIELD",
            language: "en",
            context: { mode: "ADD_ENQUIRY" }
        };
    }

    // --- Contextual Follow-up Processing ---
    if (history && history.length > 0) {
        const lastMsg = history[history.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
            const lastText = lastMsg.text.toLowerCase();
            const isFollowup = t.includes("address") || t.includes("detail") || t.includes("number") || t.includes("who") || t.includes("what") || t.includes("full") || t.includes("விவரம்") || t.includes("முகவரி");

            if (isFollowup) {
                if (lastText.includes("upcoming") || lastText.includes("this week") || lastText.includes("வாரம்")) {
                    t = "upcoming full detail " + t;
                } else if (lastText.includes("today") || lastText.includes("இன்று")) {
                    t = "today schedule full detail " + t;
                } else if (lastText.includes("miss") || lastText.includes("தவறவிட்ட")) {
                    t = "missed full detail " + t;
                }
            }
        }
    }


    // Tamil indicators (including Tamil Unicode block + colloquial terms)
    const isTamil = /[\u0B80-\u0BFF]/.test(t) || t.includes("இன்று") || t.includes("இன்னைக்கு") || t.includes("தவறவிட்ட") || t.includes("மிஸ்") || t.includes("வணக்கம்") || t.includes("யாரு") || t.includes("டாஸ்க்") || t.includes("ஸ்டாஃப்") || t.includes("பிளான்") || t.includes("டார்கெட்") || t.includes("டெம்ப்ளேட்") || t.includes("சேட்") || t.includes("சோர்ஸ்") || t.includes("லீட்") || t.includes("லிஸ்ட்") || t.includes("யார்") || t.includes("பெயர்") || t.includes("காலை");

    // Intent: Morning / General Greeting
    if (t.includes("morning") || t.includes("காலை")) {
        return {
            spokenText: isTamil
                ? "இனிய காலை வணக்கம்! இன்றைய நாள் தங்களுக்கு மிகச் சிறந்த நாளாக அமைய வாழ்த்துகிறேன்."
                : "Good morning! Wishing you a highly productive and successful day for your business.",
            intent: "GREETING",
            language: isTamil ? "ta" : "en"
        };
    }

    if (/\b(hello|hi|hey)\b/.test(t) || t.includes("வணக்கம்")) {
        return {
            spokenText: isTamil
                ? "வணக்கம்! நான் உங்கள் NeoGroww உதவி மென்பொருள். இன்று உங்களுக்கு எவ்வாறு உதவட்டும்?"
                : "Hello! I am your NeoGroww CRM Assistant. How can I help you today?",
            intent: "GREETING",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: How to create Enquiry
    if ((t.includes("enquiry") || t.includes("lead") || t.includes("கோரிக்கை") || t.includes("லீடு")) && (t.includes("create") || t.includes("add") || t.includes("new") || t.includes("how") || t.includes("உருவாக்கு") || t.includes("போட") || t.includes("எப்படி"))) {
        return {
            spokenText: isTamil
                ? "புதிய கோரிக்கையை உருவாக்க, திரையின் மேலே உள்ள 'பிளஸ்' (+) அல்லது 'கோரிக்கை சேர்' பொத்தானை அழுத்தி, விவரங்களை நிரப்பி சேமிக்கவும்."
                : "To create an enquiry, tap the plus (+) or 'Add Enquiry' button on the dashboard/enquiries screen, fill in client info, and save.",
            intent: "HELP_ENQUIRY",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: How to schedule Follow-up
    if ((t.includes("followup") || t.includes("ஃபாலோ அப்") || t.includes("ஃபாலோஅப்") || t.includes("தொடர்பு")) && (t.includes("make") || t.includes("schedule") || t.includes("create") || t.includes("how") || t.includes("எப்படி") || t.includes("உருவாக்கு") || t.includes("அட்டவணை"))) {
        return {
            spokenText: isTamil
                ? "ஃபாலோ-அப் செய்ய, ஏதேனும் ஒரு கோரிக்கையை திறந்து, 'பின்தொடர்தல் அட்டவணை' பொத்தானை அழுத்தி, தேதி மற்றும் நேரத்தைத் தேர்ந்தெடுத்து சேமிக்கவும்."
                : "To schedule a follow-up, open any enquiry, tap the 'Schedule Follow-up' button, pick the date and time, and click save.",
            intent: "HELP_FOLLOWUP",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Role access configs
    if (t.includes("access") || t.includes("permission") || t.includes("role") || t.includes("அணுகல்") || t.includes("ரோல்")) {
        return {
            spokenText: isTamil
                ? "இந்த மென்பொருள் முற்றிலும் பாதுகாப்பான வாசிப்பு உரிமை கொண்டது. நிர்வாகிகள் அனைத்து விவரங்களையும், பணியாளர்கள் தங்களுக்கு ஒதுக்கப்பட்ட விவரங்களை மட்டுமே பார்க்க முடியும்."
                : "The voice assistant operates strictly in secure read-only mode based on roles. Admins manage company settings while staff can see their assigned leads.",
            intent: "HELP_ACCESS",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Funny / Humor playful queries
    if (t.includes("love") || t.includes("joke") || t.includes("human") || t.includes("marry") || t.includes("காத") || t.includes("கதை") || t.includes("மனித") || t.includes("சிரி")) {
        return {
            spokenText: isTamil
                ? "நான் ஒரு செயற்கை நுண்ணறிவு மென்பொருள். எனது ஒரே காதல் உங்கள் வணிகத்தை உயர்த்துவதும், உங்கள் ஃபாலோ-அப்களை நினைவூட்டுவதும் மட்டுமே!"
                : "I am an AI, so my true love is helping you organize follow-ups and watching your business grow every single day!",
            intent: "FUNNY",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Casual Conversational Chat
    if (/\b(coffee|tea|drink)\b/.test(t) || t.includes("காபி") || t.includes("டீ") || t.includes("சாப்பி")) {
        return {
            spokenText: isTamil
                ? "நான் ஒரு மென்பொருள் என்பதால் காபி, டீ குடிக்க முடியாது. ஆனால் உங்கள் வணிகத் தரவுகள் மற்றும் மின்சார ஆற்றலில் நான் சுறுசுறுப்பாக இயங்குகிறேன்!"
                : "I don't drink coffee or tea since I am an AI, but I run on electric code and server database power!",
            intent: "FUNNY",
            language: isTamil ? "ta" : "en"
        };
    }

    if (t.includes("how are you") || t.includes("how're you") || t.includes("எப்படி இருக்கீ") || t.includes("நலமா")) {
        return {
            spokenText: isTamil
                ? "நான் மிகவும் நலமாக இருக்கிறேன், நன்றி! உங்கள் வணிகக் கோரிக்கைகள் மற்றும் ஃபாலோ-அப்களை நிர்வகிக்க நான் எப்போதும் தயாராக உள்ளேன்."
                : "I am doing fantastic, thank you! I'm fully charged and ready to organize your enquiries and follow-ups.",
            intent: "FUNNY",
            language: isTamil ? "ta" : "en"
        };
    }

    if (t.includes("who are you") || t.includes("your name") || t.includes("what's your name") || t.includes("நீ யார்") || t.includes("யார் நீ") || t.includes("உன் பெயர்")) {
        return {
            spokenText: isTamil
                ? "நான் உங்கள் நியோ குரல் உதவி மென்பொருள். உங்கள் லீட்ஸ் மற்றும் ஃபாலோ-அப் தகவல்களைப் படிக்க உங்களுக்கு உதவ நான் வடிவமைக்கப்பட்டுள்ளேன்."
                : "I am your Neo Voice Assistant, designed to help you manage and view your leads and follow-ups.",
            intent: "FUNNY",
            language: isTamil ? "ta" : "en"
        };
    }

    if (t.includes("thank") || t.includes("நன்றி")) {
        return {
            spokenText: isTamil
                ? "மிக்க நன்றி! உங்களுடன் இணைந்து பணியாற்றுவதில் நான் மகிழ்ச்சி அடைகிறேன்."
                : "You are very welcome! I'm always happy to assist you with your business database.",
            intent: "FUNNY",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Company Plan details
    if (t.includes("plan") || t.includes("company") || t.includes("பிளான்") || t.includes("நிறுவனம்")) {
        const comp = stats.companyDetails;
        if (comp) {
            return {
                spokenText: isTamil
                    ? `உங்கள் நிறுவனம் பெயர் ${comp.name}. நீங்கள் ${comp.plan} திட்டத்தில் உள்ளீர்கள். நிலைமை ${comp.status}.`
                    : `Your company is ${comp.name}. You are on the ${comp.plan} plan, status is ${comp.status}.`,
                intent: "GET_COMPANY_PLAN",
                language: isTamil ? "ta" : "en"
            };
        } else {
            return {
                spokenText: isTamil ? "நிறுவன விவரங்கள் கிடைக்கவில்லை." : "Company details are not available.",
                intent: "GET_COMPANY_PLAN",
                language: isTamil ? "ta" : "en"
            };
        }
    }

    // Intent: Lead Sources
    if (t.includes("source") || t.includes("சோர்ஸ்") || t.includes("மூலம்")) {
        const sources = stats.leadSources || [];
        if (sources.length === 0) {
            return {
                spokenText: isTamil ? "விற்பனை மூலங்கள் ஏதுமில்லை." : "You have zero lead sources configured.",
                intent: "GET_LEAD_SOURCES",
                language: isTamil ? "ta" : "en"
            };
        }
        return {
            spokenText: isTamil
                ? `உங்கள் விற்பனை மூலங்கள்: ${sources.join(", ")}.`
                : `Your lead sources are: ${sources.join(", ")}.`,
            intent: "GET_LEAD_SOURCES",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Targets
    if (t.includes("target") || t.includes("டார்கெட்") || t.includes("இலக்கு")) {
        const targets = stats.targets || [];
        if (targets.length === 0) {
            return {
                spokenText: isTamil ? "இலக்குகள் ஏதும் அமைக்கப்படவில்லை." : "You have zero monthly targets configured.",
                intent: "GET_TARGETS",
                language: isTamil ? "ta" : "en"
            };
        }
        const current = targets[0];
        return {
            spokenText: isTamil
                ? `${current.year} ஆம் ஆண்டு ${current.month} ஆம் மாத இலக்கு: கோரிக்கைகள் ${current.leadsTarget || 0}, பட்ஜெட் ${current.marketingBudget || 0}, வருமானம் ${current.incomeTarget || 0}.`
                : `Target for ${current.year}/${current.month} is: ${current.leadsTarget || 0} leads, budget ${current.marketingBudget || 0}, and income ${current.incomeTarget || 0}.`,
            intent: "GET_TARGETS",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Templates
    if (t.includes("template") || t.includes("டெம்ப்ளேட்") || t.includes("பதில்கள்")) {
        const temps = stats.templates || [];
        if (temps.length === 0) {
            return {
                spokenText: isTamil ? "டெம்ப்ளேட்டுகள் ஏதுமில்லை." : "You have zero templates configured.",
                intent: "GET_TEMPLATES",
                language: isTamil ? "ta" : "en"
            };
        }
        const keywords = temps.map(t => t.keyword);
        return {
            spokenText: isTamil
                ? `உங்களிடம் ${temps.length} டெம்ப்ளேட்டுகள் உள்ளன. முக்கிய சொற்கள்: ${keywords.join(", ")}.`
                : `You have ${temps.length} templates. Keywords: ${keywords.join(", ")}.`,
            intent: "GET_TEMPLATES",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Team Chat
    if (t.includes("chat") || t.includes("message") || t.includes("செய்தி") || t.includes("சேட்") || t.includes("மெசேஜ்")) {
        const count = stats.unreadTeamMessagesCount || 0;
        if (isTamil) {
            return {
                spokenText: count > 0
                    ? `உங்களுக்கு ${count} புதிய குழு செய்திகள் வந்துள்ளன.`
                    : "உங்களுக்கு புதிய குழு செய்திகள் ஏதுமில்லை.",
                intent: "GET_TEAM_CHAT",
                language: "ta"
            };
        } else {
            return {
                spokenText: count > 0
                    ? `You have ${count} unread team messages in your chat.`
                    : "You have zero unread team messages.",
                intent: "GET_TEAM_CHAT",
                language: "en"
            };
        }
    }

    // Intent: Staff Members Count / Names (colloquial & standard)
    if (t.includes("staff") || t.includes("member") || t.includes("ஸ்டாஃப்") || t.includes("ஸ்டாப்") || t.includes("பணியாளர்கள்")) {
        const count = stats.staffCount || 0;
        const list = stats.staffList || [];
        const wantsNames = t.includes("name") || t.includes("who") || t.includes("list") || t.includes("பெயர்") || t.includes("யார்") || t.includes("லிஸ்ட்");

        if (wantsNames) {
            if (list.length === 0) {
                return {
                    spokenText: isTamil
                        ? "பணியாளர்கள் விவரங்கள் எதுவும் கிடைக்கவில்லை."
                        : "No staff member details were found.",
                    intent: "GET_STAFF_COUNT",
                    language: isTamil ? "ta" : "en"
                };
            }
            const namesAndRoles = list.map(u => `${u.name} (${isTamil ? (u.role === 'Admin' ? 'நிர்வாகி' : 'பணியாளர்') : u.role})`).join(", ");
            return {
                spokenText: isTamil
                    ? `உங்கள் நிறுவனத்தில் உள்ள பணியாளர்கள்: ${namesAndRoles}. மொத்தம் ${count} நபர்கள்.`
                    : `Your staff members are: ${namesAndRoles}. Totaling ${count} members.`,
                intent: "GET_STAFF_COUNT",
                language: isTamil ? "ta" : "en"
            };
        }

        if (isTamil) {
            return {
                spokenText: count > 0
                    ? `உங்களிடம் மொத்தம் ${count} பணியாளர்கள் வேலை செய்கிறார்கள்.`
                    : "உங்களிடம் பணியாளர்கள் யாரும் இல்லை.",
                intent: "GET_STAFF_COUNT",
                language: "ta"
            };
        } else {
            return {
                spokenText: count > 0
                    ? `You have a total of ${count} staff members working in your company.`
                    : "You have zero staff members in your company.",
                intent: "GET_STAFF_COUNT",
                language: "en"
            };
        }
    }

    // Intent: Active pending Tasks
    if (t.includes("task") || t.includes("டாஸ்க்") || t.includes("வேலை")) {
        const count = stats.activeTasks || 0;
        if (isTamil) {
            return {
                spokenText: count > 0
                    ? `உங்களுக்கு ${count} வேலைகள் நிலுவையில் உள்ளன.`
                    : "உங்களுக்கு நிலுவையில் உள்ள வேலைகள் ஏதுமில்லை.",
                intent: "GET_TASK_COUNT",
                language: "ta"
            };
        } else {
            return {
                spokenText: count > 0
                    ? `You have ${count} pending active tasks to complete.`
                    : "You have zero pending tasks.",
                intent: "GET_TASK_COUNT",
                language: "en"
            };
        }
    }

    // Intent: Contacted Leads
    if (t.includes("contacted") || t.includes("தொடர்புகொள்ளப்பட்டது")) {
        const count = stats.contactedLeadsCount || 0;
        return {
            spokenText: isTamil
                ? `உங்களிடம் மொத்தம் ${count} தொடர்புகொள்ளப்பட்ட கோரிக்கைகள் உள்ளன.`
                : `You have a total of ${count} contacted enquiries.`,
            intent: "GET_GENERAL_STATS",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Sales Drop
    if (t.includes("drop") || t.includes("dropped") || t.includes("நிறுத்தப்பட்டவை") || t.includes("டிராப்")) {
        const count = stats.salesDropLeadsCount || 0;
        return {
            spokenText: isTamil
                ? `உங்களிடம் மொத்தம் ${count} நிறுத்தப்பட்ட கோரிக்கைகள் உள்ளன.`
                : `You have a total of ${count} dropped enquiries.`,
            intent: "GET_GENERAL_STATS",
            language: isTamil ? "ta" : "en"
        };
    }

    // Intent: Names of Missed Follow-ups or Today's Scheduled
    if (t.includes("name") || t.includes("who") || t.includes("yaar") || t.includes("நபர்") || t.includes("யாரு") || t.includes("லிஸ்ட்")) {
        // If they ask about missed follow-up client names
        if (t.includes("miss") || t.includes("தவறவிட்ட")) {
            const isToday = t.includes("today") || t.includes("இன்று") || t.includes("இன்னைக்கு");
            const count = isToday ? (stats.todayMissedFollowups || 0) : (stats.overallMissedFollowups || 0);
            const details = isToday ? stats.todayDetails || [] : stats.missedDetails || [];
            const wantsDetails = t.includes("detail") || t.includes("full") || t.includes("விவரம்") || t.includes("முழு") || t.includes("முகவரி") || t.includes("எண்");
            if (count === 0) {
                return {
                    spokenText: isTamil
                        ? `${isToday ? "இன்றைய" : "ஒட்டுமொத்த"} தவறவிட்ட தொடர்புகள் யாருமில்லை!`
                        : `You have zero ${isToday ? "today's" : "overall"} missed follow-ups!`,
                    intent: "GET_MISSED_NAMES",
                    language: isTamil ? "ta" : "en"
                };
            }
            const namesStr = wantsDetails
                ? details.map(f => `${f.name} (Mobile: ${f.mobile}, Address: ${f.address})`).join(". ")
                : details.map(f => f.name).join(", ");

            const namesStrTa = wantsDetails
                ? details.map(f => `${f.name} (எண்: ${f.mobile}, முகவரி: ${f.address})`).join(". ")
                : details.map(f => f.name).join(", ");

            if (isTamil) {
                return {
                    spokenText: wantsDetails
                        ? `தவறவிட்ட நபர்களின் விவரங்கள்: ${namesStrTa}. மொத்தம் ${count} தொடர்புகள் உள்ளன.`
                        : `தவறவிட்ட நபர் பெயர்கள்: ${namesStrTa}. மொத்தம் ${count} தொடர்புகள் உள்ளன.`,
                    intent: "GET_MISSED_NAMES",
                    language: "ta"
                };
            } else {
                return {
                    spokenText: wantsDetails
                        ? `Here are the details for your missed follow-ups: ${namesStr}. Totaling ${count} clients.`
                        : `Your missed follow-ups are with: ${namesStr}. Totaling ${count} clients.`,
                    intent: "GET_MISSED_NAMES",
                    language: "en"
                };
            }
        }

        // If they ask about today's scheduled follow-up names
        if (t.includes("today") || t.includes("schedule") || t.includes("இன்று") || t.includes("இன்னைக்கு")) {
            const count = stats.todayScheduledFollowups || 0;
            const details = stats.todayDetails || [];
            const wantsDetails = t.includes("detail") || t.includes("full") || t.includes("விவரம்") || t.includes("முழு") || t.includes("முகவரி") || t.includes("எண்");

            if (count === 0) {
                return {
                    spokenText: isTamil ? "இன்று திட்டமிடப்பட்டவர்கள் யாருமில்லை!" : "You have zero scheduled follow-ups today!",
                    intent: "GET_TODAY_NAMES",
                    language: isTamil ? "ta" : "en"
                };
            }
            const namesStr = wantsDetails
                ? details.map(f => `${f.name} (Mobile: ${f.mobile}, Address: ${f.address})`).join(". ")
                : details.map(f => f.name).join(", ");

            const namesStrTa = wantsDetails
                ? details.map(f => `${f.name} (எண்: ${f.mobile}, முகவரி: ${f.address})`).join(". ")
                : details.map(f => f.name).join(", ");

            if (isTamil) {
                return {
                    spokenText: wantsDetails
                        ? `இன்று திட்டமிடப்பட்டவர்களின் விவரங்கள்: ${namesStrTa}. மொத்தம் ${count} தொடர்புகள் உள்ளன.`
                        : `இன்று திட்டமிடப்பட்ட நபர் பெயர்கள்: ${namesStrTa}. மொத்தம் ${count} தொடர்புகள் உள்ளன.`,
                    intent: "GET_TODAY_NAMES",
                    language: "ta"
                };
            } else {
                return {
                    spokenText: wantsDetails
                        ? `Here are the details for today's scheduled follow-ups: ${namesStr}. Totaling ${count} clients.`
                        : `Today's scheduled follow-ups are with: ${namesStr}. Totaling ${count} clients.`,
                    intent: "GET_TODAY_NAMES",
                    language: "en"
                };
            }
        }
    }

    // Intent: Missed Follow-ups (Generic count query)
    if (t.includes("missed") || t.includes("miss") || t.includes("தவறவிட்ட") || t.includes("மிஸ்டு")) {
        const isToday = t.includes("today") || t.includes("இன்று") || t.includes("இன்னைக்கு");
        const count = isToday ? (stats.todayMissedFollowups || 0) : (stats.overallMissedFollowups || 0);
        if (isTamil) {
            return {
                spokenText: count > 0
                    ? `உங்களுக்கு ${isToday ? "இன்று மட்டும்" : "ஒட்டுமொத்தமாக"} ${count} தவறவிட்ட தொடர்புகள் உள்ளன.`
                    : `உங்களுக்கு ${isToday ? "இன்றைய" : "ஒட்டுமொத்த"} தவறவிட்ட தொடர்புகள் ஏதுமில்லை.`,
                intent: "GET_MISSED_FOLLOWUPS",
                language: "ta"
            };
        } else {
            return {
                spokenText: count > 0
                    ? `You have ${count} ${isToday ? "today's" : "overall"} missed follow-ups.`
                    : `You have zero ${isToday ? "today's" : "overall"} missed follow-ups.`,
                intent: "GET_MISSED_FOLLOWUPS",
                language: "en"
            };
        }
    }

    // Intent: Upcoming / This week follow-ups
    if (t.includes("upcoming") || t.includes("this week") || t.includes("week") || t.includes("next") || t.includes("எதிர்வரும்") || t.includes("இந்த வாரம்") || t.includes("வரவிருக்கும்")) {
        const upcomingList = stats.upcomingFollowupsList || [];
        const count = upcomingList.length;
        const wantsDetails = t.includes("detail") || t.includes("full") || t.includes("விவரம்") || t.includes("முழு");

        if (isTamil) {
            if (count > 0) {
                const namesStr = wantsDetails
                    ? upcomingList.map(f => `${f.name} (${f.date} அன்று ${f.time || 'எந்த நேரத்திலும்'}, எண்: ${f.mobile}, முகவரி: ${f.address})`).join(". ")
                    : upcomingList.map(f => f.name).join(", ");

                const spokenText = wantsDetails
                    ? `உங்களுக்கு ${count} திட்டமிடப்பட்ட தொடர்புகள் உள்ளன. விவரங்கள்: ${namesStr}.`
                    : `இந்த வாரம் உங்களுக்கு ${count} தொடர்புகள் திட்டமிடப்பட்டுள்ளன. அவர்கள்: ${namesStr}.`;

                return {
                    spokenText,
                    intent: "GET_UPCOMING_FOLLOWUPS",
                    language: "ta"
                };
            } else {
                return {
                    spokenText: "இந்த வாரம் உங்களுக்கு திட்டமிடப்பட்ட தொடர்புகள் எதுவும் இல்லை.",
                    intent: "GET_UPCOMING_FOLLOWUPS",
                    language: "ta"
                };
            }
        } else {
            if (count > 0) {
                const namesStr = wantsDetails
                    ? upcomingList.map(f => `${f.name} (On ${f.date} at ${f.time || 'Any time'}, Mobile: ${f.mobile}, Address: ${f.address})`).join(". ")
                    : upcomingList.map(f => f.name).join(", ");

                const spokenText = wantsDetails
                    ? `You have ${count} upcoming follow-ups. Here are the details: ${namesStr}.`
                    : `You have ${count} upcoming follow-ups this week with: ${namesStr}.`;

                return {
                    spokenText,
                    intent: "GET_UPCOMING_FOLLOWUPS",
                    language: "en"
                };
            } else {
                return {
                    spokenText: "You have zero upcoming follow-ups scheduled for this week.",
                    intent: "GET_UPCOMING_FOLLOWUPS",
                    language: "en"
                };
            }
        }
    }

    // Intent: Today's scheduled (Generic count query)
    if (t.includes("today") || t.includes("schedule") || t.includes("இன்று") || t.includes("இன்னைக்கு")) {
        const count = stats.todayScheduledFollowups;
        if (isTamil) {
            return {
                spokenText: count > 0
                    ? `இன்று உங்களுக்கு ${count} தொடர்புகள் திட்டமிடப்பட்டுள்ளன.`
                    : "இன்று உங்களுக்கு புதிய திட்டமிடப்பட்ட தொடர்புகள் எதுவும் இல்லை.",
                intent: "GET_TODAY_FOLLOWUPS",
                language: "ta"
            };
        } else {
            return {
                spokenText: count > 0
                    ? `You have ${count} follow-ups scheduled for today.`
                    : "You have zero follow-ups scheduled for today.",
                intent: "GET_TODAY_FOLLOWUPS",
                language: "en"
            };
        }
    }

    // Intent: General Stats / Overall
    if (t.includes("stats") || t.includes("lead") || t.includes("enquiry") || t.includes("விற்பனை") || t.includes("மொத்தம்")) {
        if (isTamil) {
            return {
                spokenText: `உங்களிடம் மொத்தம் ${stats.totalEnquiries} கோரிக்கைகள் உள்ளன. அதில் ${stats.convertedEnquiries} வெற்றிகரமாக மாற்றப்பட்டுள்ளன.`,
                intent: "GET_GENERAL_STATS",
                language: "ta"
            };
        } else {
            return {
                spokenText: `You have a total of ${stats.totalEnquiries} enquiries, with ${stats.convertedEnquiries} successfully converted to sales.`,
                intent: "GET_GENERAL_STATS",
                language: "en"
            };
        }
    }

    // Unrecognized
    return {
        spokenText: isTamil
            ? "மன்னிக்கவும், அந்த கட்டளை எனக்கு புரியவில்லை. இன்று எத்தனை தவறவிட்டவை என்று கேட்டுப்பாருங்கள்."
            : "Sorry, I didn't recognize that command. Try asking: how many missed today?",
        intent: "UNKNOWN",
        language: isTamil ? "ta" : "en"
    };
}

module.exports = router;
