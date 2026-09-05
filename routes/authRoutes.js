const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Company = require("../models/Company");
const Plan = require("../models/Plan");
const CompanySubscription = require("../models/CompanySubscription");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const {
    sendEmailOTP,
    sendMobileOTP,
    sendSignupTemplateNotifications,
    sendWelcomeEmail,
} = require("../utils/otpService");
const { ensureEnvLoaded } = require("../config/loadEnv");
const firebaseAdmin = require("../config/firebaseAdmin");
const appleSignin = require("apple-signin-auth");
const {
    verifyToken,
    WEB_AUTH_COOKIE_NAME,
    clearUserCache,
} = require("../middleware/auth");
const { requireSuperadmin } = require("../middleware/role.middleware");
const { getSecurityPolicy } = require("../services/settingsService");
const { getClientIp, isIpAllowed } = require("../utils/ipAllowlist");
const {
    generateSecretBase32,
    verifyTotp,
    buildTotpOtpAuthUrl,
} = require("../utils/totp");
const { ensureFixedPlansSynced } = require("../services/planFeatures");
const {
    sendLoginAlertToOtherDevices,
    extractDeviceInfo,
} = require("../services/securityAlertService");

ensureEnvLoaded();

if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
}

const JWT_SECRET = process.env.JWT_SECRET;
const EXPOSE_TEST_OTP =
    String(process.env.EXPOSE_TEST_OTP || "").toLowerCase() === "true" ||
    String(process.env.NODE_ENV || "").toLowerCase() !== "production";

// Temporary In-Memory OTP Store (For production use Redis or DB with TTL)
const otpStore = {};
const authRateLimitStore = new Map();

const AUTH_RATE_LIMITS = {
    sendOtp: {
        windowMs: 5 * 60 * 1000,
        max: 5,
        message: "Too many OTP requests. Please wait a few minutes.",
    },
    verifyOtp: {
        windowMs: 10 * 60 * 1000,
        max: 10,
        message: "Too many OTP verification attempts. Please try again later.",
    },
    resetPassword: {
        windowMs: 15 * 60 * 1000,
        max: 5,
        message: "Too many password reset attempts. Please try again later.",
    },
    login: {
        windowMs: 10 * 60 * 1000,
        max: 100,
        message: "Too many login attempts. Please try again later.",
    },
};

const cleanupRateLimitStore = () => {
    const now = Date.now();
    authRateLimitStore.forEach((entry, key) => {
        if (!entry?.resetAt || entry.resetAt <= now) {
            authRateLimitStore.delete(key);
        }
    });
};

const buildRateLimitKey = (req, suffix) => {
    const ip = getClientIp(req) || req.ip || "unknown";
    return `${suffix}:${ip}`;
};

const authRateLimit = (config, keyResolver) => (req, res, next) => {
    cleanupRateLimitStore();

    const key = keyResolver ? keyResolver(req) : buildRateLimitKey(req, "auth");
    const now = Date.now();
    const current = authRateLimitStore.get(key);

    if (!current || current.resetAt <= now) {
        authRateLimitStore.set(key, {
            count: 1,
            resetAt: now + config.windowMs,
        });
        return next();
    }

    if (current.count >= config.max) {
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((current.resetAt - now) / 1000),
        );
        const retryMinutes = Math.ceil(retryAfterSeconds / 60);
        res.set("Retry-After", String(retryAfterSeconds));
        return res
            .status(429)
            .json({
                success: false,
                message: `Too many login attempts. Please try again in ${retryMinutes} minute${retryMinutes > 1 ? "s" : ""}.`,
            });
    }

    current.count += 1;
    authRateLimitStore.set(key, current);
    return next();
};

const cleanupExpiredOtpStore = () => {
    const now = Date.now();
    Object.keys(otpStore).forEach((key) => {
        if (otpStore[key]?.expiresAt && otpStore[key].expiresAt <= now) {
            delete otpStore[key];
        }
    });
};

const ensureBlankWhatsappConfig = async ({ companyId, ownerUserId }) => {
    if (!companyId || !ownerUserId) return;
    const existing = await WhatsAppConfig.findOne({ companyId })
        .select("_id")
        .lean();
    if (existing?._id) return;

    await WhatsAppConfig.create({
        companyId,
        ownerUserId,
        provider: "NEO",
    });
};

// Validation helper
const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

const validatePassword = (password) => {
    return password && password.length >= 8;
};

const normalizeEmail = (value) =>
    String(value || "")
        .trim()
        .toLowerCase();

const findSuperadminByEmail = async (email) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    return User.findOne({
        email: normalizedEmail,
        role: { $in: ["superadmin", "Superadmin", "SUPERADMIN"] },
    });
};

const findAnyUserByEmail = async (email) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    return User.findOne({ email: normalizedEmail });
};

const isPrimaryCompanyUser = async (user) => {
    if (!user?.company_id) return false;
    const primary = await User.findOne({ company_id: user.company_id })
        .sort({ createdAt: 1, _id: 1 })
        .select("_id")
        .lean();
    return Boolean(primary?._id && String(primary._id) === String(user._id));
};

const normalizeCompanyCode = (value) =>
    String(value || "")
        .trim()
        .toUpperCase();

const findCompanyByCode = async (companyCode) => {
    const normalizedCompanyCode = normalizeCompanyCode(companyCode);
    if (!normalizedCompanyCode) return null;
    return Company.findOne({ code: normalizedCompanyCode }).lean();
};

const getOtpRecordForKeys = (...keys) => {
    for (const rawKey of keys) {
        const key = String(rawKey || "").trim();
        if (key && otpStore[key]) {
            return { key, record: otpStore[key] };
        }
    }
    return { key: "", record: null };
};

// Generate JWT Token
const generateToken = (userId, { expiresIn = "7d", sessionId = "" } = {}) => {
    return jwt.sign({ userId, sessionId }, JWT_SECRET, { expiresIn });
};

