// server.js
import express from "express";
import cors from "cors";
import PDFDocument from "pdfkit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pkg from "pg";

import { createClient } from "@supabase/supabase-js";
import multer from "multer";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();


// ✅ CORS FIRST
app.use(cors({
  origin: "https://westlink.onrender.com",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

// ✅ JSON parser
app.use(express.json());

// ---------- DATABASE ----------
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not set in environment variables");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// create tables if not exist
async function initTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        is_admin BOOLEAN DEFAULT false
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT,
        price NUMERIC,
        category TEXT,
        image TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS carts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        product_id INTEGER,
        quantity INTEGER
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        full_name TEXT,
        phone TEXT,
        delivery_address TEXT,
        products JSONB,
        total_price NUMERIC,
        status TEXT DEFAULT 'pending'
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS about_images (
        id SERIAL PRIMARY KEY,
        image TEXT
      );
    `);

    console.log("📌 PostgreSQL tables ready");
  } catch (err) {
    console.error("❌ Error initializing tables:", err);
    process.exit(1);
  }
}
initTables();




// ---------- AUTH ----------

// REGISTER
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const hashed = bcrypt.hashSync(password, 10);

    const result = await pool.query(
      "INSERT INTO users (name, email, password) VALUES ($1,$2,$3) RETURNING id,name,email,is_admin",
      [name, email, hashed]
    );

    res.json({ message: "Registration successful", user: result.rows[0] });
    console.log(`[${new Date().toISOString()}] User registered: ${email}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Register error:`, err);
    res.status(400).json({ message: "Email already registered" });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, isAdmin: user.is_admin },
      process.env.SECRET || "westlink_secret_key",
      { expiresIn: "2h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: user.is_admin,
        is_staff: user.is_admin,
      },
    });
    console.log(`[${new Date().toISOString()}] User logged in: ${email}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Login error:`, err);
    res.status(500).json({ message: "Server error" });
  }
});

// PROFILE
app.get("/api/profile/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id,name,email,is_admin FROM users WHERE id=$1",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Profile error:`, err);
    res.status(500).json({ message: "Server error" });
  }
});


// Store files in memory instead of local disk
const upload = multer({ storage: multer.memoryStorage() });


// ---------------------- HELPER: UPLOAD TO SUPABASE ----------------------
async function uploadToSupabase(file, bucketName) {
  if (!file) return "";

  const fileName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");

  const { data, error } = await supabase.storage
    .from(bucketName)
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) {
    console.error("Supabase upload error:", error);
    return "";
  }

  // Return public CDN URL
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucketName}/${fileName}`;
}



// --------------------------------------------------------------------
// --------------------------- PRODUCTS -------------------------------
// --------------------------------------------------------------------

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Get products error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// --- ADD PRODUCT WITH SUPABASE IMAGE ---
app.post("/api/products", upload.array("images", 3), async (req, res) => {
  try {
    const { name, price, category } = req.body;

    let image1 = "";
    let image2 = "";
    let image3 = "";

    if (req.files?.length) {
      if (req.files[0]) image1 = await uploadToSupabase(req.files[0], "products");
      if (req.files[1]) image2 = await uploadToSupabase(req.files[1], "products");
      if (req.files[2]) image3 = await uploadToSupabase(req.files[2], "products");
    }

    const result = await pool.query(
      `INSERT INTO products (name, price, category, image1, image2, image3)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name, price, category, image1, image2, image3]
    );

    res.json(result.rows[0]);
    console.log("Product added:", name);
  } catch (err) {
    console.error("Add product error:", err);
    res.status(500).json({ message: "Server error" });
  }
});



