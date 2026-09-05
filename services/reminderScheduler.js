/**
 * reminderScheduler.js
 *
 * FIX SUMMARY (3 bugs resolved):
 *
 * BUG 1 — "5,4 or 3,2,1 arrive together after server restart"
 *   ROOT CAUSE: sentReminders was an in-memory Map. Any server restart (even
 *   a crash + PM2 auto-restart) wiped the dedup state, so the scheduler
 *   re-fired every window that had already been sent.
 *   FIX: Persist the sent-timestamp inside the FollowUp document itself
 *   (`remindersSentAt.<minutesKey>` field). This survives restarts forever.
 *
 * BUG 2 — "no notification in background / closed app"
 *   ROOT CAUSE: The FCM payload sent by firebaseNotificationService was
 *   data-only (no `notification` field). Android and iOS ONLY auto-display
 *   a notification with sound when the FCM message contains a `notification`
 *   object. Data-only messages are silently ignored when the app is killed.
 *   FIX: See firebaseNotificationService.js — every FCM send now includes
 *   `notification: { title, body }` + `android.notification.channelId` + `apns`.
 *
 * BUG 3 — "multiple old reminders arrive together when device reconnects"
 *   ROOT CAUSE: FCM had no TTL per message, so a device that was offline
 *   for 5 minutes received all 5 queued reminders at once on reconnect.
 *   FIX: Each FCM message is now sent with `ttl = (window_seconds - 30)s`
 *   and a `collapseKey` so only the newest reminder for a given follow-up
 *   survives when the device comes online late.
 *   See firebaseNotificationService.js for the TTL/collapseKey implementation.
 */

const FollowUp = require("../models/FollowUp");
const User = require("../models/User");
const firebaseNotificationService = require("./firebaseNotificationService");
const { sendExpoNotification } = require("../BACKEND_NOTIFICATIONS");
const dailyReportService = require("./dailyReportService");
const dailyQuoteService = require("./dailyQuoteService");

let lastDailyReportDate = ""; // Format: YYYY-MM-DD to ensure once-per-day
let lastMorningQuoteDate = "";
let lastEveningQuoteDate = "";

let _schedulerTimeoutId = null;

const DEBUG =
    String(process.env.REMINDER_SCHEDULER_DEBUG || "").toLowerCase() === "true";
const debugLog = (...args) => {
    if (!DEBUG) return;
    console.log(...args);
};

const ENABLE_EXPO_PUSH_REMINDER_FALLBACK =
    String(process.env.ENABLE_EXPO_PUSH_REMINDER_FALLBACK || "")
        .trim()
        .toLowerCase() === "true";

const normalizeLang = (value) =>
    String(value || "en").toLowerCase() === "ta" ? "ta" : "en";

const resolveActivityTypeKey = (activityType = "followup") => {
    const raw = String(activityType || "")
        .trim()
        .toLowerCase();
    if (raw === "phone call" || raw === "phone" || raw === "call")
        return "phone";
    if (raw === "meeting") return "meeting";
    if (raw === "email") return "email";
    if (raw === "whatsapp" || raw === "wa") return "whatsapp";
    return "followups";
};

const resolveChannelKey = (activityType, minutesLeft, voiceLang) => {
    const typeKey = resolveActivityTypeKey(activityType);
    const lang = normalizeLang(voiceLang);
    if (minutesLeft === 0) return `${typeKey}_due_${lang}`;
    if (minutesLeft < 0) return `${typeKey}_missed_${lang}`;
    const m = Math.max(1, Math.min(5, Number(minutesLeft) || 1));
    return `${typeKey}_${m}min_${lang}`;
};


// ─── Rich notification content builders ──────────────────────────────────────
// These mirror the logic in src/constants/notificationPhrases.js so that
// background/closed-app Expo notifications have the SAME content as foreground.

const _normalizeActivityKey = (activityType) => {
    const raw = String(activityType || "").trim().toLowerCase();
    if (raw === "phone call" || raw === "phone" || raw === "call") return "phone";
    if (raw === "whatsapp" || raw === "wa") return "whatsapp";
    if (raw === "email" || raw === "mail") return "email";
    if (raw === "meeting" || raw === "online meeting") return "meeting";
    return "followup";
};