const buildSessionId = () => {
    try {
        return randomUUID();
    } catch (_error) {
        return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
};

const forceLogoutPreviousSessions = async (req, userId, nextSessionId) => {
    try {
        const io = req.app?.get("io");
        const uid = String(userId || "").trim();
        const sid = String(nextSessionId || "").trim();
        if (!io || !uid || !sid) return;

        // First, try to get sockets from the user room
        const sockets = await io.in(`user:${uid}`).fetchSockets();
        const disconnectedIds = new Set();

        sockets.forEach((sock) => {
            const socketSessionId = String(sock.data?.sessionId || "").trim();
            if (socketSessionId !== sid) {
                sock.emit("FORCE_LOGOUT", {
                    code: "SESSION_REVOKED",
                    reason: "Logged in on another device",
                });
                sock.disconnect(true);
                disconnectedIds.add(sock.id);
            }
        });

        // Also broadcast to all sockets (to catch any not in room due to race conditions)
        // This ensures old sessions get logged out even if they haven't successfully joined yet
        io.sockets.sockets.forEach((sock) => {
            const socketUserId = String(sock.data?.userId || "").trim();
            const socketSessionId = String(sock.data?.sessionId || "").trim();

            // If it's the same user but different session and not already handled, disconnect it
            if (
                socketUserId === uid &&
                socketSessionId !== sid &&
                !disconnectedIds.has(sock.id)
            ) {
                sock.emit("FORCE_LOGOUT", {
                    code: "SESSION_REVOKED",
                    reason: "Logged in on another device",
                });
                sock.disconnect(true);
            }
        });
    } catch (_error) {
        // ignore socket fanout failures
        console.error("Error in forceLogoutPreviousSessions:", _error?.message);
    }
};

const rotateSessionAndIssueToken = async (req, user, tokenOptions = {}) => {
    const nextSessionId = buildSessionId();
    user.activeSessionId = nextSessionId;
    user.lastLogin = new Date();
    await user.save();
    clearUserCache(user._id);

    const token = generateToken(user._id, {
        ...(tokenOptions || {}),
        sessionId: nextSessionId,
    });

    await forceLogoutPreviousSessions(req, user._id, nextSessionId);
    return token;
};

const ensureDefaultTrialSubscription = async (companyId) => {
    try {
        const { plansByCode } = await ensureFixedPlansSynced();
        const existing = await CompanySubscription.findOne({
            companyId,
            status: { $in: ["Trial", "Active"] },
        })
            .sort({ createdAt: -1 })
            .lean();

        if (existing) return { created: false, reason: "subscription_exists" };

        const trialPlan =
            plansByCode.get("FREE") ||
            (await Plan.findOne({ code: "FREE" }).lean()) ||
            (await Plan.findOne({ isActive: true })
                .sort({ sortOrder: 1, createdAt: 1 })
                .lean());

        const trialDaysRaw = Number(
            trialPlan.trialDays || process.env.DEFAULT_TRIAL_DAYS || 7,
        );
        const trialDays =
            Number.isFinite(trialDaysRaw) && trialDaysRaw > 0
                ? trialDaysRaw
                : 7;

        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + trialDays);

        const subscription = await CompanySubscription.create({
            companyId,
            planId: trialPlan._id,
            status: "Trial",
            startDate,
            endDate,
            trialUsed: true,
            finalPrice: 0,
            notes: "Auto-assigned trial on signup",
        });

        return { created: true, subscriptionId: subscription._id };
    } catch (e) {
        console.warn(
            "[Billing] ensureDefaultTrialSubscription failed:",
            e?.message || e,
        );
        return { created: false, reason: "error" };
    }
};

// [NEW] Firebase Phone Login Endpoint
router.post("/login-phone", async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: "Firebase ID Token is required",
            });
        }

        // Verify the ID token
        const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
        const { phone_number, uid } = decodedToken;

        if (!phone_number) {
            return res.status(400).json({
                success: false,
                message: "Invalid token: No phone number found",
            });
        }

        // Verified Firebase token for phone login (no server-side debug logs)

        // Check if user exists
        let user = await User.findOne({ mobile: phone_number });

        if (user && user.role !== "superadmin" && user.company_id) {
            const companyExists = await Company.exists({ _id: user.company_id });
            if (!companyExists) {
                user = null;
            }
        }

        if (!user) {
            // Create a new user? Or require registration flow?
            // Usually, we create a partial user or just log them in if minimal info needed.
            // Let's create a placeholder user if they don't exist, OR fail if registration required.
            // For now, let's AUTO-REGISTER as per typical smooth onboarding.
            // Create a default company for this mobile user (personal tenant)
            const domain = `mobile_${phone_number}`;
            let company = await Company.findOne({ domain });
            if (!company) {
                company = await Company.create({
                    name: `Personal ${phone_number}`,
                    domain,
                    plan: { type: "Starter", staffLimit: 1 },
                });
            }

            if (company?._id) await ensureDefaultTrialSubscription(company._id);

            user = new User({
                mobile: phone_number,
                name: "Mobile User", // Placeholder
                email: `mobile_${phone_number}@example.com`, // Placeholder unique email
                password: uid, // Hook will hash this
                status: "Active",
                company_id: company._id,
                role: "Admin",
            });
            await user.save();
            await ensureBlankWhatsappConfig({
                companyId: company._id,
                ownerUserId: user._id,
            });
            // Created new user for phone login
        }

        if (user.status === "Inactive") {
            return res
                .status(403)
                .json({ success: false, message: "Account is inactive" });
        }

        // Single-device login: rotate session and invalidate previous device instantly.
        const previousSessionId = user.activeSessionId;
        const token = await rotateSessionAndIssueToken(req, user);

        // Send security alert to old device about new login
        const deviceInfo = extractDeviceInfo(req);
        Promise.resolve(
            sendLoginAlertToOtherDevices(user._id, {
                ...deviceInfo,
                mobileNumber: user.mobile || deviceInfo.mobileNumber,
                previousSessionId,
                currentSessionId: user.activeSessionId,
            }),
        ).catch((alertErr) => {
            console.warn(
                "[Auth] Failed to send login alert:",
                alertErr?.message,
            );
        });

        res.json({
            success: true,
            message: "Login successful via Firebase",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                mobile: user.mobile,
                logo: user.logo || "",
                role: user.role,
                status: user.status,
            },
            token,
        });
    } catch (error) {
        console.error("Firebase Login Error:", error);
        res.status(401).json({
            success: false,
            message: "Invalid or expired token",
        });
    }
});

// [NEW] Google Login Endpoint
router.post("/google-login", async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: "Google ID Token is required",
            });
        }

        // Verify the ID token via Google TokenInfo API
        let decodedToken = null;
        try {
            const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
            if (!response.ok) {
                throw new Error("Failed to verify Google ID token");
            }
            decodedToken = await response.json();
        } catch (err) {
            console.error("Google Token Verification failed:", err);
            return res.status(401).json({
                success: false,
                message: "Invalid or expired Google ID token",
            });
        }
        const { email, name, picture, sub: uid } = decodedToken;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Invalid token: No email found",
            });
        }

        const normalizedEmail = normalizeEmail(email);

        // Check if user exists by googleId or email
        let user = await User.findOne({
            $or: [{ googleId: uid }, { email: normalizedEmail }],
        });

        if (user && user.role !== "superadmin" && user.company_id) {
            const companyExists = await Company.exists({ _id: user.company_id });
            if (!companyExists) {
                user = null;
            }
        }

        if (!user) {
            // AUTO-REGISTER new Google user
            // Create a default company for this user
            const domain = `google_${uid}`;
            let company = await Company.findOne({ domain });
            if (!company) {
                company = await Company.create({
                    name: `${name || "Google"}'s Company`,
                    domain,
                    plan: { type: "Starter", staffLimit: 1 },
                });
            }

            if (company?._id) await ensureDefaultTrialSubscription(company._id);

            user = new User({
                googleId: uid,
                name: name || "Google User",
                email: normalizedEmail,
                password: uid, // Placeholder hashed password
                status: "Active",
                company_id: company._id,
                role: "Admin",
                logo: picture || "",
            });
            await user.save();
            await ensureBlankWhatsappConfig({
                companyId: company._id,
                ownerUserId: user._id,
            });

            // Trigger Notifications for NEW Google Signup
            const adminNumber = process.env.SIGNUP_ADMIN_ALERT_NUMBER;
            const now = new Date();
            const signupDate = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;

            Promise.all([
                // 1. Welcome Email to User
                sendWelcomeEmail(
                    user.email,
                    user.name,
                    company.name,
                    user.mobile || "-"
                ),
                // 2. WhatsApp Alert to Admin
                sendSignupTemplateNotifications({
                    customerName: user.name,
                    companyName: company.name,
                    customerPhoneNumber: user.mobile || "-",
                    email: user.email,
                    adminPhoneNumber: adminNumber,
                })
            ]).catch(err => console.error("[GoogleSignup] Notification error:", err.message));
        } else {
            // Update googleId if not set
            if (!user.googleId) {
                user.googleId = uid;
                if (picture && !user.logo) user.logo = picture;
                await user.save();
            }
        }

        if (user.status === "Inactive") {
            return res
                .status(403)
                .json({ success: false, message: "Account is inactive" });
        }

        const previousSessionId = user.activeSessionId;
        const token = await rotateSessionAndIssueToken(req, user);

        const deviceInfo = extractDeviceInfo(req);
        Promise.resolve(
            sendLoginAlertToOtherDevices(user._id, {
                ...deviceInfo,
                email: user.email,
                previousSessionId,
                currentSessionId: user.activeSessionId,
            }),
        ).catch(() => { });

        res.json({
            success: true,
            message: "Login successful via Google",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                mobile: user.mobile || "",
                logo: user.logo || "",
                role: user.role,
                status: user.status,
            },
            token,
        });
    } catch (error) {
        console.error("Google Login Error:", error);
        res.status(401).json({
            success: false,
            message: "Google authentication failed",
        });
    }
});

