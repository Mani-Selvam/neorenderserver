const axios = require("axios");
(async () => {
  try {
    const url = "http://localhost:5000/api/auth/signup";
    const res = await axios.post(
      url,
      {
        name: "Test User",
        email: `testuser+${Date.now()}@example.com`,
        password: "secret123",
        confirmPassword: "secret123",
      },
      { timeout: 10000 },
    );
    console.log("Status", res.status);
    console.log("Data", res.data);
  } catch (err) {
    if (err.response) {
      console.log("Status", err.response.status);
      console.log("Data", err.response.data);
    } else {
      console.error(err.message);
    }
  }
})();
