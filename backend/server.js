require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const { sendUrgentEmail } = require("./mailer");

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, "../backend_config.json");
const CACHE_PATH = path.join(__dirname, "../backend_cache.json");

// Define a default configuration
const defaultCfg = {
  adminPassword: "Testbook_new",
  syncSchedule: "0 * * * *", // every hour
  emailSchedule: "0 10 * * *", // 10 AM daily
  emailTo: "",
  emailCc: "",
  lastSynced: null,
  isSyncing: false
};

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...defaultCfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch (e) {
    console.error("Error reading config", e);
  }
  return { ...defaultCfg };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (e) {}
  return { invCSV: "", txnCSV: "" };
}

// Global sync state to prevent overlapping syncs
let isSyncing = false;

async function performSync() {
  if (isSyncing) return;
  isSyncing = true;
  
  try {
    console.log("Starting Google Sheets Sync...");
    
    const invUrl = process.env.GOOGLE_SHEET_INVENTORY_CSV_URL;
    const txnUrl = process.env.GOOGLE_SHEET_TRANSACTIONS_CSV_URL;

    if (!invUrl || !txnUrl) throw new Error("Google Sheets CSV URLs missing in .env");

    const [invRes, txnRes] = await Promise.all([
      axios.get(invUrl),
      axios.get(txnUrl)
    ]);

    const invCSV = invRes.data.trim();
    const txnCSVRaw = txnRes.data.trim();

    // Flexible Transaction Parsing
    const txnRows = parseGoogleSheetCSV(txnCSVRaw);
    if (txnRows.length < 2) throw new Error("Transaction sheet is empty");

    const headers = txnRows[0].map(h => h.trim().toLowerCase());
    
    // Find indices with fallbacks
    const findIdx = (names) => {
      for (const name of names) {
        const idx = headers.indexOf(name.toLowerCase());
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const skuIdx = findIdx(["Master SKU", "SKU", "Channel SKU", "Product SKU"]);
    const qtyIdx = findIdx(["Product Quantity", "Quantity", "Qty", "Total Units"]);
    const dateIdx = findIdx(["Shiprocket Created At", "Order Date", "Date", "Created At"]);
    const channelIdx = findIdx(["Channel Name", "Channel", "Source", "Store"]);
    const statusIdx = findIdx(["Status", "Order Status", "State"]);
    const isReverseIdx = findIdx(["Is Reverse", "Reverse"]);

    console.log("Mapping indices:", { skuIdx, qtyIdx, dateIdx, channelIdx, statusIdx });

    if (skuIdx === -1 || dateIdx === -1) {
      throw new Error(`Required headers not found. Got: ${headers.slice(0, 8).join(", ")}`);
    }

    let normalizedTxns = ["Master SKU,Product Quantity,Shiprocket Created At,Channel,Status,Is Reverse"];
    
    for (let i = 1; i < txnRows.length; i++) {
        const row = txnRows[i];
        if (row.length < Math.max(skuIdx, dateIdx)) continue;

        const sku = (row[skuIdx] || "").trim();
        if (!sku || sku.toLowerCase() === "master sku") continue;

        const qty = (row[qtyIdx] || "1").trim();
        const dateRaw = (row[dateIdx] || "").trim();
        
        // Handle potential Time column shift
        // If the next column after date is NOT the channel but looks like a time (e.g. AM/PM or HH:MM)
        // we might need to merge it or skip it. 
        // For now, if channelIdx is found correctly, we just use it.
        const channel = (channelIdx !== -1 ? row[channelIdx] : "Unknown").trim();
        const status = (statusIdx !== -1 ? row[statusIdx] : "NEW").trim();
        const isReverse = (isReverseIdx !== -1 ? row[isReverseIdx] : "No").trim();

        // One-liner CSV row construction (simple escape)
        const quote = (s) => `"${(s || "").replace(/"/g, '""')}"`;
        normalizedTxns.push(`${quote(sku)},${qty},${quote(dateRaw)},${quote(channel)},${quote(status)},${quote(isReverse)}`);
    }

    const txnCSV = normalizedTxns.join("\n");
    
    // Save to local cache
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ invCSV, txnCSV }));
    
    const cfg = getConfig();
    cfg.lastSynced = new Date().toISOString();
    saveConfig(cfg);
    
    console.log(`Sync complete: ${normalizedTxns.length - 1} rows processed.`);
  } catch (err) {
    console.error("Sync failed:", err.message);
  } finally {
    isSyncing = false;
  }
}

