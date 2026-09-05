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
    const User = require("../models/User");
    const email = process.argv[2] || "maniselvam2023@gmail.com";
    const u = await User.findOne({ email }).lean();
    if (!u) {
      console.log("User not found for", email);
    } else {
      console.log("User found:", {
        _id: u._id.toString(),
        email: u.email,
        role: u.role,
        status: u.status,
        company_id: u.company_id ? u.company_id.toString() : null,
      });
    }
    await mongoose.disconnect();
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
