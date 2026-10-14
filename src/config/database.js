const { Pool, types } = require("pg");
require("dotenv").config();

// OID 1114: TIMESTAMP WITHOUT TIME ZONE
// In our WooCommerce database, timestamps ending in _gmt (like date_created_gmt, date_updated_gmt)
// store UTC/GMT values without timezone offsets. Appending 'Z' tells Node.js that the value is in UTC,
// so that when formatted in the store timezone (Asia/Kolkata, UTC+5:30), it matches WordPress local time.
types.setTypeParser(1114, (str) => {
  if (!str) return null;
  const iso = str.includes("T") ? (str.endsWith("Z") ? str : str + "Z") : str.replace(" ", "T") + "Z";
  return new Date(iso);
});

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

pool.on("connect", () => {
  console.log("PostgreSQL connected successfully");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

module.exports = pool;
