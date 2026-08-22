const API = "";
const app = document.getElementById("app");

let state = {
  token: localStorage.getItem("token") || null,
  user: null,
  dashboard: null,
  expanded: null,
  view: "login", // login | signup | dashboard
  error: null,
  reportOpen: false,
  auditLog: null,
};

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired — please sign in again");
  }
  const isText = res.headers.get("content-type")?.includes("text/plain");
  const data = isText ? await res.text() : await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function logout() {
  state.token = null;
  state.user = null;
  state.dashboard = null;
  localStorage.removeItem("token");
  state.view = "login";
  render();
}

async function loadDashboard() {
  state.dashboard = await api("/api/dashboard");
  render();
}

function daysLabel(d) {
  return d >= 0 ? `${d} days out` : `${Math.abs(d)} days overdue`;
}

function statusClass(s) {
  return { compliant: "stamp-compliant", risk: "stamp-risk", overdue: "stamp-overdue", "not-applicable": "stamp-na" }[s];
}
function statusLabel(s) {
  return { compliant: "Compliant", risk: "At Risk", overdue: "Overdue", "not-applicable": "N/A" }[s];
}
function barColor(s) {
  return { compliant: "var(--green)", overdue: "var(--red)", risk: "var(--brass)", "not-applicable": "var(--slate)" }[s];
}

function render() {
  if (state.view === "login" || state.view === "signup") return renderAuth();
  return renderDashboard();
}

function renderAuth() {
  const isSignup = state.view === "signup";
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <p class="eyebrow">${isSignup ? "Create Account" : "Sign In"}</p>
        <h1>AI Compliance Docket</h1>
        <p style="font-size:13px;color:var(--slate);margin-top:0;">Track California AI regulatory obligations across your company.</p>
        <form id="auth-form">
          ${isSignup ? `<div class="field"><label>Company name</label><input name="companyName" required /></div>` : ""}
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password</label><input name="password" type="password" required minlength="8" /></div>
          <button class="btn-primary" type="submit">${isSignup ? "Create account" : "Sign in"}</button>
        </form>
        ${state.error ? `<div class="error-msg">${state.error}</div>` : ""}
        <div class="switch-link">
          ${isSignup ? `Already have an account? <a id="switch">Sign in</a>` : `New here? <a id="switch">Create an account</a>`}
        </div>
      </div>
    </div>
  `;
  document.getElementById("switch").onclick = () => {
    state.view = isSignup ? "login" : "signup";
    state.error = null;
    render();
  };
  document.getElementById("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      const data = await api(isSignup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      });
      state.token = data.token;
      localStorage.setItem("token", data.token);
      state.user = data.user;
      state.view = "dashboard";
      state.error = null;
      await loadDashboard();
    } catch (err) {
      state.error = err.message;
      render();
    }
  };
}

function renderDashboard() {
  if (!state.dashboard) {
    app.innerHTML = `<div style="padding:40px;text-align:center;color:var(--slate-light)">Loading docket…</div>`;
    return;
  }
  const d = state.dashboard;
  app.innerHTML = `
    <div class="header">
      <div class="header-inner">
        <div class="topbar">
          <p class="eyebrow" style="color:var(--brass)">Docket No. AI-CA-2026 · ${d.company.name}</p>
          <span class="signout" id="signout">Sign out</span>
        </div>
        <h1 class="title">California AI Statute Docket</h1>
        <p class="subtitle">Track disclosure, watermarking, and safety obligations under active California AI law. Every change here is written to an audit trail.</p>
      </div>
    </div>
    <div class="page-inner page">
      <div class="profile-card">
        <div>
          <span class="eyebrow">Company Profile</span>
          ${["genai:We build or operate a generative AI system", "genai1m:That system has 1M+ monthly users in California", "frontier:We develop frontier-scale models", "admt:We use automated decisions for significant consumer outcomes"]
            .map((item) => {
              const [key, label] = item.split(":");
              return `<label class="check-row"><input type="checkbox" data-profile="${key}" ${d.company[key] ? "checked" : ""}/> ${label}</label>`;
            })
            .join("")}
        </div>
        <div class="score-panel">
          <span class="eyebrow" style="color:var(--slate)">Overall Readiness</span>
          <div class="score-value" style="color:${d.overallScore === 100 ? "var(--green)" : "var(--ink)"}">${d.overallScore}%</div>
          <div class="score-sub">${d.regulations.filter((r) => r.applies).length} statute(s) in scope</div>
        </div>
      </div>

      <div>
        <span class="eyebrow" style="color:var(--slate-light);display:block;margin-bottom:10px;">Active Docket</span>
        ${d.regulations.map(renderRegCard).join("")}
      </div>

      <div>
        <span class="eyebrow" style="color:var(--slate-light);display:block;margin-bottom:10px;">On the Radar — Other Jurisdictions</span>
        <div class="watch-grid">
          ${d.watching
            .map(
              (w) => `<div class="watch-card"><div class="watch-code">${w.code}</div><div class="watch-name">${w.name}</div><div class="watch-note">${w.note}</div></div>`
            )
            .join("")}
        </div>
      </div>

      <div class="report-btn-row">
        <button class="btn-ghost" id="audit-btn">View Audit Log</button>
        <button class="btn-primary" style="width:auto;margin-top:0;" id="report-btn">Generate Compliance Report</button>
      </div>
    </div>
  `;

  document.getElementById("signout").onclick = logout;
  document.querySelectorAll("[data-profile]").forEach((el) => {
    el.onchange = async (e) => {
      const key = e.target.getAttribute("data-profile");
      state.dashboard = await api("/api/company/profile", {
        method: "PATCH",
        body: JSON.stringify({ [key]: e.target.checked }),
      });
      render();
    };
  });
  document.querySelectorAll("[data-toggle]").forEach((el) => {
    el.onclick = () => {
      const id = el.getAttribute("data-toggle");
      state.expanded = state.expanded === id ? null : id;
      render();
    };
  });
  document.querySelectorAll("[data-req]").forEach((el) => {
    el.onchange = async (e) => {
      e.stopPropagation();
      const id = e.target.getAttribute("data-req");
      state.dashboard = await api(`/api/requirements/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ checked: e.target.checked }),
      });
      render();
    };
  });
  document.getElementById("report-btn").onclick = async () => {
    const report = await api("/api/report");
    showModal("Compliance Report", `<pre>${report}</pre>`);
  };
  document.getElementById("audit-btn").onclick = async () => {
    const log = await api("/api/audit-log");
    const rows = log.length
      ? log.map((r) => `<div class="audit-row">${new Date(r.timestamp).toLocaleString()} — ${r.user_email} — ${r.action} — ${r.requirement_id}</div>`).join("")
      : `<div class="audit-row">No changes logged yet.</div>`;
    showModal("Audit Log", rows);
  };
}

