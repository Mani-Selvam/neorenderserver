const express = require("express");
const mongoose = require("mongoose");
const Company = require("../models/Company");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const {
    sendNeoEnquiryTemplateMessage,
} = require("../utils/enquiryTemplateService");

const router = express.Router();

const submitRateMap = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMITS_PER_WINDOW = 10;

const cleanText = (value, max = 200) =>
    String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, max);

const sanitizeHtml = (value) =>
    String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const toIsoDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
};

const normalizeMobile = (value) =>
    String(value || "")
        .replace(/\D/g, "")
        .slice(0, 15);

const generateEnquiryNumber = async (companyId) => {
    const latestEnquiry = await Enquiry.findOne(
        companyId ? { companyId } : {},
        {
            enqNo: 1,
        },
    )
        .sort({ createdAt: -1 })
        .lean();

    let nextNumber = 1;
    if (latestEnquiry?.enqNo) {
        const match = String(latestEnquiry.enqNo).match(/\d+/);
        if (match) {
            nextNumber = Number.parseInt(match[0], 10) + 1;
        }
    }
    return `ENQ-${String(nextNumber).padStart(3, "0")}`;
};

const resolvePublicBaseUrl = (req) => {
    const explicitBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim();
    if (explicitBaseUrl) {
        return explicitBaseUrl.replace(/\/+$/, "");
    }
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim();
    const protocol = forwardedProto || req.protocol || "https";
    return `${protocol}://${req.get("host")}`;
};

const buildPublicFormUrl = (req, slug) => {
    return `${resolvePublicBaseUrl(req)}/public/forms/${encodeURIComponent(slug)}`;
};

const getClientKey = (req, slug) =>
    `${slug}:${req.ip || req.headers["x-forwarded-for"] || "unknown"}`;

const checkRateLimit = (req, slug) => {
    const key = getClientKey(req, slug);
    const now = Date.now();
    const current = submitRateMap.get(key) || [];
    const next = current.filter(
        (timestamp) => now - timestamp < RATE_WINDOW_MS,
    );
    if (next.length >= MAX_SUBMITS_PER_WINDOW) {
        return false;
    }
    next.push(now);
    submitRateMap.set(key, next);
    return true;
};

const getCompanyPublicForm = async (slug) =>
    Company.findOne({
        status: "Active",
        "publicForm.enabled": true,
        "publicForm.slug": String(slug || "")
            .trim()
            .toLowerCase(),
    })
        .select("name logo publicForm")
        .lean();

const resolveOwnerAndAssignee = async (companyId) => {
    const admins = await User.find({
        company_id: companyId,
        status: "Active",
        role: { $in: ["Admin", "admin"] },
    })
        .sort({ createdAt: 1, _id: 1 })
        .select("_id name")
        .lean();

    const owner = admins[0] || null;
    return {
        ownerId: owner?._id || null,
        ownerName: owner?.name || "Public Form",
        assignedTo: null,
    };
};

const emitEnquiryCreated = async (req, enquiry, companyId) => {
    try {
        const io = req.app?.get("io");
        if (!io || !enquiry || !companyId) return;

        const companyUsers = await User.find({ company_id: companyId })
            .select("_id")
            .lean();

        companyUsers.forEach((member) => {
            const userId = String(member?._id || "");
            if (!userId) return;
            io.to(`user:${userId}`).emit("ENQUIRY_CREATED", {
                _id: enquiry._id,
                enqNo: enquiry.enqNo,
                assignedTo: enquiry.assignedTo,
                userId: enquiry.userId,
                companyId: String(companyId),
            });
        });
    } catch (_error) {
        // ignore socket fanout issues for public submissions
    }
};