// [NEW] Apple Login Endpoint
router.post("/apple-login", async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: "Apple ID Token is required",
            });
        }

        let decodedToken = null;
        try {
            decodedToken = await appleSignin.verifyIdToken(idToken, {
                ignoreExpiration: false,
            });
        } catch (err) {
            console.error("Apple Token Verification failed:", err);
            return res.status(401).json({
                success: false,
                message: "Invalid or expired Apple ID token",
            });
        }

        const { email, sub: uid } = decodedToken;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Invalid token: No email found. Note: Apple only provides the email on the very first sign-in. If missing, user may need to revoke sign-in from Apple ID settings and try again.",
            });
        }

        const normalizedEmail = normalizeEmail(email);

        // Check if user exists by appleId or email
        let user = await User.findOne({
            $or: [{ appleId: uid }, { email: normalizedEmail }],
        });

        if (user && user.role !== "superadmin" && user.company_id) {
            const companyExists = await Company.exists({ _id: user.company_id });
            if (!companyExists) {
                user = null;
            }
        }

        if (!user) {
            const domain = `apple_${uid}`;
            let company = await Company.findOne({ domain });
            if (!company) {
                company = await Company.create({
                    name: `Apple User's Company`,
                    domain,
                    plan: { type: "Starter", staffLimit: 1 },
                });
            }

            if (company?._id) await ensureDefaultTrialSubscription(company._id);

            user = new User({
                appleId: uid,
                name: "Apple User", // Apple doesn't always send name in token, usually in separate object on first signin only
                email: normalizedEmail,
                password: uid, // Placeholder hashed password
                status: "Active",
                company_id: company._id,
                role: "Admin",
            });
            await user.save();
            await ensureBlankWhatsappConfig({
                companyId: company._id,
                ownerUserId: user._id,
            });

            // Trigger Notifications for NEW Apple Signup
            const adminNumber = process.env.SIGNUP_ADMIN_ALERT_NUMBER;
            const now = new Date();
            const signupDate = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;

            Promise.all([
                sendWelcomeEmail(
                    user.email,
                    user.name,
                    company.name,
                    user.mobile || "-"
                ),
                sendSignupTemplateNotifications({
                    customerName: user.name,
                    companyName: company.name,
                    customerPhoneNumber: user.mobile || "-",
                    email: user.email,
                    adminPhoneNumber: adminNumber,
                })
            ]).catch(err => console.error("[AppleSignup] Notification error:", err.message));
        } else {
            if (!user.appleId) {
                user.appleId = uid;
                await user.save();
            }
        }

        if (user.status === "Inactive") {
            return res
                .status(403)
                .json({ success: false, message: "Account is inactive" });
        }

        const previousSessionId = user.activeSessionId;
        const token = await rotateSessionAndIssueToken(req, user);

        const deviceInfo = extractDeviceInfo(req);
        Promise.resolve(
            sendLoginAlertToOtherDevices(user._id, {
                ...deviceInfo,
                email: user.email,
                previousSessionId,
                currentSessionId: user.activeSessionId,
            }),
        ).catch(() => { });

        res.json({
            success: true,
            message: "Login successful via Apple",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                mobile: user.mobile || "",
                logo: user.logo || "",
                role: user.role,
                status: user.status,
            },
            token,
        });
    } catch (error) {
        console.error("Apple Login Error:", error);
        res.status(401).json({
            success: false,
            message: "Apple authentication failed",
        });
    }
});


// [NEW] Send OTP Endpoint
router.post(
    "/send-otp",
    authRateLimit(AUTH_RATE_LIMITS.sendOtp, (req) =>
        buildRateLimitKey(req, "send-otp"),
    ),
    async (req, res) => {
        try {
            cleanupExpiredOtpStore();
            const { email, mobile, type, method } = req.body; // method: 'email', 'sms', 'whatsapp'
            // Received /send-otp request

            if (!email && !mobile) {
                return res.status(400).json({
                    success: false,
                    message: "Email or Mobile is required",
                });
            }

            const lookupEmail = normalizeEmail(email);
            const recordKey = email || mobile; // Use whichever is provided as key

            // Behavior depends on `type` of OTP request
            let existingUser = null;
            if (type === "forgot_password" || type === "edit_whatsapp_token") {
                // For password reset or token edit, the account must exist (global lookup)
                existingUser = await User.findOne({
                    $or: [{ email: lookupEmail }, { mobile: mobile }],
                });
                if (!existingUser) {
                    return res
                        .status(404)
                        .json({ success: false, message: "User not found" });
                }
            } else if (type === "signup") {
                // Main company signup email must stay globally unique.
                if (lookupEmail) {
                    existingUser = await findAnyUserByEmail(lookupEmail);
                    if (existingUser) {
                        return res.status(409).json({
                            success: false,
                            message:
                                "This email is already used by another company account",
                        });
                    }
                }
            } else {
                // Generic send-otp for login or other flows: prefer sending to existing account if present (global lookup)
                existingUser = await User.findOne({
                    $or: [{ email: lookupEmail }, { mobile: mobile }],
                });
            }

            // Generate 6-digit OTP
            const otp = Math.floor(100000 + Math.random() * 900000).toString();

            const mobileToSend = mobile || existingUser?.mobile;
            const emailToSend = email || existingUser?.email;

            const record = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };
            // Store against both keys when available (so verify can use email OR mobile)
            if (emailToSend) otpStore[emailToSend] = record;
            if (mobileToSend) otpStore[mobileToSend] = record;
            otpStore[recordKey] = record;

            // OTP generated and dispatched (not echoed to client in production)
            if (EXPOSE_TEST_OTP) {
                console.log("[OTP][TEST]", {
                    type: type || "generic",
                    email: emailToSend || null,
                    mobile: mobileToSend || null,
                    otp,
                });
            }

            const requested = String(method || "")
                .toLowerCase()
                .trim(); // "", "email", "sms", "whatsapp"
            let sent = false;
            const sentVia = [];

            const trySendEmail = async () => {
                if (!emailToSend) return false;
                const ok = await sendEmailOTP(emailToSend, otp);
                if (ok) sentVia.push("email");
                return ok;
            };

            const trySendMobile = async (mobileMethod) => {
                if (!mobileToSend) return false;
                const ok = await sendMobileOTP(mobileToSend, otp, {
                    ownerUserId: existingUser?._id || null,
                    method: mobileMethod,
                });
                if (ok)
                    sentVia.push(
                        mobileMethod === "whatsapp" ? "whatsapp" : "sms",
                    );
                return ok;
            };

            const isSignupFlow =
                String(type || "")
                    .toLowerCase()
                    .trim() === "signup";

            // Asynchronously dispatch OTP notifications without blocking HTTP response
            if (emailToSend) {
                sendEmailOTP(emailToSend, otp).catch((err) =>
                    console.error("[OTP][Email] Background send error:", err.message)
                );
            }
            if (mobileToSend) {
                sendMobileOTP(mobileToSend, otp, {
                    ownerUserId: existingUser?._id || null,
                    method: requested === "sms" ? "sms" : "whatsapp",
                }).catch((err) =>
                    console.error("[OTP][Mobile] Background send error:", err.message)
                );
            }

            const response = {
                success: true,
                message: "OTP sent successfully. Please check your email and WhatsApp.",
            };

            if (EXPOSE_TEST_OTP || process.env.NODE_ENV !== "production" || isSignupFlow) {
                response.testOtp = otp;
            }

            return res.json(response);
        } catch (err) {
            console.error("Send OTP Error:", err);
            res.status(500).json({
                success: false,
                message: "Failed to send OTP",
            });
        }
    },
);

