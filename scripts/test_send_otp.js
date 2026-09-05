const axios = require("axios");
(async () => {
  try {
    const url = "http://localhost:5000/api/auth/send-otp";
    const res = await axios.post(url, {
      email: "maniselvam2023@gmail.com",
      mobile: "+918825620014",
      type: "signup",
    });
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