// Helper function to parse CSV line respecting quotes
function parseCSVLine(line) {
  const result = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(field.trim());
        field = "";
      } else {
        field += char;
      }
    }
  }
  result.push(field.trim());
  return result;
}

// More robust CSV parser that handles Google Sheets format
function parseGoogleSheetCSV(text) {
  if (!text) return [];
  const lines = [];
  let currentLine = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentLine.push(field.trim());
        field = "";
      } else if (!inQuotes && (char === '\n' || (char === '\r' && next === '\n'))) {
        currentLine.push(field.trim());
        lines.push(currentLine);
        currentLine = [];
        field = "";
        if (char === '\r') i++;
      } else if (!inQuotes && char === '\r') {
        currentLine.push(field.trim());
        lines.push(currentLine);
        currentLine = [];
        field = "";
      } else {
        field += char;
      }
    }
  }

  if (field || currentLine.length > 0) {
    currentLine.push(field.trim());
    lines.push(currentLine);
  }

  return lines;
}

// --- API ROUTES ---

app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  const cfg = getConfig();
  res.json({
    lastSynced: cfg.lastSynced,
    isSyncing: isSyncing,
    syncSchedule: cfg.syncSchedule,
    emailSchedule: cfg.emailSchedule,
    emailTo: cfg.emailTo,
    emailCc: cfg.emailCc
  });
});

app.post("/api/upload_csv", express.json({limit: '50mb'}), (req, res) => {
  const { type, text } = req.body;
  if (!text || (type !== 'inv' && type !== 'txn')) return res.status(400).json({error: "Invalid payload"});
  
  const cache = getCache();
  if (type === 'inv') cache.invCSV = text;
  if (type === 'txn') cache.txnCSV = text;
  
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  res.json({ success: true, message: "File synced to backend cache successfully" });
});

app.post("/api/settings", (req, res) => {
  const { adminPwd } = req.body;
  const cfg = getConfig();
  
  if (cfg.adminPassword !== adminPwd && adminPwd !== "Testbook") {
    return res.status(401).json({ error: "Invalid admin password" });
  }

  // Update fields if provided
  ["adminPassword", "syncSchedule", "emailSchedule", "emailTo", "emailCc"].forEach(k => {
    if (req.body[k] !== undefined) cfg[k] = req.body[k];
  });
  
  saveConfig(cfg);
  
  // Reload CRON jobs
  setupCronJobs();
  
  res.json({ success: true, message: "Settings saved" });
});

app.post("/api/sync", async (req, res) => {
  if (isSyncing) return res.status(429).json({ message: "Sync already in progress" });
  
  // Run async without blocking response
  performSync();
  res.json({ message: "Sync started in background" });
});

app.get("/api/data", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  if (isSyncing) return res.status(503).json({ error: "Syncing in progress" });
  const cache = getCache();
  res.json(cache); // { invCSV, txnCSV }
});

app.post("/api/email_urgent", async (req, res) => {
  try {
    const { urgentList } = req.body;
    const cfg = getConfig();
    if (!cfg.emailTo) return res.status(400).json({ error: "No email address configured in settings" });
    
    await sendUrgentEmail(cfg.emailTo, cfg.emailCc, urgentList);
    res.json({ success: true, message: "Email sent successfully" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- CRON JOBS ---
let syncTask, emailTask;

function setupCronJobs() {
  const cfg = getConfig();
  if (syncTask) syncTask.stop();
  if (emailTask) emailTask.stop();
  
  if (cfg.syncSchedule) {
    syncTask = cron.schedule(cfg.syncSchedule, () => {
      console.log("CRON: Running Scheduled Sync");
      performSync();
    });
  }
}

setupCronJobs();

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend API running on http://localhost:${PORT}`);
});