function renderRegCard(reg) {
  const open = state.expanded === reg.id;
  return `
    <div class="docket-card ${reg.applies ? "" : "na"}">
      <div class="docket-head" ${reg.applies ? `data-toggle="${reg.id}"` : ""}>
        <div style="flex:1;min-width:0;">
          <div>
            <span class="docket-code">${reg.code}</span>
            <span class="docket-name">${reg.name}</span>
          </div>
          <div class="docket-meta">Effective ${new Date(reg.effective_date).toDateString()} · ${daysLabel(reg.daysUntil)} · ${reg.penalty}</div>
          ${reg.applies ? `<div class="progress-track"><div class="progress-fill" style="width:${reg.pct}%;background:${barColor(reg.status)}"></div></div>` : ""}
        </div>
        <div class="stamp ${statusClass(reg.status)}">${statusLabel(reg.status)}</div>
      </div>
      ${
        reg.applies && open
          ? `<div class="docket-body">
              <p class="docket-summary">${reg.summary}</p>
              ${reg.requirements
                .map(
                  (r) =>
                    `<label class="req-row"><input type="checkbox" data-req="${r.id}" ${r.checked ? "checked" : ""} /> <span class="${r.checked ? "done" : ""}">${r.text}</span></label>`
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
  `;
}

function showModal(title, innerHtml) {
  const wrap = document.createElement("div");
  wrap.className = "modal-overlay";
  wrap.innerHTML = `<div class="modal-card"><h2>${title}</h2>${innerHtml}<button class="close-btn">Close</button></div>`;
  wrap.onclick = (e) => {
    if (e.target === wrap) wrap.remove();
  };
  wrap.querySelector(".close-btn").onclick = () => wrap.remove();
  document.body.appendChild(wrap);
}

// ---- boot ----
(async function init() {
  if (state.token) {
    try {
      state.user = await api("/api/me");
      state.view = "dashboard";
      await loadDashboard();
      return;
    } catch (e) {
      // token invalid/expired, fall through to login
    }
  }
  render();
})();
