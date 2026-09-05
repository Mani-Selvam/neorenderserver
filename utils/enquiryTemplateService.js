const axios = require("axios");

const toE164 = (mobile, defaultCountry) => {
    const raw = String(mobile || "").trim();
    if (!raw) return "";

    if (raw.startsWith("+")) {
        const digits = raw.replace(/[^\d]/g, "");
        return digits ? `+${digits}` : "";
    }

    const digits = raw.replace(/[^\d]/g, "");
    if (!digits) return "";

    const cc = String(defaultCountry || "91").replace(/[^\d]/g, "") || "91";
    return `+${cc}${digits}`;
};

const getNeoEnquiryTemplateConfig = () => ({
    endpoint: String(
        process.env.NEO_WHATSAPP_API_URL ||
            process.env.NEO_ENQUIRY_URL ||
            process.env.NEO_SIGNUP_WHATSAPP_URL ||
            process.env.NEO_OTP_WHATSAPP_URL ||
            "https://aiwhatsappapi.neophrontech.com/v1/message/send-message",
    ).trim(),
    token: String(
        process.env.NEO_WHATSAPP_API_TOKEN ||
            process.env.NEO_ENQUIRY_TEMPLATE_TOKEN ||
            process.env.NEO_SIGNUP_TEMPLATE_TOKEN ||
            process.env.NEO_OTP_TEMPLATE_TOKEN ||
            "",
    ).trim(),
    templateName: String(process.env.NEO_ENQUIRY_TEMPLATE_NAME || "").trim(),
    languageCode:
        String(
            process.env.NEO_WHATSAPP_LANGUAGE ||
                process.env.NEO_ENQUIRY_TEMPLATE_LANGUAGE ||
                process.env.NEO_SIGNUP_TEMPLATE_LANGUAGE ||
                process.env.NEO_OTP_TEMPLATE_LANGUAGE ||
                "en",
        ).trim() || "en",
    buttonIndex:
        Number(process.env.NEO_WHATSAPP_BUTTON_INDEX || 0) >= 0
            ? Number(process.env.NEO_WHATSAPP_BUTTON_INDEX)
            : -1,
    buttonSubType: String(
        process.env.NEO_WHATSAPP_BUTTON_SUB_TYPE || "quick_reply",
    ).trim().toLowerCase(),
});

const getCompanyTemplateConfig = async (companyId, company) => {
    if (!company || !company.whatsappTemplate || !company.whatsappTemplate.enabled) return null;
    
    const { loadWhatsappConfig } = require("./whatsappConfigService");
    const waConfig = await loadWhatsappConfig({ companyId });
    
    let token = "";
    let endpoint = "";
    
    if (waConfig && waConfig.provider === "NEO") {
        const { decrypt } = require("./crypto");
        endpoint = String(waConfig.neoBaseUrl || "").trim();
        if (waConfig.neoBearerTokenEncrypted) token = decrypt(waConfig.neoBearerTokenEncrypted) || "";
        if (!token && waConfig.neoApiKeyEncrypted) token = decrypt(waConfig.neoApiKeyEncrypted) || "";
    }

    return {
        endpoint: endpoint,
        token: token,
        templateName: String(waConfig?.enquiryAlertTemplateName || company?.whatsappTemplate?.name || "").trim(),
        languageCode: String(waConfig?.templateLanguage || "en").trim(),
        buttonIndex: typeof waConfig?.templateButtonIndex === "number" ? waConfig.templateButtonIndex : 0,
    };
};

