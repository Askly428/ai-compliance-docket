// AI Compliance Docket — backend
// Zero external dependencies: uses only Node.js built-ins (http, node:sqlite, crypto).
// Requires Node.js >= 22.5 (node:sqlite).

const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "compliance.db");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genai INTEGER DEFAULT 1,
  genai1m INTEGER DEFAULT 1,
  frontier INTEGER DEFAULT 0,
  admt INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT DEFAULT 'owner',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS regulations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  citation TEXT,
  effective_date TEXT NOT NULL,
  penalty TEXT,
  summary TEXT,
  applies_if TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  regulation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status (
  company_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  checked INTEGER DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT,
  PRIMARY KEY (company_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
`);

// ---------- seed regulations (idempotent) ----------
const REGULATIONS = [
  {
    id: "sb942",
    code: "SB 942",
    name: "California AI Transparency Act",
    citation: "Cal. Bus. & Prof. Code §22757",
    effective_date: "2026-08-02",
    penalty: "$5,000 per violation, per day",
    summary:
      "Covers generative AI providers with over 1,000,000 monthly California users. Requires provenance watermarking and public detection tools for AI-generated images, video, and audio.",
    applies_if: "genai1m",
    requirements: [
      "Free, publicly accessible AI content detection tool is live",
      "Manifest disclosure option offered on all AI-generated image, video, and audio output",
      "Latent, C2PA-compatible provenance watermark embedded in generated media",
      "Downstream licensee contracts updated to require disclosure compliance",
    ],
  },
  {
    id: "ab2013",
    code: "AB 2013",
    name: "Training Data Transparency Act",
    citation: "Cal. Bus. & Prof. Code §22656",
    effective_date: "2026-01-01",
    penalty: "Enforced via CA Attorney General civil action",
    summary:
      "Applies to any GenAI system released or substantially modified on or after January 1, 2022. Requires public documentation summarizing training datasets.",
    applies_if: "genai",
    requirements: [
      "Public high-level summary of training datasets published",
      "Disclosure of whether datasets include copyrighted material",
      "Disclosure of whether datasets include personal information",
      "Documentation covers all models released or modified since Jan 1, 2022",
    ],
  },
  {
    id: "sb53",
    code: "SB 53",
    name: "Frontier AI Safety & Transparency Act",
    citation: "Cal. Gov. Code §11547.6",
    effective_date: "2026-01-01",
    penalty: "Civil penalty via CA Attorney General",
    summary:
      "Applies to frontier model developers above the statutory compute threshold. Requires published safety frameworks and incident reporting.",
    applies_if: "frontier",
    requirements: [
      "Frontier safety framework published and current",
      "Critical safety incident reporting process in place",
      "Internal whistleblower protections documented",
    ],
  },
  {
    id: "admt",
    code: "CPPA ADMT",
    name: "Automated Decision-Making Technology Regs",
    citation: "Cal. Code Regs. tit. 11, §7220 et seq.",
    effective_date: "2026-01-01",
    penalty: "Enforced via CPPA administrative action",
    summary:
      "Applies to any business using computation to replace or substantially replace human decision-making on a significant decision about a consumer.",
    applies_if: "admt",
    requirements: [
      "Pre-use notice delivered before ADMT is applied to a significant decision",
      "Consumer opt-out mechanism implemented",
      "Consumer appeal path to human review implemented",
      "Risk assessment completed and on file",
    ],
  },
];

const WATCHING = [
  { code: "CO SB 24-205", name: "Colorado AI Act", note: "High-risk AI consequential-decision disclosures" },
  { code: "NY S8828", name: "New York frontier model reporting", note: "Transparency reporting for frontier developers" },
  { code: "WA HB 1170", name: "Washington AI disclosure law", note: "Effective Feb 2026 — AI-generated content disclosure" },
];

const insertReg = db.prepare(
  `INSERT OR IGNORE INTO regulations (id, code, name, citation, effective_date, penalty, summary, applies_if) VALUES (?,?,?,?,?,?,?,?)`
);
const insertReq = db.prepare(
  `INSERT OR IGNORE INTO requirements (id, regulation_id, text, sort_order) VALUES (?,?,?,?)`
);
for (const reg of REGULATIONS) {
  insertReg.run(reg.id, reg.code, reg.name, reg.citation, reg.effective_date, reg.penalty, reg.summary, reg.applies_if);
  reg.requirements.forEach((text, i) => {
    insertReq.run(`${reg.id}-${i + 1}`, reg.id, text, i);
  });
}

// ---------- helpers ----------
function uid() {
  return crypto.randomBytes(12).toString("hex");
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function getSessionUser(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!row || row.expires_at < Date.now()) return null;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id);
  return user || null;
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJSON(res, 401, { error: "Not authenticated" });
    return null;
  }
  return user;
}

function computeDashboard(companyId) {
  const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(companyId);
  const regs = db.prepare(`SELECT * FROM regulations`).all();
  const today = new Date();
  const result = [];
  let scoreSum = 0;
  let applicableCount = 0;

  for (const reg of regs) {
    const applies = !!company[reg.applies_if];
    const reqs = db
      .prepare(`SELECT * FROM requirements WHERE regulation_id = ? ORDER BY sort_order`)
      .all(reg.id);
    const statuses = reqs.map((r) => {
      const s = db
        .prepare(`SELECT checked FROM status WHERE company_id = ? AND requirement_id = ?`)
        .get(companyId, r.id);
      return { id: r.id, text: r.text, checked: !!(s && s.checked) };
    });
    const done = statuses.filter((s) => s.checked).length;
    const total = statuses.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const daysUntil = Math.round((new Date(reg.effective_date) - today) / 86400000);
    let status = "risk";
    if (done === total) status = "compliant";
    else if (daysUntil < 0) status = "overdue";
    if (!applies) status = "not-applicable";

    if (applies) {
      scoreSum += pct;
      applicableCount++;
    }

    result.push({
      id: reg.id,
      code: reg.code,
      name: reg.name,
      citation: reg.citation,
      effective_date: reg.effective_date,
      penalty: reg.penalty,
      summary: reg.summary,
      applies,
      daysUntil,
      status,
      pct,
      requirements: statuses,
    });
  }

  return {
    company: { id: company.id, name: company.name, genai: !!company.genai, genai1m: !!company.genai1m, frontier: !!company.frontier, admt: !!company.admt },
    overallScore: applicableCount ? Math.round(scoreSum / applicableCount) : 0,
    regulations: result,
    watching: WATCHING,
  };
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // ---- AUTH ----
    if (pathname === "/api/auth/signup" && req.method === "POST") {
      const { companyName, email, password } = await parseBody(req);
      if (!companyName || !email || !password || password.length < 8) {
        return sendJSON(res, 400, { error: "companyName, email, and password (8+ chars) are required" });
      }
      const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase());
      if (existing) return sendJSON(res, 409, { error: "An account with that email already exists" });

      const companyId = uid();
      db.prepare(`INSERT INTO companies (id, name, created_at) VALUES (?,?,?)`).run(
        companyId,
        companyName,
        new Date().toISOString()
      );
      const salt = crypto.randomBytes(16).toString("hex");
      const userId = uid();
      db.prepare(
        `INSERT INTO users (id, company_id, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?)`
      ).run(userId, companyId, email.toLowerCase(), hashPassword(password, salt), salt, "owner", new Date().toISOString());

      const token = crypto.randomBytes(32).toString("hex");
      db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`).run(
        token,
        userId,
        Date.now() + SESSION_TTL_MS
      );
      return sendJSON(res, 201, { token, user: { id: userId, email: email.toLowerCase(), companyId, companyName } });
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      const { email, password } = await parseBody(req);
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get((email || "").toLowerCase());
      if (!user) return sendJSON(res, 401, { error: "Invalid email or password" });
      const hash = hashPassword(password || "", user.salt);
      if (hash !== user.password_hash) return sendJSON(res, 401, { error: "Invalid email or password" });

      const token = crypto.randomBytes(32).toString("hex");
      db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`).run(
        token,
        user.id,
        Date.now() + SESSION_TTL_MS
      );
      const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(user.company_id);
      return sendJSON(res, 200, { token, user: { id: user.id, email: user.email, companyId: company.id, companyName: company.name } });
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const user = requireAuth(req, res);
      if (!user) return;
      const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(user.company_id);
      return sendJSON(res, 200, { id: user.id, email: user.email, companyId: company.id, companyName: company.name });
    }

    // ---- DASHBOARD ----
    if (pathname === "/api/dashboard" && req.method === "GET") {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJSON(res, 200, computeDashboard(user.company_id));
    }

    // ---- COMPANY PROFILE ----
    if (pathname === "/api/company/profile" && req.method === "PATCH") {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const fields = ["genai", "genai1m", "frontier", "admt"];
      const updates = [];
      const params = [];
      for (const f of fields) {
        if (typeof body[f] === "boolean") {
          updates.push(`${f} = ?`);
          params.push(body[f] ? 1 : 0);
        }
      }
      if (updates.length) {
        params.push(user.company_id);
        db.prepare(`UPDATE companies SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      }
      return sendJSON(res, 200, computeDashboard(user.company_id));
    }

    // ---- REQUIREMENT TOGGLE ----
    const reqMatch = pathname.match(/^\/api\/requirements\/([\w-]+)$/);
    if (reqMatch && req.method === "PATCH") {
      const user = requireAuth(req, res);
      if (!user) return;
      const requirementId = reqMatch[1];
      const reqRow = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(requirementId);
      if (!reqRow) return sendJSON(res, 404, { error: "Requirement not found" });
      const { checked } = await parseBody(req);

      db.prepare(
        `INSERT INTO status (company_id, requirement_id, checked, updated_at, updated_by)
         VALUES (?,?,?,?,?)
         ON CONFLICT(company_id, requirement_id) DO UPDATE SET checked = excluded.checked, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).run(user.company_id, requirementId, checked ? 1 : 0, new Date().toISOString(), user.email);

      db.prepare(
        `INSERT INTO audit_log (company_id, user_email, requirement_id, action, timestamp) VALUES (?,?,?,?,?)`
      ).run(user.company_id, user.email, requirementId, checked ? "checked" : "unchecked", new Date().toISOString());

      return sendJSON(res, 200, computeDashboard(user.company_id));
    }

    // ---- AUDIT LOG ----
    if (pathname === "/api/audit-log" && req.method === "GET") {
      const user = requireAuth(req, res);
      if (!user) return;
      const rows = db
        .prepare(`SELECT * FROM audit_log WHERE company_id = ? ORDER BY id DESC LIMIT 100`)
        .all(user.company_id);
      return sendJSON(res, 200, rows);
    }

    // ---- REPORT ----
    if (pathname === "/api/report" && req.method === "GET") {
      const user = requireAuth(req, res);
      if (!user) return;
      const dash = computeDashboard(user.company_id);
      const lines = [];
      lines.push(`COMPLIANCE DOCKET — ${dash.company.name}`);
      lines.push(`Generated ${new Date().toDateString()}`);
      lines.push(`Overall readiness: ${dash.overallScore}%`);
      lines.push("");
      dash.regulations.filter((r) => r.applies).forEach((reg) => {
        lines.push(`${reg.code} — ${reg.name} [${reg.status.toUpperCase()}]`);
        reg.requirements.forEach((r) => lines.push(`  [${r.checked ? "x" : " "}] ${r.text}`));
        lines.push("");
      });
      lines.push("---");
      lines.push("This report tracks self-reported checklist progress and does not constitute legal advice.");
      lines.push("It is not a substitute for review by a licensed attorney. Consult qualified counsel to");
      lines.push("confirm your obligations under applicable law.");
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end(lines.join("\n"));
    }

    // ---- STATIC FILES ----
    if (req.method === "GET") {
      let filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = path.join(PUBLIC_DIR, filePath);
      if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath);
        const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
        res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
        return res.end(fs.readFileSync(fullPath));
      }
      // SPA fallback
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(fs.readFileSync(indexPath));
      }
    }

    sendJSON(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Compliance Docket API + app running on http://localhost:${PORT}`);
});