// [NEW] Verify OTP Endpoint
router.post(
    "/verify-otp",
    authRateLimit(AUTH_RATE_LIMITS.verifyOtp, (req) =>
        buildRateLimitKey(req, "verify-otp"),
    ),
    async (req, res) => {
        try {
            cleanupExpiredOtpStore();
            const { email, mobile, otp } = req.body;
            const { key, record } = getOtpRecordForKeys(email, mobile);

            if ((!email && !mobile) || !otp) {
                return res.status(400).json({
                    success: false,
                    message: "Email/Mobile and OTP are required",
                });
            }

            if (!record) {
                return res.status(400).json({
                    success: false,
                    message: "OTP not found or expired. Please resend.",
                });
            }

            if (Date.now() > record.expiresAt) {
                delete otpStore[key];
                return res.status(400).json({
                    success: false,
                    message: "OTP expired. Please resend.",
                });
            }

            if (record.otp !== otp) {
                return res
                    .status(400)
                    .json({ success: false, message: "Invalid OTP" });
            }

            // OPTIONAL: Delete OTP after successful verification
            // delete otpStore[key];

            res.json({ success: true, message: "OTP verified successfully" });
        } catch (err) {
            console.error("Verify OTP Error:", err);
            res.status(500).json({
                success: false,
                message: "Failed to verify OTP",
            });
        }
    },
);

// [NEW] Reset Password Endpoint
router.post(
    "/reset-password",
    authRateLimit(AUTH_RATE_LIMITS.resetPassword, (req) =>
        buildRateLimitKey(req, "reset-password"),
    ),
    async (req, res) => {
        try {
            cleanupExpiredOtpStore();
            const { email, mobile, password, otp } = req.body;
            const policy = await getSecurityPolicy();
            const minLen = Number(policy?.passwordMinLength ?? 8);
            const requiredLen =
                Number.isFinite(minLen) && minLen >= 8 ? minLen : 8;
            const identifier = String(email || mobile || "").trim();

            if (!identifier || !password || !otp) {
                return res.status(400).json({
                    success: false,
                    message: "All fields are required",
                });
            }

            if (String(password || "").length < requiredLen) {
                return res.status(400).json({
                    success: false,
                    message: `Password must be at least ${requiredLen} characters`,
                });
            }

            // Verify OTP again to ensure security
            const record = otpStore[identifier];
            if (!record) {
                return res.status(400).json({
                    success: false,
                    message: "OTP session expired. Please resend OTP.",
                });
            }
            if (record.otp !== otp) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid OTP verifying reset",
                });
            }

            const user = await User.findOne({
                $or: [{ email: identifier }, { mobile: identifier }],
            });
            if (!user) {
                return res
                    .status(404)
                    .json({ success: false, message: "User not found" });
            }

            // Update Password
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(password, salt);
            await user.save();

            // Clear OTP
            delete otpStore[identifier];

            res.json({ success: true, message: "Password reset successfully" });
        } catch (err) {
            console.error("Reset Password Error:", err);
            res.status(500).json({
                success: false,
                message: "Failed to reset password",
            });
        }
    },
);

// [NEW] Check User Existence (No OTP)
router.post("/check-user", async (req, res) => {
    try {
        const { email, mobile } = req.body;

        if (email) {
            const normalizedEmail = normalizeEmail(email);
            const userEmail = await findAnyUserByEmail(normalizedEmail);
            if (userEmail)
                return res.status(409).json({
                    success: false,
                    message:
                        "This email is already used by another company account",
                });
        }

        if (mobile) {
            const userMobile = await User.findOne({ mobile });
            if (userMobile)
                return res.status(409).json({
                    success: false,
                    message: "Mobile number already registered",
                });
        }

        res.json({ success: true, message: "User available" });
    } catch (err) {
        console.error("Check User Error:", err);
        res.status(500).json({
            success: false,
            message: "Server error checking user",
        });
    }
});

