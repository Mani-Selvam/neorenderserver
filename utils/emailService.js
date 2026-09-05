const {
  createTransporter,
  getMailConfig,
  hasRealCredentials,
  verifyTransporter,
} = require("./mailTransport");

const sendEmail = async ({ to, subject, text, html }) => {
  try {
    if (!to) return false;

    if (!hasRealCredentials()) {
      console.warn("[Email] Missing credentials. Simulation only.", {
        to,
        subject,
      });
      return true;
    }

    const transporter = createTransporter();
    const { from } = getMailConfig();
    await verifyTransporter();

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });

    console.log("[Email] SMTP accepted message", {
      to,
      from,
      messageId: info?.messageId || "",
      accepted: info?.accepted || [],
      rejected: info?.rejected || [],
      response: info?.response || "",
    });

    return true;
  } catch (error) {
    console.error("[Email] Send failed:", error.message);
    return false;
  }
};

module.exports = { sendEmail };
