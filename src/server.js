const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/database");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const orderRoutes = require("./routes/orderRoutes");
const productRoutes = require("./routes/productRoutes");
const couponRoutes = require("./routes/couponRoutes");
const blogRoutes = require("./routes/blogRoutes");
const abandonedCartRoutes = require("./routes/abandonedCartRoutes");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/products", productRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/blog", blogRoutes);
app.use("/api/abandoned-carts", abandonedCartRoutes);


app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      success: true,
      message: "GullyBaba API is running",
      database: "connected",
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`GullyBaba backend running on port ${PORT}`);
});
