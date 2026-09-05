const axios = require("axios");
const { enqueueSms } = require("../services/smsQueue");
const twilio = require("twilio");
const {
    createTransporter,
    getMailConfig,
    hasRealCredentials,
    verifyTransporter,
} = require("./mailTransport");

const sendNeoTemplateMessage = async ({ phoneNumber, templateName, parameters }) => {
    try {
        const cfg = {
            endpoint: process.env.NEO_WHATSAPP_API_URL,
            token: process.env.NEO_WHATSAPP_API_TOKEN,
        };

        if (!cfg.endpoint || !cfg.token) {
            console.warn("[WhatsApp] API credentials missing — skipping send.");
            return false;
        }

        const payload = {
            to: String(phoneNumber || "").replace("+", ""), // Just remove the plus
            type: "template",
            template: {
                language: {
                    policy: "deterministic",
                    code: process.env.NEO_WHATSAPP_LANGUAGE || "en_US",
                },
                name: String(templateName || "").trim(),
                components: [
                    {
                        type: "body",
                        parameters: (parameters || []).map((text) => ({
                            type: "text",
                            text: String(text ?? "").trim(),
                        })),
                    },
                ],
            },
        };

        const response = await axios.post(
            `${cfg.endpoint}?token=${encodeURIComponent(cfg.token)}`,
            payload,
            { headers: { "Content-Type": "application/json" } },
        );

        return response.status === 200 || response.status === 201;
    } catch (error) {
        console.error(`[WhatsApp][${templateName}] failed:`, error.response?.data || error.message);
        return false;
    }
};