// Register / Signup (Updated to remove OTP check if handled elsewhere, or keep it standard)
router.post("/signup", async (req, res) => {
    try {
        const {
            name,
            email,
            password,
            confirmPassword,
            mobile,
            otp,
            firebaseIdToken,
            privacyPolicyAccepted,
            privacyPolicyUrl,
        } = req.body;
        const normalizedEmail = normalizeEmail(email);
        const policy = await getSecurityPolicy();
        const minLen = Number(policy?.passwordMinLength ?? 8);
        const requiredLen = Number.isFinite(minLen) && minLen >= 8 ? minLen : 8;

        // Validation
        if (!name || !email || !password || !confirmPassword) {
            return res
                .status(400)
                .json({ success: false, message: "All fields are required" });
        }

        if (privacyPolicyAccepted !== true) {
            return res.status(400).json({
                success: false,
                message:
                    "You must accept the Privacy Policy to create an account",
            });
        }

        if (!validateEmail(normalizedEmail)) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid email format" });
        }

        if (String(password || "").length < requiredLen) {
            return res.status(400).json({
                success: false,
                message: `Password must be at least ${requiredLen} characters`,
            });
        }

        if (password !== confirmPassword) {
            return res
                .status(400)
                .json({ success: false, message: "Passwords do not match" });
        }

        const normalizedSignupMobile = String(mobile || "").replace(
            /[^\d]/g,
            "",
        );
        if (!normalizedSignupMobile) {
            return res.status(400).json({
                success: false,
                message: "Mobile number is required",
            });
        }

        if (!otp && !firebaseIdToken) {
            return res.status(400).json({
                success: false,
                message: "OTP verification is required",
            });
        }

        if (otp) {
            const { key: otpKey, record: otpRecord } = getOtpRecordForKeys(
                normalizedEmail,
                mobile,
            );

            if (!otpRecord) {
                return res.status(400).json({
                    success: false,
                    message: "OTP not found or expired. Please resend.",
                });
            }

            if (Date.now() > otpRecord.expiresAt) {
                delete otpStore[otpKey];
                if (normalizedEmail) delete otpStore[normalizedEmail];
                if (mobile) delete otpStore[mobile];
                return res.status(400).json({
                    success: false,
                    message: "OTP expired. Please resend.",
                });
            }

            if (String(otpRecord.otp) !== String(otp).trim()) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid OTP",
                });
            }
        } else {
            let decodedPhoneToken;
            try {
                decodedPhoneToken = await firebaseAdmin
                    .auth()
                    .verifyIdToken(firebaseIdToken);
            } catch (_error) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid or expired phone verification",
                });
            }

            const verifiedPhone = String(
                decodedPhoneToken?.phone_number || "",
            ).trim();
            if (!verifiedPhone) {
                return res.status(400).json({
                    success: false,
                    message: "Verified phone number not found",
                });
            }

            const normalizedVerifiedPhone = verifiedPhone.replace(/[^\d]/g, "");
            if (
                !normalizedVerifiedPhone ||
                !normalizedVerifiedPhone.endsWith(
                    normalizedSignupMobile.slice(-10),
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Phone verification does not match the signup mobile number",
                });
            }
        }

        // Check if user already exists
        let user = await findAnyUserByEmail(normalizedEmail);
        if (user) {
            return res.status(409).json({
                success: false,
                message:
                    "This email is already used by another company account",
            });
        }

        // Create a new Company for every new Admin signup to ensure strict isolation.
        // Using a unique domain value to avoid grouping by email domain.
        const uniqueDomain = `company-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let company;
        const baseCompanyName = name || uniqueDomain;
        // First attempt: normal Mongoose create with logging on failure
        try {
            company = await Company.create({
                name: baseCompanyName,
                domain: uniqueDomain,
                plan: { type: "Starter", staffLimit: 1 },
            });
        } catch (err) {
            console.error(
                "Company.create failed (initial):",
                err && err.message ? err.message : err,
            );
            // If creation failed unexpectedly, fallback to a lookup by generated domain
            try {
                company = await Company.findOne({ domain: uniqueDomain });
            } catch (e) {
                console.error(
                    "Company.findOne failed after create error:",
                    e && e.message ? e.message : e,
                );
            }
        }

        // If company still not created/found, attempt a few more times with different suffixes
        if (!company) {
            for (let i = 0; i < 3 && !company; i++) {
                const altDomain = `${uniqueDomain}-${i}`;
                const altName =
                    i === 0 ? baseCompanyName : `${baseCompanyName} ${i}`;
                try {
                    company = await Company.create({
                        name: altName,
                        domain: altDomain,
                        plan: { type: "Starter", staffLimit: 1 },
                    });
                    break;
                } catch (e) {
                    console.error(
                        `Company.create failed (attempt ${i}) for domain ${altDomain}:`,
                        e && e.message ? e.message : e,
                    );
                    try {
                        company = await Company.findOne({ domain: altDomain });
                        if (company) break;
                    } catch (e2) {
                        console.error(
                            `Company.findOne failed (attempt ${i}) for domain ${altDomain}:`,
                            e2 && e2.message ? e2.message : e2,
                        );
                    }
                }
            }
        }

        // Last-resort: try inserting directly into the collection to bypass Mongoose hooks (avoiding silent failures)
        if (!company) {
            try {
                const insertDoc = {
                    name: baseCompanyName,
                    domain: uniqueDomain,
                    plan: { type: "Starter", staffLimit: 1 },
                    status: "Active",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
                const result = await Company.collection.insertOne(insertDoc);
                if (result && result.insertedId) {
                    company = await Company.findById(result.insertedId);
                    console.warn(
                        "Company inserted via raw collection.insertOne as fallback",
                        result.insertedId,
                    );
                }
            } catch (rawErr) {
                console.error(
                    "Raw collection.insertOne failed (fallback):",
                    rawErr && rawErr.message ? rawErr.message : rawErr,
                );
            }
        }

        if (!company) {
            console.error(
                "Failed to create or find company after multiple attempts for domain",
                uniqueDomain,
            );
            return res.status(500).json({
                success: false,
                message: "Failed to create company for this account",
            });
        }

        // Create new user tied to the company
        user = new User({
            name,
            email: normalizedEmail,
            password,
            mobile,
            privacyPolicyAccepted: true,
            privacyPolicyAcceptedAt: new Date(),
            privacyPolicyUrl: String(privacyPolicyUrl || "").trim(),
            role: "Admin",
            company_id: company ? company._id : undefined,
        });
        await user.save();
        await ensureBlankWhatsappConfig({
            companyId: company?._id || null,
            ownerUserId: user._id,
        });

        if (company?._id) await ensureDefaultTrialSubscription(company._id);

        // Single-device login: rotate session and invalidate previous device instantly.
        const token = await rotateSessionAndIssueToken(req, user);

        if (normalizedEmail) delete otpStore[normalizedEmail];
        if (mobile) delete otpStore[mobile];

        Promise.resolve(
            sendSignupTemplateNotifications({
                customerPhoneNumber: mobile,
                customerName: name,
                companyName: company?.name || name,
                companyCode: company?.code || "",
                email: normalizedEmail,
            }),
        ).catch((templateErr) => {
            console.error(
                "Signup template notification failed:",
                templateErr?.message || templateErr,
            );
        });

        res.status(201).json({
            success: true,
            message: "Account created successfully",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                mobile: user.mobile,
                logo: user.logo || "",
                role: user.role,
                company_id: user.company_id,
                companyCode: company?.code || "",
                companyName: company?.name || "",
            },
            company: company
                ? {
                    id: company._id,
                    code: company.code || "",
                    name: company.name || "",
                }
                : null,
            token,
        });
    } catch (err) {
        console.error("Signup error:", err);

        // Check for MongoDB connection timeout
        if (
            err.name === "MongoTimeoutError" ||
            err.message.includes("timed out")
        ) {
            return res.status(503).json({
                success: false,
                message: "Database connection timeout. Please try again later.",
            });
        }

        res.status(500).json({
            success: false,
            message: "Server error: " + err.message,
        });
    }
});

// Superadmin login (email + password only)
router.post(
    "/superadmin/login",
    authRateLimit(AUTH_RATE_LIMITS.login, (req) =>
        buildRateLimitKey(req, "superadmin-login"),
    ),
    async (req, res) => {
        try {
            const { email, password, otp } = req.body;
            const policy = await getSecurityPolicy();
            const ip = getClientIp(req);

            if (
                policy?.restrictSuperadminLoginsByIp &&
                String(policy?.superadminIpAllowlist || "").trim()
            ) {
                if (!isIpAllowed(ip, policy.superadminIpAllowlist)) {
                    return res.status(403).json({
                        success: false,
                        code: "IP_NOT_ALLOWED",
                        message: "Login is restricted by IP allowlist",
                    });
                }
            }

            if (!email || !password) {
                return res.status(400).json({
                    success: false,
                    message: "Email and password are required",
                });
            }

            if (!validateEmail(email)) {
                return res
                    .status(400)
                    .json({ success: false, message: "Invalid email format" });
            }

            const user = await User.findOne({ email }).maxTimeMS(5000);
            if (!user) {
                return res
                    .status(404)
                    .json({ success: false, message: "Account not found" });
            }

            if ((user.role || "").toLowerCase() !== "superadmin") {
                return res.status(403).json({
                    success: false,
                    message: "Not a superadmin account",
                });
            }

            if (user.status === "Inactive") {
                return res
                    .status(403)
                    .json({ success: false, message: "Account is inactive" });
            }

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid email or password",
                });
            }

            const rotationDays = Number(policy?.passwordRotationDays ?? 90);
            let passwordExpired = false;
            if (Number.isFinite(rotationDays) && rotationDays > 0) {
                const changedAt =
                    user.passwordChangedAt || user.updatedAt || user.createdAt;
                if (changedAt) {
                    const ageMs = Date.now() - new Date(changedAt).getTime();
                    const maxMs = rotationDays * 24 * 60 * 60 * 1000;
                    if (Number.isFinite(ageMs) && ageMs > maxMs) {
                        passwordExpired = true;
                    }
                }
            }

            if (policy?.enforceSuperadmin2fa && !user.twoFactorEnabled) {
                return res.status(403).json({
                    success: false,
                    code: "TWOFA_SETUP_REQUIRED",
                    message:
                        "2FA is required for superadmin accounts. Enable 2FA to login.",
                });
            }

            if (user.twoFactorEnabled) {
                const secret = String(user.twoFactorSecret || "");
                const token = String(otp || "").trim();
                if (!secret) {
                    // Data inconsistency: enabled flag set but secret missing.
                    await User.findByIdAndUpdate(user._id, {
                        $set: { twoFactorEnabled: false },
                    });
                    return res.status(403).json({
                        success: false,
                        code: "TWOFA_RESET_REQUIRED",
                        message:
                            "2FA secret missing. Please setup 2FA again to login.",
                    });
                }
                if (!token) {
                    return res.status(400).json({
                        success: false,
                        code: "OTP_REQUIRED",
                        message: "2FA OTP is required",
                    });
                }
                if (!verifyTotp({ secretBase32: secret, token })) {
                    return res.status(401).json({
                        success: false,
                        code: "OTP_INVALID",
                        message: "Invalid 2FA OTP",
                    });
                }
            }

            const timeoutMinutes = Number(
                policy?.superadminSessionTimeoutMinutes ?? 30,
            );
            const minutes =
                Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
                    ? timeoutMinutes
                    : 30;
            const previousSessionId = user.activeSessionId;
            const token = await rotateSessionAndIssueToken(req, user, {
                expiresIn: `${minutes}m`,
            });
            setWebAuthCookie(req, res, token, minutes * 60 * 1000);

            // Send security alert to old device about new login (superadmin)
            const deviceInfo = extractDeviceInfo(req);
            Promise.resolve(
                sendLoginAlertToOtherDevices(user._id, {
                    ...deviceInfo,
                    mobileNumber: user.mobile || deviceInfo.mobileNumber,
                    previousSessionId,
                    currentSessionId: user.activeSessionId,
                }),
            ).catch((alertErr) => {
                console.warn(
                    "[Auth] Failed to send superadmin login alert:",
                    alertErr?.message,
                );
            });

            return res.json({
                success: true,
                message: passwordExpired
                    ? "Superadmin login successful (password expired)"
                    : "Superadmin login successful",
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    status: user.status,
                    passwordExpired,
                },
                token,
                sessionTimeoutMinutes: minutes,
            });
        } catch (err) {
            console.error("Superadmin login error:", err);
            return res.status(500).json({
                success: false,
                message: "Server error: " + err.message,
            });
        }
    },
);

router.get(
    "/superadmin/2fa/status",
    verifyToken,
    requireSuperadmin,
    async (req, res) => {
        try {
            const user = await User.findById(req.userId)
                .select("twoFactorEnabled twoFactorSecret")
                .lean();
            if (user?.twoFactorEnabled && !user?.twoFactorSecret) {
                // Self-heal inconsistent state so UI doesn't show "Enabled" without a usable secret.
                await User.findByIdAndUpdate(req.userId, {
                    $set: { twoFactorEnabled: false },
                });
                return res.json({
                    success: true,
                    twoFactorEnabled: false,
                    hasSecret: false,
                    repaired: true,
                });
            }
            return res.json({
                success: true,
                twoFactorEnabled: Boolean(user?.twoFactorEnabled),
                hasSecret: Boolean(user?.twoFactorSecret),
            });
        } catch (err) {
            return res
                .status(500)
                .json({ success: false, message: "Failed to read 2FA status" });
        }
    },
);

router.post(
    "/superadmin/2fa/setup",
    verifyToken,
    requireSuperadmin,
    async (req, res) => {
        try {
            const user = await User.findById(req.userId)
                .select("email twoFactorEnabled")
                .lean();
            if (!user)
                return res
                    .status(404)
                    .json({ success: false, message: "User not found" });

            const secretBase32 = generateSecretBase32(20);
            const label = user.email || "superadmin";
            const otpauthUrl = buildTotpOtpAuthUrl({
                issuer: "NeoApp",
                label,
                secretBase32,
            });

            await User.findByIdAndUpdate(req.userId, {
                $set: {
                    twoFactorSecret: secretBase32,
                    twoFactorEnabled: false,
                },
            });

            return res.json({
                success: true,
                message: "2FA secret generated. Verify OTP to enable.",
                secretBase32,
                otpauthUrl,
            });
        } catch (err) {
            return res
                .status(500)
                .json({ success: false, message: "Failed to setup 2FA" });
        }
    },
);

router.post(
    "/superadmin/2fa/enable",
    verifyToken,
    requireSuperadmin,
    async (req, res) => {
        try {
            const { otp } = req.body || {};
            const user = await User.findById(req.userId)
                .select("twoFactorSecret twoFactorEnabled")
                .lean();
            if (!user)
                return res
                    .status(404)
                    .json({ success: false, message: "User not found" });
            if (!user.twoFactorSecret) {
                return res.status(400).json({
                    success: false,
                    message: "2FA not setup. Generate a secret first.",
                });
            }

            if (
                !verifyTotp({ secretBase32: user.twoFactorSecret, token: otp })
            ) {
                return res
                    .status(400)
                    .json({ success: false, message: "Invalid OTP" });
            }

            await User.findByIdAndUpdate(req.userId, {
                $set: { twoFactorEnabled: true },
            });
            return res.json({ success: true, twoFactorEnabled: true });
        } catch (err) {
            return res
                .status(500)
                .json({ success: false, message: "Failed to enable 2FA" });
        }
    },
);

router.post(
    "/superadmin/2fa/disable",
    verifyToken,
    requireSuperadmin,
    async (req, res) => {
        try {
            const { otp } = req.body || {};
            const user = await User.findById(req.userId)
                .select("twoFactorSecret twoFactorEnabled")
                .lean();
            if (!user)
                return res
                    .status(404)
                    .json({ success: false, message: "User not found" });
            if (!user.twoFactorEnabled)
                return res.json({ success: true, twoFactorEnabled: false });

            if (
                !user.twoFactorSecret ||
                !verifyTotp({ secretBase32: user.twoFactorSecret, token: otp })
            ) {
                return res
                    .status(400)
                    .json({ success: false, message: "Invalid OTP" });
            }

            await User.findByIdAndUpdate(req.userId, {
                $set: { twoFactorEnabled: false },
                $unset: { twoFactorSecret: "" },
            });
            return res.json({ success: true, twoFactorEnabled: false });
        } catch (err) {
            return res
                .status(500)
                .json({ success: false, message: "Failed to disable 2FA" });
        }
    },
);
// Login
router.post(
    "/login",
    authRateLimit(AUTH_RATE_LIMITS.login, (req) =>
        buildRateLimitKey(req, "login"),
    ),
    async (req, res) => {
        try {
            cleanupExpiredOtpStore();
            const { email, password } = req.body;
            const normalizedEmail = normalizeEmail(email);

            // Validation
            if (!email || !password) {
                return res.status(400).json({
                    success: false,
                    message: "Email and password are required",
                });
            }

            if (!validateEmail(normalizedEmail)) {
                return res
                    .status(400)
                    .json({ success: false, message: "Invalid email format" });
            }

            let user = null;
            let company = null;

            const superadmin = await findSuperadminByEmail(normalizedEmail);
            if (superadmin) {
                user = superadmin;
            } else {
                const matches = await User.find({
                    email: normalizedEmail,
                    role: { $nin: ["superadmin", "Superadmin", "SUPERADMIN"] },
                }).maxTimeMS(5000);

                if (matches.length === 1) {
                    user = matches[0];
                    if (matches[0]?.company_id) {
                        company = await Company.findById(
                            matches[0].company_id,
                        ).lean();
                    }
                } else if (matches.length > 1) {
                    const passwordMatches = [];

                    for (const candidate of matches) {
                        const isCandidateMatch = await bcrypt.compare(
                            password,
                            candidate.password,
                        );
                        if (isCandidateMatch) {
                            passwordMatches.push(candidate);
                        }
                    }

                    if (passwordMatches.length > 1) {
                        const primaryMatches = [];
                        for (const candidate of passwordMatches) {
                            if (await isPrimaryCompanyUser(candidate)) {
                                primaryMatches.push(candidate);
                            }
                        }

                        if (primaryMatches.length === 1) {
                            user = primaryMatches[0];
                            if (user?.company_id) {
                                company = await Company.findById(
                                    user.company_id,
                                ).lean();
                            }
                        } else {
                            return res.status(409).json({
                                success: false,
                                code: "AMBIGUOUS_COMPANY_LOGIN",
                                message:
                                    "This email and password match multiple company accounts. Please keep a different password in each company.",
                            });
                        }
                    }

                    if (!user && passwordMatches.length === 1) {
                        user = passwordMatches[0];
                        if (user?.company_id) {
                            company = await Company.findById(
                                user.company_id,
                            ).lean();
                        }
                    }

                    if (passwordMatches.length > 1 && user) {
                        // resolved by company primary account preference
                    } else if (!user && passwordMatches.length > 1) {
                        return res.status(409).json({
                            success: false,
                            code: "AMBIGUOUS_COMPANY_LOGIN",
                            message:
                                "This email and password match multiple company accounts. Please keep a different password in each company.",
                        });
                    }
                }
            }

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: "Account not found. Please sign up.",
                });
            }

            // Check if user's company exists if they are not superadmin
            if (user.role !== "superadmin" && user.company_id && !company) {
                return res.status(404).json({
                    success: false,
                    message: "Account not found. Please sign up.",
                });
            }

            // Check if user status is Active
            if (user.status === "Inactive") {
                return res.status(403).json({
                    success: false,
                    message:
                        "Your account is inactive. Contact your administrator.",
                });
            }

            // Compare password
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid email or password",
                });
            }

            // Single-device login: rotate session and invalidate previous device instantly.
            const previousSessionId = user.activeSessionId;
            const token = await rotateSessionAndIssueToken(req, user);

            // Send security alert to old device about new login
            const deviceInfo = extractDeviceInfo(req);
            Promise.resolve(
                sendLoginAlertToOtherDevices(user._id, {
                    ...deviceInfo,
                    mobileNumber: user.mobile || deviceInfo.mobileNumber,
                    previousSessionId,
                    currentSessionId: user.activeSessionId,
                }),
            ).catch((alertErr) => {
                console.warn(
                    "[Auth] Failed to send login alert:",
                    alertErr?.message,
                );
            });

            res.json({
                success: true,
                message: "Login successful",
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    mobile: user.mobile,
                    logo: user.logo || "",
                    role: user.role,
                    status: user.status,
                    company_id: user.company_id,
                    companyCode: company?.code || "",
                    companyName: company?.name || "",
                },
                token,
            });
        } catch (err) {
            console.error("Login error:", err);

            // Check for MongoDB connection timeout
            if (
                err.name === "MongoTimeoutError" ||
                err.message.includes("timed out")
            ) {
                return res.status(503).json({
                    success: false,
                    message:
                        "Database connection timeout. Please try again later.",
                });
            }

            res.status(500).json({
                success: false,
                message: "Server error: " + err.message,
            });
        }
    },
);

// Verify Token (Optional - for protected routes)
router.get("/verify", (req, res) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
            return res
                .status(401)
                .json({ success: false, message: "No token provided" });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({
            success: true,
            message: "Token is valid",
            userId: decoded.userId,
        });
    } catch (err) {
        res.status(401).json({
            success: false,
            message: "Invalid or expired token",
        });
    }
});

// verifyToken middleware removed and moved to shared middleware file

// Get current user profile
router.get("/profile", verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId).select("-password").lean();
        if (!user) {
            return res
                .status(404)
                .json({ success: false, message: "User not found" });
        }

        res.json({
            success: true,
            message: "Profile retrieved successfully",
            user,
        });
    } catch (err) {
        console.error("Profile error:", err);
        res.status(500).json({
            success: false,
            message: "Server error: " + err.message,
        });
    }
});

// Logout
router.post("/logout", verifyToken, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.userId, {
            $set: { activeSessionId: "" },
            // ✅ Requirement: no notifications while logged out
            $unset: {
                fcmToken: 1,
                fcmTokenUpdatedAt: 1,
                fcmSessionId: 1,
                fcmSessionUpdatedAt: 1,
                pushToken: 1,
                lastTokenUpdate: 1,
            },
        }).catch(() => { });
        clearUserCache(req.userId);

        const io = req.app?.get("io");
        if (io) {
            io.to(`user:${String(req.userId || "")}`).emit("FORCE_LOGOUT", {
                code: "SESSION_REVOKED",
                reason: "Logged out",
            });
        }

        clearWebAuthCookie(req, res);
        res.json({
            success: true,
            message: "Logout successful",
        });
    } catch (err) {
        console.error("Logout error:", err);
        res.status(500).json({
            success: false,
            message: "Server error: " + err.message,
        });
    }
});

// Register push token for closed-app notifications
// Endpoint: POST /api/auth/register-fcm-token
// Client sends this after getting FCM token from Firebase
router.post("/register-fcm-token", verifyToken, async (req, res) => {
    try {
        const { fcmToken, sessionId } = req.body;
        const userId = req.user?._id || req.user?.id;

        if (!fcmToken) {
            return res.status(400).json({ error: "FCM token required" });
        }

        // Validate FCM token format (basic validation)
        if (typeof fcmToken !== "string" || fcmToken.length < 10) {
            return res.status(400).json({
                error: "Invalid FCM token format",
            });
        }

        const sessionIdValue = String(sessionId || "").trim();
        if (
            sessionIdValue &&
            (sessionIdValue.length < 6 || sessionIdValue.length > 200)
        ) {
            return res.status(400).json({
                error: "Invalid sessionId format",
            });
        }

        // Update user with FCM token
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            {
                fcmToken,
                fcmTokenUpdatedAt: new Date(),
                ...(sessionIdValue
                    ? {
                        fcmSessionId: sessionIdValue,
                        fcmSessionUpdatedAt: new Date(),
                    }
                    : {}),
            },
            { returnDocument: "after" },
        );

        if (!updatedUser) {
            return res.status(404).json({ error: "User not found" });
        }

        // FIX #27: Log environment in FCM token registration
        const nodeEnv = String(
            process.env.NODE_ENV || "development",
        ).toLowerCase();
        console.log(
            `[Auth] FCM token registered for user ${userId} (env=${nodeEnv}): ${fcmToken.substring(
                0,
                30,
            )}...`,
        );

        res.json({
            success: true,
            message: "FCM token registered for push notifications",
        });
    } catch (error) {
        console.error("[FCM] Error registering FCM token:", error?.message);
        res.status(500).json({ error: "Failed to register FCM token" });
    }
});

// Unregister notification tokens (FCM + Expo)
// Endpoint: POST /api/auth/unregister-notification-tokens
router.post(
    "/unregister-notification-tokens",
    verifyToken,
    async (req, res) => {
        try {
            const userId = req.user?._id || req.user?.id || req.userId;
            await User.findByIdAndUpdate(userId, {
                $unset: {
                    fcmToken: 1,
                    fcmTokenUpdatedAt: 1,
                    fcmSessionId: 1,
                    fcmSessionUpdatedAt: 1,
                    pushToken: 1,
                    lastTokenUpdate: 1,
                },
            }).catch(() => { });
            clearUserCache(userId);
            res.json({ success: true });
        } catch (error) {
            console.error(
                "[Auth] Error unregistering notification tokens:",
                error?.message,
            );
            res.status(500).json({ success: false });
        }
    },
);

// Register Expo push token for notifications
router.post("/register-push-token", verifyToken, async (req, res) => {
    try {
        const { pushToken } = req.body;
        const userId = req.userId;

        if (!pushToken) {
            return res.status(400).json({
                success: false,
                message: "Push token required",
            });
        }

        // Validate Expo push token format
        if (!String(pushToken).startsWith("ExponentPushToken[")) {
            return res.status(400).json({
                success: false,
                message: "Invalid Expo push token format",
            });
        }

        // Update user with push token
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            {
                pushToken,
                lastTokenUpdate: new Date(),
            },
            { returnDocument: "after" },
        );

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        console.log(
            `[PushToken] ? Push token registered for user ${userId}: ${pushToken.substring(0, 30)}...`,
        );

        res.json({
            success: true,
            message: "Push token registered successfully",
            token: pushToken.substring(0, 30) + "...",
        });
    } catch (error) {
        console.error(
            "[PushToken] Error registering push token:",
            error?.message,
        );
        res.status(500).json({
            success: false,
            message: "Failed to register push token",
        });
    }
});

router.post(
    "/test-reminder-scheduler",
    verifyToken,
    requireSuperadmin,
    async (req, res) => {
        try {
            const reminderScheduler = require("../services/reminderScheduler");
            const testMode =
                String(process.env.NODE_ENV || "").toLowerCase() !==
                "production";

            if (!testMode) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Reminder scheduler test endpoint only available in development",
                });
            }

            console.log(
                "[Auth] Manual reminder scheduler test initiated by superadmin",
            );
            await reminderScheduler.testReminderScheduler();

            res.json({
                success: true,
                message:
                    "Reminder scheduler test completed. Check server logs for results.",
            });
        } catch (error) {
            console.error(
                "[Auth] Reminder scheduler test error:",
                error?.message,
            );
            res.status(500).json({
                success: false,
                message: "Reminder scheduler test failed: " + error?.message,
            });
        }
    },
);

// OTP Login/Signup Routes
router.post("/otp/send", async (req, res) => {
    try {
        const { identifier } = req.body;
        if (!identifier) {
            return res.status(400).json({ success: false, message: "Email or mobile is required" });
        }

        const isEmail = identifier.includes("@");
        const normalizedIdentifier = isEmail ? identifier.trim().toLowerCase() : identifier.trim().replace(/\D/g, "");

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        const OtpModel = require("../models/Otp");
        await OtpModel.create({
            identifier: normalizedIdentifier,
            otp,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5 mins
        });

        if (isEmail) {
            const { createTransporter, getMailConfig, hasRealCredentials } = require("../utils/mailTransport");
            if (hasRealCredentials()) {
                const transporter = createTransporter();
                const { from } = getMailConfig();
                await transporter.sendMail({
                    from: `"NeoApp Security" <${from}>`,
                    to: normalizedIdentifier,
                    subject: "Your NeoApp Login Code",
                    text: `Your OTP is: ${otp}. It expires in 5 minutes.`,
                });
            } else {
                console.warn("[OTP] SMTP not configured. OTP:", otp);
            }
        } else {
            const { sendMobileOTP } = require("../utils/otpService");
            await sendMobileOTP(normalizedIdentifier, otp, { method: "whatsapp" });
        }

        res.json({ success: true, message: "OTP sent successfully" });
    } catch (error) {
        console.error("[OTP Send Error]:", error);
        res.status(500).json({ success: false, message: "Failed to send OTP" });
    }
});

router.post("/otp/verify", async (req, res) => {
    try {
        const { identifier, otp } = req.body;
        if (!identifier || !otp) {
            return res.status(400).json({ success: false, message: "Identifier and OTP required" });
        }

        const isEmail = identifier.includes("@");
        const normalizedIdentifier = isEmail ? identifier.trim().toLowerCase() : identifier.trim().replace(/\D/g, "");

        const OtpModel = require("../models/Otp");
        const otpDoc = await OtpModel.findOne({ identifier: normalizedIdentifier }).sort({ createdAt: -1 });

        if (!otpDoc || otpDoc.otp !== otp) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
        }

        // Delete OTP after use
        await OtpModel.deleteOne({ _id: otpDoc._id });

        // Find or create user
        let user;
        if (isEmail) {
            user = await User.findOne({ email: normalizedIdentifier }).sort({ createdAt: 1 });
        } else {
            user = await User.findOne({ mobile: normalizedIdentifier }).sort({ createdAt: 1 });
        }

        if (!user) {
            // Create Superadmin/Admin if new? The user says "login or signup show it website next login to pay it"
            // For B2B CRM, if they are new, they become a Company Admin.
            const Company = require("../models/Company");
            const newCompany = await Company.create({
                name: `Company-${normalizedIdentifier}`,
                code: Math.random().toString(36).substr(2, 6).toUpperCase(),
                status: "Active"
            });

            user = await User.create({
                name: isEmail ? normalizedIdentifier.split("@")[0] : "User",
                email: isEmail ? normalizedIdentifier : `${normalizedIdentifier}@placeholder.com`,
                mobile: isEmail ? "" : normalizedIdentifier,
                password: await bcrypt.hash(otp + process.env.JWT_SECRET, 10), // Random password
                role: "Admin", // First user is Admin
                company_id: newCompany._id,
                status: "Active"
            });
        }

        // Generate tokens (Copied from existing login flow)
        const { randomUUID } = require("crypto");
        const activeSessionId = randomUUID();
        const fcmSessionId = randomUUID();

        user.activeSessionId = activeSessionId;
        user.fcmSessionId = fcmSessionId;
        user.lastLogin = new Date();
        await user.save();

        const tokenPayload = {
            userId: user._id,
            company_id: user.company_id || null,
            role: user.role,
            sessionId: activeSessionId,
            fcmSessionId: fcmSessionId,
        };

        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: "30d" });

        // Web session cookie
        const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
        setWebAuthCookie(req, res, token, maxAgeMs);

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                company_id: user.company_id,
            },
        });
    } catch (error) {
        console.error("[OTP Verify Error]:", error);
        res.status(500).json({ success: false, message: "Verification failed" });
    }
});

module.exports = router;

const setWebAuthCookie = (req, res, token, maxAgeMs) => {
    const isSecure =
        String(process.env.WEB_AUTH_COOKIE_SECURE || "").toLowerCase() ===
        "true" ||
        req.secure ||
        req.headers["x-forwarded-proto"] === "https";
    const sameSite = isSecure ? "None" : "Lax";
    const parts = [
        `${WEB_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        `SameSite=${sameSite}`,
        `Max-Age=${Math.max(0, Math.floor(Number(maxAgeMs || 0) / 1000))}`,
    ];
    if (isSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
};

const clearWebAuthCookie = (req, res) => {
    const isSecure =
        String(process.env.WEB_AUTH_COOKIE_SECURE || "").toLowerCase() ===
        "true" ||
        req.secure ||
        req.headers["x-forwarded-proto"] === "https";
    const sameSite = isSecure ? "None" : "Lax";
    const parts = [
        `${WEB_AUTH_COOKIE_NAME}=`,
        "Path=/",
        "HttpOnly",
        `SameSite=${sameSite}`,
        "Max-Age=0",
    ];
    if (isSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
};
