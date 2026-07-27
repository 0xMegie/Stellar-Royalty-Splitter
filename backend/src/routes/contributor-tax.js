import { Router } from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import {
  getContributorTax,
  upsertContributorTax,
  getTaxComplianceReport,
  getContributorsMissingTaxInfo,
} from "../database/contributor-tax.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "..", "..", "uploads", "tax-documents");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".png", ".jpg", ".jpeg"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, PNG, and JPG files are allowed"));
    }
  },
});

export const contributorTaxRouter = Router();

contributorTaxRouter.get("/:walletAddress", (req, res) => {
  try {
    const taxInfo = getContributorTax(req.params.walletAddress);
    res.json({ success: true, data: taxInfo });
  } catch (err) {
    sendError(res, 500, "tax_fetch_error", err.message);
  }
});

contributorTaxRouter.post("/", (req, res) => {
  try {
    const { walletAddress, tax_status, tax_id } = req.body;
    if (!walletAddress) {
      return sendError(res, 400, "validation_error", "walletAddress is required");
    }
    if (!tax_status) {
      return sendError(res, 400, "validation_error", "tax_status is required");
    }
    const validStatuses = ["not_collected", "pending", "completed", "exempt"];
    if (!validStatuses.includes(tax_status)) {
      return sendError(res, 400, "validation_error", `tax_status must be one of: ${validStatuses.join(", ")}`);
    }
    const taxInfo = upsertContributorTax({ walletAddress, tax_status, tax_id });
    res.json({ success: true, data: taxInfo });
  } catch (err) {
    sendError(res, 500, "tax_save_error", err.message);
  }
});

contributorTaxRouter.post("/upload/:walletAddress", upload.single("taxDocument"), (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, "upload_error", "No file uploaded");
    }
    const taxInfo = upsertContributorTax({
      walletAddress: req.params.walletAddress,
      tax_status: "pending",
      w9_file_path: req.file.path,
      w9_file_name: req.file.originalname,
    });
    res.json({ success: true, data: taxInfo, file: { name: req.file.originalname, size: req.file.size } });
  } catch (err) {
    sendError(res, 500, "upload_error", err.message);
  }
});

contributorTaxRouter.get("/document/:walletAddress", (req, res) => {
  try {
    const taxInfo = getContributorTax(req.params.walletAddress);
    if (!taxInfo || !taxInfo.w9_file_path) {
      return sendError(res, 404, "document_not_found", "No tax document found");
    }
    if (!fs.existsSync(taxInfo.w9_file_path)) {
      return sendError(res, 404, "document_not_found", "Tax document file not found on disk");
    }
    res.download(taxInfo.w9_file_path, taxInfo.w9_file_name ?? "tax-document.pdf");
  } catch (err) {
    sendError(res, 500, "document_error", err.message);
  }
});

contributorTaxRouter.get("/report/compliance", requireRole("admin"), (_req, res) => {
  try {
    const report = getTaxComplianceReport();
    res.json({
      success: true,
      data: report,
      summary: {
        total: report.length,
        compliant: report.filter(r => r.compliance_status === 'compliant').length,
        nonCompliant: report.filter(r => r.compliance_status === 'non_compliant').length,
        missing: report.filter(r => r.compliance_status === 'missing').length,
      }
    });
  } catch (err) {
    sendError(res, 500, "report_error", err.message);
  }
});

contributorTaxRouter.get("/report/missing", requireRole("admin"), (_req, res) => {
  try {
    const missing = getContributorsMissingTaxInfo();
    res.json({ success: true, data: missing, count: missing.length });
  } catch (err) {
    sendError(res, 500, "report_error", err.message);
  }
});
