// Gate for server-to-server calls coming FROM WordPress (not a browser session, so there's no JWT
// to check). WordPress must send this exact value in the "x-webhook-secret" header.
const WEBHOOK_SECRET = process.env.ORDER_WEBHOOK_SECRET || "gullybaba_order_webhook_2026";

module.exports = (req, res, next) => {
  const provided =
    req.headers["x-webhook-secret"] ||
    req.headers["x-wc-webhook-secret"] ||
    req.query.secret ||
    req.query.webhook_secret ||
    (req.body && (req.body.webhook_secret || req.body.secret)) ||
    (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ""));

  if (provided !== WEBHOOK_SECRET) {
    return res.status(401).json({
      success: false,
      message: "Invalid or missing webhook secret. Provide via header 'x-webhook-secret' or query '?secret=...'",
    });
  }
  next();
};
