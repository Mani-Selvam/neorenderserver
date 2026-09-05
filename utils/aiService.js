const axios = require("axios");

/**
 * AI Service for CRM Auto-Replies
 * Uses Google Gemini API via the provided API key
 */
const generateAIReply = async (customerMessage, history = []) => {
    try {
        // Support multiple env var names for the API key (backwards compat)
        const apiKey =
            process.env.AI_REPLY_API_KEY ||
            process.env.Ai_REPLAY_API_KEY ||
            process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            console.error(
                "❌ AI Error: AI API key not found in environment (AI_REPLY_API_KEY / Ai_REPLAY_API_KEY / GOOGLE_API_KEY).",
            );
            return null;
        }

        // Try multiple model candidates (env override first)
        const modelEnv = process.env.AI_MODEL;
        const modelCandidates = [
            modelEnv,
            "models/gemini-1.5-flash",
            "models/gemini-1.5",
            "models/text-bison-001",
            "models/chat-bison-001",
        ].filter(Boolean);

        // Construct a professional prompt
        const prompt = `You are a professional assistant for a business CRM system. Your goal is to provide helpful, concise, and polite responses to customer enquiries on WhatsApp.

Customer Name: Customer
Context: This is a business WhatsApp chat.
Customer Message: "${customerMessage}"

Rules:
1. Keep the reply short (max 2-3 sentences).
2. Be professional but friendly.
3. Do not use placeholders like [Name] if you don't know it.
4. If the message is just a greeting, respond with a warm welcome.
5. If they ask about pricing or services, acknowledge and say a team member will follow up soon.

Response:
`;

        for (const model of modelCandidates) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;
                console.log(`[AI] Trying model ${model}`);
                const response = await axios.post(
                    url,
                    { contents: [{ parts: [{ text: prompt }] }] },
                    {
                        headers: { "Content-Type": "application/json" },
                        timeout: 20000,
                    },
                );

                // Try a few possible response shapes
                const replyText =
                    response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                    response.data?.outputs?.[0]?.content?.[0]?.text ||
                    response.data?.result?.outputs?.[0]?.content?.text ||
                    null;

                if (replyText) {
                    console.log(`[AI] Model ${model} returned a reply`);
                    return replyText.trim();
                }
                console.warn(
                    `[AI] Model ${model} returned no text; trying next.`,
                );
            } catch (err) {
                const status = err.response?.status;
                console.warn(
                    `[AI] Model ${model} failed:`,
                    err.response?.data || err.message,
                );
                // If not found, try next model; otherwise also try next to be resilient
                if (status === 404) continue;
                continue;
            }
        }

        // Fallback: respect an explicit fallback reply if configured
        if (process.env.AI_FALLBACK_REPLY) return process.env.AI_FALLBACK_REPLY;

        console.error("❌ AI Error: No available models produced a reply.");
        return null;
    } catch (error) {
        console.error(
            "❌ AI Service Error:",
            error.response?.data || error.message,
        );
        return null;
    }
};

module.exports = { generateAIReply };
