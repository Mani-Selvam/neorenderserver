const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const connectDB = require("../config/db");
const { setSecurityPolicy } = require("../services/settingsService");

(async () => {
  try {
    const ok = await connectDB();
    if (!ok) {
      console.error("DB connection failed. Aborting.");
      process.exit(1);
    }

    const next = await setSecurityPolicy({ enforceSuperadmin2fa: false });
    console.log("Updated security policy:", next);
    process.exit(0);
  } catch (e) {
    console.error("Failed:", e?.message || e);
    process.exit(1);
  }
})();