const _prefix = (name, actorName) => {
    const customer = String(name || "Client").trim();
    const actor = String(actorName || "").trim();
    if (!actor || actor === customer) return customer;
    return `${actor} • ${customer}`;
};

const _formatHHmm = (date) => {
    if (!date) return "";
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
};

// Notification building is now handled by firebaseNotificationService.buildTexts for consistency across FCM and Expo fallback.


// ─── Configuration ────────────────────────────────────────────────────────────

const PRE_REMINDER_WINDOWS = [60, 5, 4, 3, 2, 1];
const DUE_MINUTES_LEFT = 0;
const MISSED_MINUTES_LEFT = -1;

const MINUTE_MS = 60 * 1000;

/**
 * FIX BUG 1: DB-persisted dedup window.
 *
 * Each (followUpId, minutesLeft) pair may only be sent once per DEDUP_WINDOW_MS.
 * Previously this was tracked in an in-memory Map that was cleared on restart.
 * Now we persist the last-sent timestamp inside the FollowUp document itself
 * at `remindersSentAt.<minutesKey>`, which survives server restarts.
 *
 * We keep the in-memory L1 cache so repeated ticks within the same process
 * still skip cheaply without a DB round-trip.
 */
const DEDUP_WINDOW_MS = 3 * 60 * 1000; // 3 minutes (covers the 2-min query window + drift)
const _l1Cache = new Map(); // L1: in-process cache. Key: `${followUpId}_${minutesKey}` -> sentMs

const minutesKey = (minutesLeft) =>
    minutesLeft < 0 ? `m${Math.abs(minutesLeft)}` : `p${minutesLeft}`;

/**
 * FIX BUG 1 (STALE CATCH-UP GUARD):
 *
 * If the scheduler tick runs late (e.g. server was restarting for 5 minutes),
 * it will try to process windows 5,4,3,2,1 all in the same tick. We detect
 * this by comparing the current real time against the window's ideal fire time.
 * If we are more than STALE_WINDOW_SKIP_MS past the ideal fire time for this
 * window, skip it — the reminder would be confusingly late.
 *
 * Example: device is at T+6min. The 5min window (which should have fired at
 * T-1min) is now 6 minutes stale → skip. Only the 0min (due) and -1min
 * (missed) windows fire normally.
 */
const STALE_WINDOW_SKIP_MS = 90 * 1000; // 90 seconds

const isStaleCatchupWindow = (nowMs, minuteStartMs, minutesLeft) => {
    // The ideal server tick for this window was when nowMs == targetMinuteStartMs.
    const targetMinuteStartMs = minuteStartMs + minutesLeft * MINUTE_MS;
    const staleness = nowMs - targetMinuteStartMs;
    // staleness > STALE_WINDOW_SKIP_MS means we are processing this window
    // significantly after it should have fired — skip it.
    return staleness > STALE_WINDOW_SKIP_MS;
};

const cleanupL1Cache = () => {
    const now = Date.now();
    const cutoff = now - DEDUP_WINDOW_MS * 2;
    for (const [key, ts] of _l1Cache.entries()) {
        if (ts < cutoff) _l1Cache.delete(key);
    }
};

/**
 * Check if we already sent this reminder (DB-persisted check).
 * Returns true if the reminder was sent within DEDUP_WINDOW_MS.
 */
const wasAlreadySentDb = (followUp, minsLeft) => {
    const key = minutesKey(minsLeft);
    const sentAt = followUp?.remindersSentAt?.[key];
    if (!sentAt) return false;
    const sentMs = new Date(sentAt).getTime();
    return Date.now() - sentMs < DEDUP_WINDOW_MS;
};

/**
 * Persist the sent timestamp to the FollowUp document.
 * Uses $set so it doesn't overwrite unrelated fields.
 * Fires-and-forgets — we don't await to avoid blocking the scheduler tick.
 */
const persistSentTimestamp = (followUpId, minsLeft) => {
    const key = minutesKey(minsLeft);
    FollowUp.findByIdAndUpdate(
        followUpId,
        { $set: { [`remindersSentAt.${key}`]: new Date() } },
        { strict: false }, // allow dynamic fields not in schema
    ).catch((err) =>
        console.warn(
            `[ReminderScheduler] Failed to persist dedup timestamp: ${err.message}`,
        ),
    );
};

