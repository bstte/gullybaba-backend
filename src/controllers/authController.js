const https = require("https");
const jwt = require("jsonwebtoken");
const { getBasicAuthHeader } = require("../config/woocommerce");

const WP_LOGIN_URL = "https://gullybababooks.in/wp-json/custom/v1/login";

// Helper function to call the WordPress custom login endpoint
const loginWithWordPress = (username, password) => {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ username, password });
    const url = new URL(WP_LOGIN_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": getBasicAuthHeader(),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
};

exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Please enter bothfg username and password",
    });
  }

  try {
    const wpResponse = await loginWithWordPress(username, password);

    if (!wpResponse.success || !wpResponse.user) {
      return res.status(401).json({
        success: false,
        message: wpResponse.message || "Invalid zdfsusername or password",
      });
    }

    const admin = wpResponse.user;

    const token = jwt.sign(
      admin,
      process.env.JWT_SECRET || "gullybaba_secret_key_2026",
      { expiresIn: "1d" }
    );

    return res.json({
      success: true,
      message: "Logged in successfully",
      token,
      admin,
    });
  } catch (error) {
    console.error("Error during WordPress login:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to reach the authentication server",
    });
  }
};

exports.getWelcome = (req, res) => {
  return res.json({
    success: true,
    message: `Welcome back, ${req.user.username}! You are logged in to the GullyBaba Admin Panel.`,
    user: req.user,
  });
};