const sendNeoTemplateMessage = async ({
    phoneNumber,
    templateName,
    parameters = [],
    config = null,
}) => {
    try {
        const cfg = config || getNeoEnquiryTemplateConfig();
        if (!cfg.token || !templateName) {
            console.warn(
                "[WhatsApp][EnquiryTemplate] Missing token or template name",
                {
                    hasToken: !!cfg.token,
                    hasTemplateName: !!templateName,
                },
            );
            return false;
        }

        const cleanedPhoneNumber = String(phoneNumber || "").replace(
            /[^\d]/g,
            "",
        );
        if (!cleanedPhoneNumber) {
            console.warn(
                "[WhatsApp][EnquiryTemplate] Invalid phone number:",
                phoneNumber,
            );
            return false;
        }

        const components = [
            {
                type: "body",
                parameters: parameters.map((value) => ({
                    type: "text",
                    text: String(value || ""),
                })),
            },
        ];

        // Only add button component if buttonIndex is valid and template supports it
        // Set NEO_ENQUIRY_TEMPLATE_BUTTON_INDEX=-1 to disable button component
        // NOTE: Button sub_type is read from cfg.buttonSubType (defaults to "quick_reply").
        //       Set NEO_WHATSAPP_BUTTON_SUB_TYPE=url if your template uses a URL button.
        if (
            cfg.buttonIndex >= 0 &&
            cfg.buttonIndex !== null &&
            cfg.buttonIndex !== undefined
        ) {
            const subType = String(cfg.buttonSubType || "quick_reply").trim().toLowerCase();
            const buttonComponent = {
                type: "button",
                sub_type: subType,
                index: cfg.buttonIndex,
            };

            // URL buttons need a text parameter; Quick Reply buttons do not
            if (subType === "url") {
                buttonComponent.parameters = [
                    {
                        type: "text",
                        text: String(parameters[0] || ""),
                    },
                ];
            } else {
                buttonComponent.parameters = [
                    {
                        type: "payload",
                        payload: "BUTTON_REPLY",
                    },
                ];
            }

            components.push(buttonComponent);
        }

        const payload = {
            to: cleanedPhoneNumber,
            type: "template",
            template: {
                language: {
                    policy: "deterministic",
                    code: cfg.languageCode,
                },
                name: templateName,
                components: components,
            },
        };

        console.log("[WhatsApp][EnquiryTemplate] Sending payload:", {
            to: payload.to,
            templateName,
            endpoint: cfg.endpoint,
            parameters: payload.template.components[0].parameters.map(
                (p) => p.text,
            ),
        });

        console.log(
            "[WhatsApp][EnquiryTemplate] Phone number formatted to:",
            payload.to,
        );

        console.log(
            "[WhatsApp][EnquiryTemplate] Full payload:",
            JSON.stringify(payload, null, 2),
        );

        const response = await axios.post(
            `${cfg.endpoint}?token=${encodeURIComponent(cfg.token)}`,
            payload,
            {
                headers: { "Content-Type": "application/json" },
                timeout: 20000,
            },
        );

        console.log("[WhatsApp][EnquiryTemplate] sent successfully", {
            to: payload.to,
            templateName,
            status: response?.status || 0,
            responseData: response?.data || {},
        });
        return true;
    } catch (error) {
        console.error("[WhatsApp][EnquiryTemplate] API call failed:", {
            message: error?.message,
            status: error?.response?.status,
            data: error?.response?.data,
        });
        return false;
    }
};

const sendNeoEnquiryTemplateMessage = async ({
    phoneNumber,
    customerName,
    productName,
    companyName,
    companyId,
}) => {
    try {
        let cfg = null;
        if (companyId) {
            const Company = require("../models/Company");
            const company = await Company.findById(companyId).select("whatsappTemplate").lean();
            if (company && company.whatsappTemplate && company.whatsappTemplate.enabled) {
                // The company uses its own custom configuration merged with Global WA API config
                cfg = await getCompanyTemplateConfig(companyId, company);
            }

            if (!cfg && company && company.whatsappTemplate && company.whatsappTemplate.disableEnvFallback) {
                console.log("[WhatsApp][EnquiryTemplate] Global env fallback disabled for company", companyId);
                return false;
            }
        }
        
        // Fallback to global config if company config is missing, incomplete, or disabled
        if (!cfg || !cfg.token || !cfg.templateName || !cfg.endpoint) {
            cfg = getNeoEnquiryTemplateConfig();
        }

        console.log("[WhatsApp][EnquiryTemplate] Config loaded:", {
            hasToken: !!cfg.token,
            hasTemplateName: !!cfg.templateName,
            templateName: cfg.templateName,
            phoneNumber: String(phoneNumber || "").replace(/[^\d]/g, ""),
        });

        console.log("[WhatsApp][EnquiryTemplate] Button config:", {
            buttonIndex: cfg.buttonIndex,
            buttonIndexType: typeof cfg.buttonIndex,
            willIncludeButton: cfg.buttonIndex >= 0,
        });

        if (!cfg.token) {
            console.warn("[WhatsApp][EnquiryTemplate] Missing token in config");
            return false;
        }

        if (!cfg.templateName) {
            console.warn(
                "[WhatsApp][EnquiryTemplate] Missing template name in config",
            );
            return false;
        }

        // Format phone number with country code (Neo API expects without +)
        const formattedPhone = toE164(phoneNumber, "91").replace(/^\+/, "");
        if (!formattedPhone) {
            console.warn(
                "[WhatsApp][EnquiryTemplate] Invalid phone number:",
                phoneNumber,
            );
            return false;
        }

        console.log("[WhatsApp][EnquiryTemplate] Phone formatting:", {
            original: phoneNumber,
            formatted: formattedPhone,
        });

        return sendNeoTemplateMessage({
            phoneNumber: formattedPhone,
            templateName: cfg.templateName,
            parameters: [
                String(customerName || "").trim(),
                String(productName || "").trim(),
                String(companyName || "").trim(),
            ],
            config: cfg,
        });
    } catch (error) {
        console.error(
            "[WhatsApp][EnquiryTemplate] Error in sendNeoEnquiryTemplateMessage:",
            error?.message || error,
        );
        return false;
    }
};

module.exports = {
    sendNeoEnquiryTemplateMessage,
    sendNeoTemplateMessage,
};