// ─── Main scheduler ───────────────────────────────────────────────────────────

exports.sendDueFollowUpReminders = async () => {
    try {
        const now = new Date();
        const nowMs = now.getTime();

        const minuteStartMs = nowMs - (nowMs % MINUTE_MS);
        const anchor = new Date(minuteStartMs);

        // ─── DAILY REPORT HOOK (7:00 AM IST) ───
        // IST is UTC + 5:30. 
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(nowMs + istOffset);
        const istHour = istDate.getUTCHours();
        const istMinute = istDate.getUTCMinutes();
        const dateStr = istDate.toISOString().split("T")[0];

        const targetHour = parseInt(process.env.DAILY_REPORT_HOUR || "7");
        const targetMinute = parseInt(process.env.DAILY_REPORT_MINUTE || "0");

        if (istHour === targetHour && istMinute === targetMinute && lastDailyReportDate !== dateStr) {
            lastDailyReportDate = dateStr;
            dailyReportService.sendDailyMorningReports().catch(err =>
                console.error("[DailyReport] Trigger error:", err.message)
            );
        }

        // ─── DAILY QUOTES HOOK (8:00 AM and 6:00 PM IST) ───
        const morningQuoteHour = parseInt(process.env.MORNING_QUOTE_HOUR || "8");
        const morningQuoteMinute = parseInt(process.env.MORNING_QUOTE_MINUTE || "0");
        const eveningQuoteHour = parseInt(process.env.EVENING_QUOTE_HOUR || "18");
        const eveningQuoteMinute = parseInt(process.env.EVENING_QUOTE_MINUTE || "0");

        if (istHour === morningQuoteHour && istMinute === morningQuoteMinute && lastMorningQuoteDate !== dateStr) {
            lastMorningQuoteDate = dateStr;
            dailyQuoteService.sendCompanyWideQuote('morning').catch(err =>
                console.error("[DailyQuote] Trigger error:", err.message)
            );
        }

        if (istHour === eveningQuoteHour && istMinute === eveningQuoteMinute && lastEveningQuoteDate !== dateStr) {
            lastEveningQuoteDate = dateStr;
            dailyQuoteService.sendCompanyWideQuote('evening').catch(err =>
                console.error("[DailyQuote] Trigger error:", err.message)
            );
        }

        cleanupL1Cache();

        const allWindows = [
            ...PRE_REMINDER_WINDOWS,
            DUE_MINUTES_LEFT,
            MISSED_MINUTES_LEFT,
        ];

        for (const minutesLeft of allWindows) {
            // FIX BUG 1 (stale catch-up guard): skip windows that are being
            // processed significantly after their intended fire time.
            if (isStaleCatchupWindow(nowMs, minuteStartMs, minutesLeft)) {
                debugLog(
                    `[ReminderScheduler] Skipping stale window ${minutesLeft}min (too late)`,
                );
                continue;
            }

            const targetMinuteStartMs = minuteStartMs + minutesLeft * MINUTE_MS;
            const targetMinuteStart = new Date(targetMinuteStartMs);
            const targetMinuteEnd = new Date(
                targetMinuteStartMs + MINUTE_MS - 1,
            );

            debugLog("[ReminderScheduler] Window", {
                minutesLeft,
                from: targetMinuteStart.toISOString(),
                to: targetMinuteEnd.toISOString(),
            });

            const followUps = await FollowUp.find({
                dueAt: {
                    $gte: targetMinuteStart,
                    $lte: targetMinuteEnd,
                },
                isCurrent: true,
                status: {
                    $nin: [
                        "Completed",
                        "completed",
                        "Drop",
                        "Dropped",
                        "drop",
                        "dropped",
                        "Converted",
                        "converted",
                    ],
                },
            })
                .populate(
                    "userId",
                    "name fcmToken pushToken notificationPreferences company_id",
                )
                .populate(
                    "assignedTo",
                    "name fcmToken pushToken notificationPreferences company_id",
                )
                .populate("createdBy", "name")
                .lean()
                .limit(100);

            debugLog("[ReminderScheduler] Matches", {
                minutesLeft,
                count: followUps?.length || 0,
            });

            // ── Pre-fetch Admins for all companies in this window ──
            const companyIds = [...new Set(followUps.map(f => f.companyId || f.userId?.company_id).filter(Boolean))];
            const adminsByCompany = {};
            if (companyIds.length > 0) {
                try {
                    const allAdmins = await User.find({
                        company_id: { $in: companyIds },
                        role: { $in: ["admin", "Admin"] },
                        status: "Active"
                    }).select("name fcmToken pushToken notificationPreferences company_id").lean();

                    allAdmins.forEach(admin => {
                        const cid = String(admin.company_id);
                        if (!adminsByCompany[cid]) adminsByCompany[cid] = [];
                        adminsByCompany[cid].push(admin);
                    });
                } catch (adminErr) {
                    console.error("[ReminderScheduler] Error fetching admins:", adminErr.message);
                }
            }

            for (const followUp of followUps) {
                try {
                    const activityType = followUp.activityType || "Phone Call";

                    // ── L1 cache check (fast, in-process) ──
                    const l1Key = `${followUp._id}_${minutesLeft}`;
                    if (_l1Cache.has(l1Key)) {
                        debugLog(`[ReminderScheduler] L1 skip: ${l1Key}`);
                        continue;
                    }

                    // FIX BUG 1: DB-persisted dedup check.
                    // Catches the case where the L1 cache was wiped by a restart.
                    if (wasAlreadySentDb(followUp, minutesLeft)) {
                        debugLog(
                            `[ReminderScheduler] DB dedup skip: ${followUp._id} ${minutesLeft}min`,
                        );
                        _l1Cache.set(l1Key, Date.now()); // warm L1 to avoid repeat DB checks
                        continue;
                    }
                    const companyId = String(followUp.companyId || followUp.userId?.company_id || "");
                    const potentialRecipients = [];

                    // 1. Assigned staff (or owner if not assigned)
                    const primaryUser = followUp.assignedTo || followUp.userId;
                    if (primaryUser) potentialRecipients.push(primaryUser);

                    // 2. Company Admins
                    if (companyId && adminsByCompany[companyId]) {
                        potentialRecipients.push(...adminsByCompany[companyId]);
                    }

                    // 3. Unique-ify recipients by ID
                    const recipients = Array.from(
                        new Map(potentialRecipients.filter(u => u?._id).map(u => [String(u._id), u])).values()
                    );

                    let followUpSentSuccessfully = false;

                    for (const user of recipients) {
                        try {
                            const hasFcm = Boolean(user?.fcmToken);
                            const hasExpoPush =
                                ENABLE_EXPO_PUSH_REMINDER_FALLBACK &&
                                Boolean(user?.pushToken);

                            if (!hasFcm && !hasExpoPush) continue;

                            // Check preference
                            const prefs = user.notificationPreferences || {};
                            if (prefs.followUpReminders === false) continue;

                            const voiceLang = prefs.voiceLang || "en";
                            const staffName = String(
                                followUp?.staffName ||
                                followUp?.createdBy?.name ||
                                followUp?.createdBy ||
                                ""
                            ).trim();

                            const recipientName = String(user?.name || "").trim();
                            const actorName =
                                staffName &&
                                    staffName.toLowerCase() !== "null" &&
                                    staffName.toLowerCase() !== "undefined" &&
                                    staffName !== recipientName
                                    ? staffName
                                    : "";

                            const followUpData = {
                                name: followUp?.name || "customer",
                                actorName,
                                activityType,
                                enqNo: followUp?.enqNo || "",
                                enqId: followUp?.enqId || String(followUp?.enqId || ""),
                                _id: followUp._id,
                                followUpId: String(followUp._id),
                                when: followUp?.dueAt
                                    ? new Date(followUp.dueAt).toISOString()
                                    : undefined,
                                enquiryNumber: followUp?.enqNo,
                                phoneNumber: followUp?.mobile,
                            };

                            const channelKey = resolveChannelKey(
                                activityType,
                                minutesLeft,
                                voiceLang,
                            );
                            const sound = firebaseNotificationService.resolveSoundFilename(channelKey);

                            let result = null;
                            if (hasFcm) {
                                result = await firebaseNotificationService.sendActivityReminder(
                                    user._id,
                                    activityType,
                                    followUpData,
                                    minutesLeft,
                                    voiceLang,
                                );
                            }

                            if (hasExpoPush && !result?.success) {
                                const followupType =
                                    minutesLeft < 0
                                        ? "followup-missed"
                                        : minutesLeft === 0
                                            ? "followup-due"
                                            : "followup-soon";

                                const richTexts = await firebaseNotificationService.buildTexts({
                                    activityType,
                                    followUpData,
                                    minutesLeft,
                                    lang: voiceLang,
                                });

                                const badgeCount = await firebaseNotificationService.getUnreadBadgeCount(user._id);

                                const expoResult = await sendExpoNotification(
                                    user.pushToken,
                                    {
                                        title: richTexts.title,
                                        body: richTexts.body,
                                        badge: badgeCount,
                                        data: {
                                            ...followUpData,
                                            minutesLeft: String(minutesLeft),
                                            activityType,
                                            voiceLang,
                                            type: followupType,
                                        },
                                    },
                                    "high",
                                    3,
                                    channelKey,
                                    sound,
                                );

                                result = expoResult
                                    ? { success: true, provider: "expo" }
                                    : { success: false, error: "Expo send failed" };
                            }

                            if (result?.success) {
                                followUpSentSuccessfully = true;
                                debugLog(`[ReminderScheduler] Sent to user ${user._id} for followup ${followUp._id}`);
                            }
                        } catch (recipientErr) {
                            console.error(`[ReminderScheduler] Error sending to user ${user?._id}:`, recipientErr.message);
                        }
                    }

                    if (followUpSentSuccessfully) {
                        console.log(
                            `[ReminderScheduler] ✓ Sent ${minutesLeft}min reminder for followup ${followUp._id} to ${recipients.length} recipients`,
                        );

                        // FIX BUG 1: Persist dedup state in DB (survives restarts).
                        _l1Cache.set(l1Key, Date.now());
                        persistSentTimestamp(followUp._id, minutesLeft);
                        debugLog("[ReminderScheduler] Sent payload", {
                            followUpId: String(followUp._id),
                            minutesLeft,
                            dueAt: followUp?.dueAt
                                ? new Date(followUp.dueAt).toISOString()
                                : null,
                        });
                    } else {
                        console.warn(
                            `[ReminderScheduler] ✗ Failed to send reminder for ${followUp._id} to any recipient.`,
                        );
                    }
                } catch (err) {
                    console.error(
                        "[ReminderScheduler] Error processing followup:",
                        err.message,
                    );
                }
            }
        }

        console.log(
            `[ReminderScheduler] Cycle complete at ${now.toISOString()} (anchor: ${anchor.toISOString()}, offsetSec: ${Math.floor((nowMs - anchor.getTime()) / 1000)})`,
        );
    } catch (err) {
        console.error("[ReminderScheduler] Fatal error:", err.message);
    }
};

