const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });
const mongoose = require("mongoose");

const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DB_URI ||
  "mongodb://127.0.0.1:27017/crm_db";

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to", MONGO_URI);
    const Company = require("../models/Company");
    const User = require("../models/User");

    const companyId = process.argv[2];
    if (!companyId) {
      console.error("Usage: node check_company.js <companyId>");
      process.exit(1);
    }

    const company = await Company.findById(companyId).lean();
    if (!company) {
      console.log("Company not found", companyId);
      await mongoose.disconnect();
      return;
    }

    console.log("Company:", {
      _id: company._id.toString(),
      name: company.name,
      code: company.code,
      domain: company.domain,
    });

    const users = await User.find({ company_id: company._id })
      .select("name email role mobile status")
      .lean();
    console.log("Users for company:", users.length);
    users.forEach((u) => console.log("-", u.email, u.role, u.mobile, u.status));

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
