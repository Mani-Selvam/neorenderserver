const crypto = require("crypto");
const { getRazorpayConfig } = require("./settingsService");

const getRazorpayClientAsync = async () => {
  const { keyId, keySecret } = await getRazorpayConfig();
  if (!keyId || !keySecret) {
    throw new Error("Razorpay is not configured (missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
  }

  let Razorpay;
  try {
    Razorpay = require("razorpay");
  } catch (_e) {
    throw new Error("Missing dependency: install `razorpay` in the server environment");
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const verifyCheckoutSignatureAsync = async ({ orderId, paymentId, signature }) => {
  const { keySecret } = await getRazorpayConfig();
  if (!keySecret) throw new Error("Missing RAZORPAY_KEY_SECRET");
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac("sha256", keySecret).update(body).digest("hex");
  return expected === signature;
};

const verifyWebhookSignatureAsync = async ({ rawBody, signature }) => {
  const { webhookSecret } = await getRazorpayConfig();
  if (!webhookSecret) throw new Error("Missing RAZORPAY_WEBHOOK_SECRET");
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return expected === signature;
};

module.exports = {
  getRazorpayClientAsync,
  verifyCheckoutSignatureAsync,
  verifyWebhookSignatureAsync,
};