const renderFormPage = ({ company, url }) => {
    const title = sanitizeHtml(
        company?.publicForm?.title ||
            `${company?.name || "Company"} Enquiry Form`,
    );
    const description = sanitizeHtml(
        company?.publicForm?.description ||
            "Fill out this form and our team will contact you shortly.",
    );
    const successMessage = sanitizeHtml(
        company?.publicForm?.successMessage ||
            "Thanks for your enquiry. Our team will contact you soon.",
    );
    const companyName = sanitizeHtml(company?.name || "NeoApp");
    const logo = company?.logo ? sanitizeHtml(company.logo) : "";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { 
      --primary: #6366f1;
      --primary-dark: #4f46e5;
      --accent: #8b5cf6;
      --bg-main: #0f172a;
      --text-main: #1e293b;
      --text-muted: #64748b;
      --surface: rgba(255, 255, 255, 0.96);
    }

    * { box-sizing: border-box; }
    
    body { 
      margin: 0; 
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg-main);
      /* Trending Mesh Gradient Background */
      background-image: 
        radial-gradient(at 0% 0%, hsla(280, 70%, 55%, 0.3) 0px, transparent 50%), 
        radial-gradient(at 100% 100%, hsla(220, 80%, 55%, 0.3) 0px, transparent 50%), 
        radial-gradient(at 50% 50%, hsla(240, 60%, 40%, 0.2) 0px, transparent 50%); 
      color: var(--text-main); 
      min-height: 100vh;
    } 

    .shell { 
      min-height: 100vh; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      padding: 24px; 
    } 

    .card { 
      width: 100%; 
      max-width: 480px; 
      background: var(--surface);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 24px; 
      padding: 40px; 
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(20px);
      position: relative;
      overflow: hidden;
    }

    /* Decorative Top Bar */
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 4px;
      background: linear-gradient(90deg, var(--primary), var(--accent));
    }

    .brand { 
      display: flex; 
      flex-direction: column;
      align-items: center;
      gap: 16px; 
      margin-bottom: 32px; 
      text-align: center;
    } 

    .logo-wrapper {
      width: 64px; height: 64px;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      padding: 3px;
      box-shadow: 0 10px 20px -5px rgba(99, 102, 241, 0.4);
    }

    .logo { 
      width: 100%; height: 100%;
      border-radius: 13px; 
      object-fit: cover; 
      background: #fff;
    } 

    .logo-fallback { 
      width: 100%; height: 100%;
      border-radius: 13px; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      background: #fff;
      color: var(--primary); 
      font-weight: 800; 
      font-size: 26px; 
    } 

    h1 { 
      margin: 0; 
      font-size: 26px; 
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #0f172a;
    } 

    p { 
      margin: 4px 0 0; 
      color: var(--text-muted); 
      line-height: 1.5; 
      font-size: 14px;
    } 

    .grid { 
      display: grid; 
      gap: 20px; 
      margin-top: 8px; 
    } 

    label { 
      display: block;
      font-size: 12px; 
      font-weight: 600; 
      color: var(--text-muted); 
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    } 

    /* Input Container for Icons */
    .input-group {
      position: relative;
    }

    .input-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      color: #cbd5e1;
      pointer-events: none;
      transition: color 0.2s ease;
    }

    input, textarea { 
      width: 100%; 
      border: 1.5px solid #e2e8f0; 
      border-radius: 12px; 
      padding: 14px 14px 14px 44px; /* Padding left for icon */
      font-size: 15px; 
      font-family: inherit;
      color: #0f172a;
      background: #f8fafc;
      outline: none; 
      transition: all 0.2s ease; 
    } 

    textarea { 
      min-height: 100px; 
      resize: vertical;
      padding-left: 14px; /* No icon for textarea */
    } 

    input:focus, textarea:focus { 
      border-color: var(--primary); 
      background: #fff;
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1); 
    } 

    input:focus ~ .input-icon {
      color: var(--primary);
    }

    button { 
      border: 0; 
      width: 100%; 
      border-radius: 12px; 
      padding: 16px 18px; 
      font-size: 15px; 
      font-weight: 600; 
      cursor: pointer; 
      color: #fff; 
      background: linear-gradient(135deg, var(--primary), var(--accent)); 
      box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.4);
      transition: transform 0.2s, box-shadow 0.2s;
      margin-top: 8px;
    } 

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 20px -3px rgba(99, 102, 241, 0.5);
    }

    button:active {
      transform: translateY(0);
    }

    button:disabled { 
      opacity: 0.7; 
      cursor: wait; 
      transform: none;
    } 

    .meta { 
      margin-top: 24px; 
      font-size: 12px; 
      color: #94a3b8; 
      text-align: center; 
    } 

    .status { 
      display: none; 
      margin-top: 20px; 
      padding: 14px 16px; 
      border-radius: 12px; 
      font-size: 14px; 
      text-align: center;
      font-weight: 500;
    } 

    .status.show { display: block; animation: fadeSlide 0.3s ease; } 
    .status.ok { background: #ecfdf5; color: #059669; border: 1px solid #d1fae5; } 
    .status.err { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; } 
    .hidden { display: none; } 

    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 640px) {
      .card { padding: 24px; box-shadow: none; border: none; background: #fff; }
      body { background-image: none; background-color: #f8fafc; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="brand">
        <div class="logo-wrapper">
          ${logo ? `<img class="logo" src="${logo}" alt="${companyName}" />` : `<div class="logo-fallback">${companyName.slice(0, 1) || "N"}</div>`}
        </div>
        <div>
          <h1>${title}</h1>
          <p>${description}</p>
        </div>
      </div>

      <form id="lead-form" class="grid">
        <div>
          <label>Name</label>
          <div class="input-group">
            <input name="name" type="text" maxlength="80" required placeholder="Enter your name" />
            <svg class="input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
        </div>

        <div>
          <label>Mobile</label>
          <div class="input-group">
            <input name="mobile" type="tel" maxlength="15" required placeholder="Enter your mobile number" />
            <svg class="input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </div>
        </div>

        <div>
          <label>Email</label>
          <div class="input-group">
            <input name="email" type="email" maxlength="120" placeholder="Enter your email" />
            <svg class="input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
        </div>

        <div>
          <label>Product / Requirement</label>
          <div class="input-group">
            <input name="product" type="text" maxlength="120" required placeholder="What are you interested in?" />
            <svg class="input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
          </div>
        </div>

        <div>
          <label>Address</label>
          <textarea name="address" maxlength="500" placeholder="Tell us your address"></textarea>
        </div>

        <input class="hidden" type="text" name="website" autocomplete="off" tabindex="-1" />
        <button type="submit" id="submit-btn">Submit Enquiry</button>
      </form>

      <div id="status" class="status"></div>
      <div class="meta">Powered by ${companyName}</div>
    </div>
  </div>
  <script>
    const form = document.getElementById("lead-form");
    const status = document.getElementById("status");
    const submitBtn = document.getElementById("submit-btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.className = "status";
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const res = await fetch(${JSON.stringify(url + "/submit")}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const raw = await res.text();
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (_error) {
          throw new Error(
            "Server returned HTML instead of JSON. Check the hosted public form POST route."
          );
        }
        if (!res.ok) throw new Error(data.message || "Unable to submit form");
        form.reset();
        status.textContent = data.message || ${JSON.stringify(successMessage)};
        status.className = "status show ok";
      } catch (error) {
        status.textContent = error.message || "Unable to submit form";
        status.className = "status show err";
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Enquiry";
      }
    });
  </script>
</body>
</html>`;
};

router.get("/plans", async (req, res) => {
    try {
        const Plan = require("../models/Plan");
        const plans = await Plan.find({ isActive: true }).select("_id name code basePrice extraAdminPrice extraStaffPrice trialDays maxAdmins maxStaff features").lean();
        res.json({ success: true, plans });
    } catch (error) {
        console.error("Error fetching public plans:", error);
        res.status(500).json({ success: false, message: "Failed to fetch plans" });
    }
});

router.get("/:slug/config", async (req, res) => {
    try {
        const company = await getCompanyPublicForm(req.params.slug);
        if (!company) {
            return res.status(404).json({ message: "Form not found" });
        }

        return res.json({
            success: true,
            form: {
                companyName: company.name,
                title: company.publicForm?.title,
                description: company.publicForm?.description,
                successMessage: company.publicForm?.successMessage,
                defaultSource:
                    company.publicForm?.defaultSource || "Public Form",
                url: buildPublicFormUrl(req, company.publicForm?.slug),
            },
        });
    } catch (error) {
        return res
            .status(500)
            .json({ message: error.message || "Failed to load form" });
    }
});

router.get("/:slug", async (req, res) => {
    try {
        const company = await getCompanyPublicForm(req.params.slug);
        if (!company) {
            return res.status(404).send("Form not found");
        }

        return res
            .status(200)
            .set("Content-Type", "text/html; charset=utf-8")
            .send(
                renderFormPage({
                    company,
                    url: buildPublicFormUrl(req, company.publicForm?.slug),
                }),
            );
    } catch (_error) {
        return res.status(500).send("Failed to load form");
    }
});

router.post("/:slug/submit", async (req, res) => {
    try {
        const slug = String(req.params.slug || "")
            .trim()
            .toLowerCase();
        if (!checkRateLimit(req, slug)) {
            return res
                .status(429)
                .json({
                    message: "Too many submissions. Please try again later.",
                });
        }

        const company = await getCompanyPublicForm(slug);
        if (!company?._id) {
            return res.status(404).json({ message: "Form not found" });
        }

        if (cleanText(req.body?.website, 120)) {
            return res.status(400).json({ message: "Invalid submission" });
        }

        const name = cleanText(req.body?.name, 80);
        const mobile = normalizeMobile(req.body?.mobile);
        const email = cleanText(req.body?.email, 120).toLowerCase();
        const product = cleanText(req.body?.product, 120);
        const address = cleanText(req.body?.address, 500);
        const source = cleanText(
            req.body?.source ||
                company.publicForm?.defaultSource ||
                "Public Form",
            80,
        );

        if (!name || name.length < 2) {
            return res
                .status(400)
                .json({ message: "Please enter a valid name." });
        }
        if (!/^\d{8,15}$/.test(mobile)) {
            return res
                .status(400)
                .json({ message: "Please enter a valid mobile number." });
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res
                .status(400)
                .json({ message: "Please enter a valid email address." });
        }
        if (!product || product.length < 2) {
            return res
                .status(400)
                .json({ message: "Please enter your product or requirement." });
        }

        const companyId = company._id;
        const { ownerId, ownerName, assignedTo } =
            await resolveOwnerAndAssignee(companyId);
        if (!ownerId || !mongoose.Types.ObjectId.isValid(String(ownerId))) {
            return res
                .status(400)
                .json({
                    message: "This form is not ready for submissions yet.",
                });
        }

        let savedEnquiry = null;
        const enquiryDateTime = new Date();
        const basePayload = {
            companyId,
            userId: ownerId,
            assignedTo,
            enqBy: "Public Form",
            enqType: "Normal",
            source,
            name,
            mobile,
            email,
            address,
            product,
            cost: 0,
            date:
                toIsoDate(enquiryDateTime) ||
                new Date().toISOString().slice(0, 10),
            enquiryDateTime,
            status: "New",
        };

        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                savedEnquiry = await new Enquiry({
                    enqNo: await generateEnquiryNumber(companyId),
                    ...basePayload,
                }).save();
                break;
            } catch (error) {
                if (error?.code !== 11000) throw error;
            }
        }

        if (!savedEnquiry) {
            savedEnquiry = await new Enquiry({
                enqNo: `ENQ-${Date.now().toString().slice(-6)}`,
                ...basePayload,
            }).save();
        }

        await emitEnquiryCreated(req, savedEnquiry, companyId);

        const companyName = String(company.name || "").trim() || "Your Company";
        const customerName =
            String(savedEnquiry.name || "").trim() || "Customer";
        const productName = String(savedEnquiry.product || "").trim() || "-";
        sendNeoEnquiryTemplateMessage({
            phoneNumber: savedEnquiry.mobile,
            customerName,
            productName,
            companyName,
            companyId,
        }).catch((error) => {
            console.warn(
                "[WhatsApp][EnquiryTemplate] Public form send failed:",
                error?.message || error,
            );
        });

        return res.status(201).json({
            success: true,
            message:
                company.publicForm?.successMessage ||
                "Thanks for your enquiry. Our team will contact you soon.",
            enquiryId: savedEnquiry._id,
            enqNo: savedEnquiry.enqNo,
            assignedTo,
            ownerName,
        });
    } catch (error) {
        return res
            .status(500)
            .json({ message: error.message || "Failed to submit form" });
    }
});



module.exports = router;