const sendWelcomeEmail = async (email, name, companyName, mobile) => {
    try {
        if (!hasRealCredentials()) {
            console.warn("Email SMTP settings missing. Skipping welcome email.");
            return false;
        }

        const transporter = createTransporter();
        const { from } = getMailConfig();
        await verifyTransporter();

        const subject = `Welcome to ${companyName || "NeoApp CRM"} — Account Activated`;
        const text = [
            "NEOPHRON Technologies",
            `Hi ${name || "User"},`,
            "",
            `Welcome to ${companyName || "NeoApp CRM"}. Your administrator account has been created successfully.`,
            "",
            `Registered email: ${email}`,
            `Mobile link: ${mobile || "Connected via Google"}`,
            "",
            "Thank you for choosing Neophron Technologies to scale your business operations.",
        ].join("\n");

        const html = `
            <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f6f9fc; padding: 40px 10px; margin: 0; width: 100%;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #eef2f6; box-shadow: 0 10px 25px rgba(27, 43, 62, 0.05);">
                    
                    <!-- Header Banner -->
                    <div style="background: linear-gradient(135deg, #1e1e24 0%, #0d0d0f 100%); padding: 32px 40px; text-align: center; border-bottom: 3px solid #d4af37;">
                        <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: 0.5px;">NEOPHRON</h1>
                        <p style="color: #d4af37; margin: 4px 0 0 0; font-size: 12px; text-transform: uppercase; font-weight: 700; letter-spacing: 2px;">Technologies</p>
                    </div>

                    <!-- Body Content -->
                    <div style="padding: 40px 40px 30px 40px;">
                        <h2 style="color: #1e1e24; font-size: 22px; font-weight: 700; margin-top: 0; margin-bottom: 16px;">
                            Hi ${name || "User"},
                        </h2>
                        <p style="color: #4b5563; font-size: 15px; line-height: 24px; margin-bottom: 24px;">
                            We are absolutely thrilled to welcome you to <strong style="color: #1e1e24;">${companyName || "NeoApp CRM"}</strong>! Your professional account has been successfully created and configured.
                        </p>
                        
                        <p style="color: #4b5563; font-size: 15px; line-height: 24px; margin-bottom: 24px;">
                            NeoApp is engineered to supercharge your customer relations, streamline your sales funnels, and maximize follow-up conversion rates with state-of-the-art bulk communication, tracking, and localized task scheduling.
                        </p>

                        <!-- Account Summary Card -->
                        <div style="background-color: #fdfbf7; border: 1px solid #f3e5c8; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
                            <h3 style="color: #8a6d25; font-size: 13px; font-weight: 700; text-transform: uppercase; margin-top: 0; margin-bottom: 12px; letter-spacing: 1px;">
                                Your Account Credentials
                            </h3>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 6px 0; font-size: 14px; color: #6b7280; width: 120px; font-weight: 500;">Registered Email</td>
                                    <td style="padding: 6px 0; font-size: 14px; color: #1e1e24; font-weight: 700;">${email}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 6px 0; font-size: 14px; color: #6b7280; font-weight: 500;">Mobile Link</td>
                                    <td style="padding: 6px 0; font-size: 14px; color: #1e1e24; font-weight: 700;">${mobile || "Connected via Google"}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 6px 0; font-size: 14px; color: #6b7280; font-weight: 500;">Access Tier</td>
                                    <td style="padding: 6px 0; font-size: 14px; color: #d4af37; font-weight: 700;">Administrator (Starter Plan)</td>
                                </tr>
                            </table>
                        </div>

                        <!-- CTA Button -->
                        <div style="text-align: center; margin-bottom: 32px;">
                            <a href="https://neophrontech.com" style="display: inline-block; background-color: #1e1e24; color: #ffffff; text-decoration: none; padding: 14px 32px; font-size: 15px; font-weight: 700; border-radius: 8px; border-bottom: 3px solid #d4af37;">
                                Launch Dashboard
                            </a>
                        </div>

                        <p style="color: #4b5563; font-size: 15px; line-height: 24px; margin-bottom: 0;">
                            If you have any questions or need onboarding assistance, our premium engineering support team is always standing by. Simply reply directly to this email!
                        </p>
                    </div>

                    <!-- Footer -->
                    <div style="background-color: #fafbfc; padding: 24px 40px; text-align: center; border-top: 1px solid #f0f2f5;">
                        <p style="color: #9ca3af; font-size: 12px; margin: 0; line-height: 18px;">
                            &copy; ${new Date().getFullYear()} Neophron Technologies. All rights reserved.
                        </p>
                        <p style="color: #9ca3af; font-size: 11px; margin: 4px 0 0 0;">
                            You received this email because you signed up for an account on NeoApp.
                        </p>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from,
            to: email,
            subject,
            text,
            html,
        });
        return true;
    } catch (error) {
        console.error("Error sending welcome email:", error.message);
        return false;
    }
};

const sendEmailOTP = async (email, otp) => {
    try {
        if (!hasRealCredentials()) {
            console.warn(
                "Email SMTP settings missing or placeholders. OTP email simulation only.",
            );
            return false;
        }

        const transporter = createTransporter();
        const { from } = getMailConfig();

        const subject = "Your NeoApp OTP Code";
        const text = [
            `Your NeoApp verification code is: ${otp}`,
            "",
            "This code will expire in 5 minutes.",
            "",
            "If you did not request this code, please ignore this email.",
        ].join("\n");
        const html = `
            <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
                <h2 style="margin: 0 0 12px;">NeoApp Verification Code</h2>
                <p style="margin: 0 0 12px;">Your verification code is <strong>${otp}</strong>.</p>
                <p style="margin: 0 0 12px;">This code will expire in 5 minutes.</p>
                <p style="margin: 0;">If you did not request this code, please ignore this email.</p>
            </div>
        `;

        const info = await transporter.sendMail({
            from,
            to: email,
            subject,
            text,
            html,
        });
        console.log("[OTP][Email] SMTP accepted message", {
            to: email,
            from,
            messageId: info?.messageId || "",
            accepted: info?.accepted || [],
            rejected: info?.rejected || [],
            response: info?.response || "",
        });
        return true;
    } catch (error) {
        console.error("Error sending email OTP:", error.message);
        return false;
    }
};

const toE164 = (mobile, defaultCountry) => {
    const raw = String(mobile || "").trim();
    if (!raw) return "";

    const digits = raw.replace(/[^\d]/g, "");
    if (!digits) return "";

    const cc = String(defaultCountry || "91").replace(/[^\d]/g, "") || "91";

    if (raw.startsWith("+")) {
        return `+${digits}`;
    }

    if (digits.length === 10) {
        return `+${cc}${digits}`;
    }

    if (digits.length === 12 && digits.startsWith(cc)) {
        return `+${digits}`;
    }

    return `+${digits}`;
};

const sendSmsViaQueue = async ({ phoneNumber, message }) => {
    try {
        const res = await enqueueSms({ phoneNumber, message });
        if (!res?.ok) {
            console.error(
                "[OTP] SMS queue failed:",
                res?.error || "unknown_error",
            );
        }
        return Boolean(res?.ok);
    } catch (_e) {
        return false;
    }
};

const getTwilioSmsConfig = () => ({
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
    fromNumber: String(process.env.TWILIO_SMS_NUMBER || "").trim(),
    messagingServiceSid: String(
        process.env.TWILIO_MESSAGING_SERVICE_SID || "",
    ).trim(),
});

const getNeoOtpTemplateConfig = () => ({
    endpoint: String(
        process.env.NEO_WHATSAPP_API_URL ||
            process.env.NEO_OTP_WHATSAPP_URL ||
            "https://aiwhatsappapi.neophrontech.com/v1/message/send-message",
    ).trim(),
    token: String(
        process.env.NEO_WHATSAPP_API_TOKEN ||
            process.env.NEO_OTP_TEMPLATE_TOKEN ||
            "",
    ).trim(),
    templateName: String(process.env.NEO_OTP_TEMPLATE_NAME || "").trim(),
    languageCode:
        String(
            process.env.NEO_WHATSAPP_LANGUAGE ||
                process.env.NEO_OTP_TEMPLATE_LANGUAGE ||
                "en",
        ).trim() || "en",
    buttonIndex:
        String(
            process.env.NEO_WHATSAPP_BUTTON_INDEX ||
                process.env.NEO_OTP_TEMPLATE_BUTTON_INDEX ||
                "0",
        ).trim() || "0",
});

const getNeoSignupTemplateConfig = () => ({
    endpoint: String(
        process.env.NEO_WHATSAPP_API_URL ||
            process.env.NEO_SIGNUP_WHATSAPP_URL ||
            process.env.NEO_OTP_WHATSAPP_URL ||
            "https://aiwhatsappapi.neophrontech.com/v1/message/send-message",
    ).trim(),
    token: String(
        process.env.NEO_WHATSAPP_API_TOKEN ||
            process.env.NEO_SIGNUP_TEMPLATE_TOKEN ||
            process.env.NEO_OTP_TEMPLATE_TOKEN ||
            "",
    ).trim(),
    languageCode:
        String(
            process.env.NEO_WHATSAPP_LANGUAGE ||
                process.env.NEO_SIGNUP_TEMPLATE_LANGUAGE ||
                "en",
        ).trim() || "en",
    userTemplateName: String(
        process.env.NEO_SIGNUP_USER_TEMPLATE_NAME || "company_signup_welcome",
    ).trim(),
    adminTemplateName: String(
        process.env.NEO_SIGNUP_ADMIN_TEMPLATE_NAME ||
            "admin_new_company_signup",
    ).trim(),
    adminNumber: String(process.env.SIGNUP_ADMIN_ALERT_NUMBER || "").trim(),
});

const sendSmsViaTwilio = async ({ phoneNumber, message }) => {
    try {
        const cfg = getTwilioSmsConfig();
        if (
            !cfg.accountSid ||
            !cfg.authToken ||
            (!cfg.fromNumber && !cfg.messagingServiceSid)
        ) {
            return false;
        }

        const client = twilio(cfg.accountSid, cfg.authToken);
        const payload = {
            body: message,
            to: phoneNumber,
        };
        if (cfg.messagingServiceSid) {
            payload.messagingServiceSid = cfg.messagingServiceSid;
        } else {
            payload.from = cfg.fromNumber.startsWith("+")
                ? cfg.fromNumber
                : `+${cfg.fromNumber}`;
        }

        const response = await client.messages.create(payload);

        console.log("[OTP] SMS sent via Twilio", {
            to: phoneNumber,
            sid: response?.sid || "",
            status: response?.status || "",
        });
        return true;
    } catch (error) {
        console.error(
            "[OTP] Twilio SMS failed:",
            error?.message || "unknown_error",
        );
        return false;
    }
};

const sendWhatsappTemplateOtp = async ({ phoneNumber, otp }) => {
    try {
        const cfg = getNeoOtpTemplateConfig();
        if (!cfg.token || !cfg.templateName) {
            return false;
        }

        const payload = {
            to: String(phoneNumber || "").replace(/[^\d]/g, ""),
            type: "template",
            template: {
                language: {
                    policy: "deterministic",
                    code: cfg.languageCode,
                },
                name: cfg.templateName,
                components: [
                    {
                        type: "body",
                        parameters: [
                            {
                                type: "text",
                                text: String(otp || ""),
                            },
                        ],
                    },
                    {
                        type: "button",
                        sub_type: "url",
                        index: cfg.buttonIndex,
                        parameters: [
                            {
                                type: "text",
                                text: String(otp || ""),
                            },
                        ],
                    },
                ],
            },
        };

        const response = await axios.post(
            `${cfg.endpoint}?token=${encodeURIComponent(cfg.token)}`,
            payload,
            {
                headers: { "Content-Type": "application/json" },
                timeout: 4000,
            },
        );

        console.log("[OTP] WhatsApp template OTP sent", {
            to: payload.to,
            templateName: cfg.templateName,
            status: response?.status || 0,
        });
        return true;
    } catch (error) {
        console.error(
            "[OTP] WhatsApp template OTP failed:",
            error?.response?.data || error?.message || "unknown_error",
        );
        return false;
    }
};



const sendSignupTemplateNotifications = async ({
    customerPhoneNumber,
    customerName,
    companyName,
    companyCode,
    email,
    adminPhoneNumber,
}) => {
    const cfg = getNeoSignupTemplateConfig();
    const adminNumber = String(
        adminPhoneNumber || cfg.adminNumber || "",
    ).trim();
    const safeCustomerName = String(customerName || "").trim() || "Customer";
    const safeCompanyName =
        String(companyName || "").trim() || safeCustomerName;
    const safeCompanyCode = String(companyCode || "").trim() || "-";
    const safeContact =
        String(email || customerPhoneNumber || "").trim() || "-";
    const safeMobile = String(customerPhoneNumber || "").trim() || "-";
    const now = new Date();
    const safeSignupDate = `${String(now.getDate()).padStart(2, "0")}/${String(
        now.getMonth() + 1,
    ).padStart(2, "0")}/${now.getFullYear()}`;

    const tasks = [];

    if (customerPhoneNumber && cfg.userTemplateName) {
        tasks.push(
            sendNeoTemplateMessage({
                phoneNumber: customerPhoneNumber,
                templateName: cfg.userTemplateName,
                parameters: [
                    safeCustomerName,
                    safeCompanyName,
                    String(email || "").trim() || "-",
                    safeMobile,
                ],
            }),
        );
    }

    if (adminNumber && cfg.adminTemplateName) {
        tasks.push(
            sendNeoTemplateMessage({
                phoneNumber: adminNumber,
                templateName: cfg.adminTemplateName,
                parameters: [
                    safeCustomerName,
                    safeCompanyName,
                    safeMobile,
                    safeSignupDate,
                ],
            }),
        );
    }

    if (!tasks.length) return false;
    const results = await Promise.allSettled(tasks);
    return results.some((item) => item.status === "fulfilled" && item.value);
};

const sendMobileOTP = async (mobile, otp, options = {}) => {
    let neoNotConfiguredMessage = "";
    try {
        const cleanNum = (mobile || "").replace(/\D/g, "");
        if (!cleanNum) return false;

        const {
            NEO_NOT_CONFIGURED_MESSAGE,
            loadWhatsappConfig,
            normalizePhoneNumber,
            sendWhatsAppMessage,
        } = require("./whatsappConfigService");
        neoNotConfiguredMessage = NEO_NOT_CONFIGURED_MESSAGE;

        const cfg = await loadWhatsappConfig({
            ownerUserId: options.ownerUserId,
        });

        const method = String(options.method || "")
            .toLowerCase()
            .trim(); // "sms" | "whatsapp" | ""
        const defaultCountry = cfg?.defaultCountry || "91";
        const e164 = toE164(mobile, defaultCountry);
        if (!e164) return false;

        const message = `Your CRM verification code is: ${otp}`;

        const tryWhatsapp = async () => {
            if (!cfg) return false;
            const normalizedNumber = normalizePhoneNumber(
                cleanNum,
                cfg.defaultCountry || "91",
            );
            await sendWhatsAppMessage({
                ownerUserId: options.ownerUserId,
                phoneNumber: normalizedNumber,
                content: message,
            });
            console.log(`[OTP] WhatsApp OTP sent to ${normalizedNumber}`);
            return true;
        };

        // Primary WhatsApp template send via Neo API
        const templateOk = await sendWhatsappTemplateOtp({
            phoneNumber: e164,
            otp,
        });
        if (templateOk) {
            console.log(`[OTP] WhatsApp template OTP sent via Neo API to ${e164}`);
            return true;
        }

        try {
            const whatsappOk = await tryWhatsapp();
            if (whatsappOk) {
                console.log(`[OTP] WhatsApp OTP sent via custom config to ${e164}`);
                return true;
            }
        } catch (wErr) {
            console.warn("[OTP] WhatsApp provider error:", wErr.message);
        }

        return false;
    } catch (error) {
        const errMsg = error.response?.data?.message || error.message || "";
        if (
            (neoNotConfiguredMessage &&
                errMsg.includes(neoNotConfiguredMessage)) ||
            errMsg.includes("Neo WhatsApp credentials are missing")
        ) {
            console.error("Error sending mobile OTP:", errMsg);
            return false;
        }
        console.error(
            "Error sending mobile OTP:",
            error.response?.data || error.message,
        );
        return false;
    }
};

const sendPlanUpgradeNotification = async ({
    phoneNumber,
    customerName,
    planName,
    expiryDate,
}) => {
    try {
        const templateName = String(process.env.NEO_UPGRADE_PLAN_TEMPLATE_NAME || "neogroww_plan_upgrade").trim();
        if (!templateName || !phoneNumber) return false;

        const formattedNumber = toE164(phoneNumber, "91");
        if (!formattedNumber) return false;

        const safeExpiryDate = expiryDate
            ? new Date(expiryDate).toLocaleDateString("en-IN")
            : "Lifetime";

        const ok = await sendNeoTemplateMessage({
            phoneNumber: formattedNumber,
            templateName,
            parameters: [
                String(customerName || "Valued Customer").trim(),
                String(planName || "Pro").trim(),
            ],
        });
        console.log(`[WhatsApp][PlanUpgrade] Notification sent to ${formattedNumber}. Success: ${ok}`);
        return ok;
    } catch (error) {
        console.error(
            "[WhatsApp][PlanUpgrade] Notification failed:",
            error.message,
        );
        return false;
    }
};

const sendAdminPaymentAlert = async ({
    customerName,
    companyName,
    planName,
    amount,
    paymentId,
}) => {
    try {
        const templateName = process.env.NEO_ADMIN_PAYMENT_ALERT_TEMPLATE_NAME;
        const adminNumber = process.env.SIGNUP_ADMIN_ALERT_NUMBER;
        if (!templateName || !adminNumber) return false;

        const formattedAdminNumber = toE164(adminNumber, "91");

        return sendNeoTemplateMessage({
            phoneNumber: formattedAdminNumber || adminNumber,
            templateName,
            parameters: [
                String(customerName || "Customer").trim(),
                String(companyName || "N/A").trim(),
                String(planName || "Pro").trim(),
                String(amount || "0").trim(),
                String(paymentId || "-").trim(),
            ],
        });
    } catch (error) {
        console.error(
            "[WhatsApp][AdminPaymentAlert] failed:",
            error.message,
        );
        return false;
    }
};


module.exports = {
    sendEmailOTP,
    sendMobileOTP,
    sendSignupTemplateNotifications,
    sendPlanUpgradeNotification,
    sendAdminPaymentAlert,
    sendNeoTemplateMessage,
    sendWelcomeEmail,
};
