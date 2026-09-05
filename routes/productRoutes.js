const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const { verifyToken } = require("../middleware/auth");
const { requireCompany } = require("../middleware/tenant");

// GET ALL PRODUCTS
router.get("/", verifyToken, requireCompany, async (req, res) => {
  try {
    const products = await Product.find({ company_id: req.companyId }).lean();
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET SINGLE PRODUCT
router.get("/:id", verifyToken, requireCompany, async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      company_id: req.companyId,
    }).lean();
    if (!product) {
      return res.status(404).json({ error: "Product not found or unauthorized" });
    }
    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE PRODUCT
router.post("/", verifyToken, requireCompany, async (req, res) => {
  try {
    const { name, items } = req.body;

    if (!name || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Product name and at least one item are required",
      });
    }

    const trimmedName = String(name || "").trim();
    const existingProduct = await Product.findOne({
      company_id: req.companyId,
      name: trimmedName,
    }).lean();

    if (existingProduct) {
      return res.status(409).json({
        error: "This product name already exists in your company",
      });
    }

    const newProduct = new Product({
      name: trimmedName,
      items,
      company_id: req.companyId,
      createdBy: req.userId,
    });

    const saved = await newProduct.save();
    res.status(201).json(saved);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        error: "This product name already exists in your company",
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// UPDATE PRODUCT
router.put("/:id", verifyToken, requireCompany, async (req, res) => {
  try {
    const { name, items } = req.body;

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, company_id: req.companyId },
      {
        $set: { name, items, updatedAt: new Date() },
      },
      { returnDocument: "after", runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ error: "Product not found or unauthorized" });
    }

    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE PRODUCT
router.delete("/:id", verifyToken, requireCompany, async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({
      _id: req.params.id,
      company_id: req.companyId,
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found or unauthorized" });
    }

    res.status(200).json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
