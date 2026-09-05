const crypto = require("crypto");

const ALGORITHM = "aes-256-cbc";
const KEY = (process.env.WHATSAPP_STORE_ENCRYPTION_KEY || "")
  .padEnd(32, "0")
  .slice(0, 32);

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(KEY), iv);
  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");
  // store iv:encrypted
  return iv.toString("base64") + ":" + encrypted;
}

function decrypt(payload) {
  if (!payload) return "";
  try {
    const parts = String(payload || "").split(":");
    if (parts.length < 2) return "";

    // IV is expected as base64 of 16 bytes. Try base64 first, then hex.
    let iv = null;
    try {
      iv = Buffer.from(parts[0], "base64");
    } catch (e) {
      try {
        iv = Buffer.from(parts[0], "hex");
      } catch (e2) {
        // invalid iv encoding
        console.warn("Decrypt failed: invalid IV encoding");
        return "";
      }
    }

    // Some stores may have replaced + with space or otherwise mangled base64.
    let encrypted = parts.slice(1).join(":");
    encrypted = encrypted.replace(/\s/g, "+");

    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(KEY), iv);
    let dec = decipher.update(encrypted, "base64", "utf8");
    dec += decipher.final("utf8");
    return dec;
  } catch (e) {
    // Provide a concise warning to help triage common issues (wrong key or corrupted payload).
    console.warn("Decrypt failed:", e && e.message ? e.message : String(e));
    return "";
  }
}

module.exports = { encrypt, decrypt };