// --- UPDATE PRODUCT WITH OPTIONAL NEW IMAGE ---
app.put("/api/products/:id", upload.array("images", 3), async (req, res) => {
  try {
    const { name, price, category } = req.body;

    const existing = await pool.query(
      "SELECT * FROM products WHERE id=$1",
      [req.params.id]
    );

    if (!existing.rows.length)
      return res.status(404).json({ message: "Product not found" });

    let { image1, image2, image3 } = existing.rows[0];

    if (req.files?.length) {
      if (req.files[0]) image1 = await uploadToSupabase(req.files[0], "products");
      if (req.files[1]) image2 = await uploadToSupabase(req.files[1], "products");
      if (req.files[2]) image3 = await uploadToSupabase(req.files[2], "products");
    }

    const result = await pool.query(
      `UPDATE products
       SET name=$1, price=$2, category=$3,
           image1=$4, image2=$5, image3=$6
       WHERE id=$7
       RETURNING *`,
      [name, price, category, image1, image2, image3, req.params.id]
    );

    res.json(result.rows[0]);
    console.log("Product updated:", name);
  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// --- DELETE PRODUCT ---
app.delete("/api/products/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);
    res.json({ message: "Product deleted" });
    console.log("Product deleted ID:", req.params.id);
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


  

// ---------- CART ----------
app.get("/api/cart/:userId", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM carts WHERE user_id=$1", [req.params.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get cart error:`, err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/cart", async (req, res) => {
  try {
    const { userId, productId, quantity } = req.body;

    const existing = await pool.query(
      "SELECT * FROM carts WHERE user_id=$1 AND product_id=$2",
      [userId, productId]
    );

    if (existing.rows.length) {
      await pool.query(
        "UPDATE carts SET quantity = quantity + $1 WHERE id=$2",
        [quantity, existing.rows[0].id]
      );
    } else {
      await pool.query(
        "INSERT INTO carts (user_id, product_id, quantity) VALUES ($1,$2,$3)",
        [userId, productId, quantity]
      );
    }

    res.json({ message: "Added to cart" });
    console.log(`[${new Date().toISOString()}] Cart updated for user ID: ${userId}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cart error:`, err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------- ORDERS ----------

// ================== ORDERS ==================

// CREATE ORDER (User)
app.post("/api/orders", async (req, res) => {
  try {
    const { userId, fullName, phone, deliveryAddress, products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: "No products in order" });
    }

    const total = products.reduce(
      (sum, p) => sum + Number(p.price) * Number(p.quantity),
      0
    );

    const result = await pool.query(
      `INSERT INTO orders
       (user_id, full_name, phone, delivery_address, products, total_price, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING *`,
      [
        userId,
        fullName,
        phone,
        deliveryAddress,
        JSON.stringify(products),
        total,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET ALL ORDERS (Admin)
app.get("/api/orders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, user_id, full_name, phone, delivery_address,
             products, total_price, status, created_at
      FROM orders
      ORDER BY id DESC
    `);

    const orders = result.rows.map(o => ({
      ...o,
      products: typeof o.products === "string"
        ? JSON.parse(o.products)
        : o.products
    }));

    res.json(orders);
  } catch (err) {
    console.error("Admin get orders error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET USER ORDERS
app.get("/api/orders/user/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC",
      [req.params.userId]
    );

    const orders = result.rows.map(o => ({
      ...o,
      products: typeof o.products === "string"
        ? JSON.parse(o.products)
        : o.products
    }));

    res.json(orders);
  } catch (err) {
    console.error("User orders error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// UPDATE ORDER STATUS (Admin)
app.put("/api/orders/:id", async (req, res) => {
  try {
    const { status } = req.body;

    const result = await pool.query(
      "UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update order error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE ORDER (Admin)
app.delete("/api/orders/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM orders WHERE id=$1", [req.params.id]);
    res.json({ message: "Order deleted" });
  } catch (err) {
    console.error("Delete order error:", err);
    res.status(500).json({ message: "Server error" });
  }
});



app.get("/api/orders/user/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC",
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get user orders error:`, err);
    res.status(500).json({ message: "Server error" });
  }
});
// ---------- ABOUT IMAGES ----------
app.get("/api/about-images", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM about_images ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Get about images error:", err);
    res.status(500).json({ message: "Server error" });
  }
});
app.post("/api/about-images", upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ message: "No file uploaded" });

    // Upload to Supabase bucket: "about"
    const imageUrl = await uploadToSupabase(req.file, "about");

    if (!imageUrl)
      return res.status(500).json({ message: "Upload failed" });

    const result = await pool.query(
      "INSERT INTO about_images (image) VALUES ($1) RETURNING *",
      [imageUrl]
    );

    res.json(result.rows[0]);
    console.log("About image uploaded →", imageUrl);

  } catch (err) {
    console.error("About image upload error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.delete("/api/about-images/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM about_images WHERE id=$1", [
      req.params.id,
    ]);

    res.json({ message: "Deleted" });
    console.log("About image deleted ID:", req.params.id);
  } catch (err) {
    console.error("Delete about image error:", err);
    res.status(500).json({ message: "Server error" });
  }
});



app.get("/api/orders/:id/invoice", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "SELECT * FROM orders WHERE id=$1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = result.rows[0];

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Westlink-Invoice-${id}.pdf`
    );

    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ margin: 50 });

    doc.pipe(res);

    doc.fontSize(20).text("WESTLINK SUPERMARKET", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice #: ${order.id}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.text(`Customer: ${order.full_name}`);
    doc.text(`Phone: ${order.phone}`);
    doc.moveDown();

    const products =
      typeof order.products === "string"
        ? JSON.parse(order.products)
        : order.products;

    products.forEach((p, i) => {
      doc.text(
        `${i + 1}. ${p.name} × ${p.quantity} — ₦${Number(p.price).toLocaleString()}`
      );
    });

    doc.moveDown();
    doc.fontSize(14).text(
      `TOTAL: ₦${Number(order.total_price).toLocaleString()}`,
      { align: "right" }
    );

    doc.moveDown();
    doc.fontSize(10).text(
      "Thank you for shopping with Westlink Supermarket.",
      { align: "center" }
    );

    doc.end();
  } catch (err) {
    console.error("Invoice error:", err);
    res.status(500).end();
  }
});


// ---------- START ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} with PostgreSQL`));

app.get("/", (req, res) => {
  res.status(200).send("Westlink Backend is running 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});
