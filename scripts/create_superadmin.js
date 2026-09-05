const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const connectDB = require("../config/db");
const User = require("../models/User");

async function run() {
  await connectDB();

  const email = "superadmin@gmail.com";
  const password = "superadmin@01";

  let user = await User.findOne({ email });

  if (!user) {
    user = new User({
      name: "Super Admin",
      email,
      password,
      role: "superadmin",
      status: "Active",
      company_id: null,
    });
  } else {
    user.name = user.name || "Super Admin";
    user.role = "superadmin";
    user.status = "Active";
    user.company_id = null;
    user.password = password;
  }

  await user.save();

  console.log("Superadmin ready:", {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    status: user.status,
  });

  process.exit(0);
}

run().catch((err) => {
  console.error("Failed to create superadmin:", err.message);
  process.exit(1);
});