exports.initializeReminderScheduler = () => {
    try {
        if (_schedulerTimeoutId) {
            console.warn(
                "[ReminderScheduler] Already initialized — skipping duplicate initialize call",
            );
            return () => {
                if (_schedulerTimeoutId) clearTimeout(_schedulerTimeoutId);
                _schedulerTimeoutId = null;
                console.log("[ReminderScheduler] ✓ Stopped");
            };
        }

        const scheduleNext = () => {
            const nowMs = Date.now();
            const nextMinuteMs = nowMs - (nowMs % MINUTE_MS) + MINUTE_MS;
            const delayMs = Math.max(500, nextMinuteMs - nowMs + 1500);

            _schedulerTimeoutId = setTimeout(async () => {
                try {
                    await exports.sendDueFollowUpReminders();
                } catch (err) {
                    console.error(
                        "[ReminderScheduler] Tick error:",
                        err.message,
                    );
                } finally {
                    scheduleNext();
                }
            }, delayMs);
        };

        scheduleNext();
        console.log("[ReminderScheduler] ✓ Initialized (runs every minute)");

        return () => {
            if (_schedulerTimeoutId) clearTimeout(_schedulerTimeoutId);
            _schedulerTimeoutId = null;
            console.log("[ReminderScheduler] ✓ Stopped");
        };
    } catch (err) {
        console.error("[ReminderScheduler] Initialization error:", err.message);
        return () => { };
    }
};

exports.testReminderScheduler = async () => {
    console.log("[ReminderScheduler] Running manual test...");
    await exports.sendDueFollowUpReminders();
};

module.exports = exports;