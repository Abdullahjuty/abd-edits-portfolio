const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const whoEl = document.getElementById("who");

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function checkAuth() {
  const data = await api("/api/admin/me");
  if (data.authenticated) {
    loginView.hidden = true;
    dashboardView.hidden = false;
    whoEl.textContent = `Logged in as ${data.username}`;
    loadDashboard();
  } else {
    loginView.hidden = false;
    dashboardView.hidden = true;
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const formData = new FormData(loginForm);
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
      headers: { "Content-Type": "application/json" },
    });
    checkAuth();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" });
  checkAuth();
});

// ---------- clips ----------
const clipForm = document.getElementById("clip-form");
const clipStatus = document.getElementById("clip-status");
const clipList = document.getElementById("clip-list");

clipForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clipStatus.textContent = "Uploading…";
  try {
    await api("/api/admin/clips", { method: "POST", body: new FormData(clipForm) });
    clipStatus.textContent = "Uploaded.";
    clipForm.reset();
    loadDashboard();
  } catch (err) {
    clipStatus.textContent = `Error: ${err.message}`;
  }
});

function renderClips(clips) {
  clipList.innerHTML = "";
  clips.forEach((clip) => {
    const row = document.createElement("div");
    row.className = "admin-row";
    row.innerHTML = `<span>[${clip.row}] ${clip.tag || "(untitled)"} · ${clip.type}</span>`;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await api(`/api/admin/clips/${clip.id}`, { method: "DELETE" });
      loadDashboard();
    });
    row.appendChild(del);
    clipList.appendChild(row);
  });
}

// ---------- testimonials ----------
const testimonialForm = document.getElementById("testimonial-form");
const testimonialStatus = document.getElementById("testimonial-status");
const testimonialList = document.getElementById("testimonial-list");

testimonialForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(testimonialForm);
  try {
    await api("/api/admin/testimonials", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        role: formData.get("role"),
        quote: formData.get("quote"),
        featured: formData.get("featured") === "on",
      }),
      headers: { "Content-Type": "application/json" },
    });
    testimonialStatus.textContent = "Added.";
    testimonialForm.reset();
    loadDashboard();
  } catch (err) {
    testimonialStatus.textContent = `Error: ${err.message}`;
  }
});

function renderTestimonials(testimonials) {
  testimonialList.innerHTML = "";
  testimonials.forEach((t) => {
    const row = document.createElement("div");
    row.className = "admin-row";
    row.innerHTML = `<span>${t.name} — "${t.quote.slice(0, 60)}${t.quote.length > 60 ? "…" : ""}"</span>`;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await api(`/api/admin/testimonials/${t.id}`, { method: "DELETE" });
      loadDashboard();
    });
    row.appendChild(del);
    testimonialList.appendChild(row);
  });
}

// ---------- pricing ----------
const pricingEditor = document.getElementById("pricing-editor");
const pricingStatus = document.getElementById("pricing-status");
let currentPricing = [];

function renderPricingEditor(pricing) {
  currentPricing = pricing;
  pricingEditor.innerHTML = "";
  pricing.forEach((plan, idx) => {
    const box = document.createElement("div");
    box.className = "pricing-plan-editor";
    box.innerHTML = `
      <input data-field="name" placeholder="Plan name" value="${plan.name}" />
      <input data-field="price" placeholder="Price" value="${plan.price}" />
      <input data-field="unit" placeholder="Unit (e.g. / project)" value="${plan.unit}" />
      <textarea data-field="features" rows="4" placeholder="One feature per line">${plan.features.join("\n")}</textarea>
      <input data-field="cta" placeholder="Button text" value="${plan.cta}" />
    `;
    box.querySelectorAll("[data-field]").forEach((el) => {
      el.addEventListener("input", () => {
        const field = el.dataset.field;
        currentPricing[idx][field] = field === "features" ? el.value.split("\n").filter(Boolean) : el.value;
      });
    });
    pricingEditor.appendChild(box);
  });
}

document.getElementById("save-pricing").addEventListener("click", async () => {
  try {
    await api("/api/admin/pricing", {
      method: "PUT",
      body: JSON.stringify({ pricing: currentPricing }),
      headers: { "Content-Type": "application/json" },
    });
    pricingStatus.textContent = "Saved.";
  } catch (err) {
    pricingStatus.textContent = `Error: ${err.message}`;
  }
});

// ---------- hero ----------
const heroForm = document.getElementById("hero-form");
const heroStatus = document.getElementById("hero-status");

heroForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  heroStatus.textContent = "Saving…";
  try {
    await api("/api/admin/hero", { method: "POST", body: new FormData(heroForm) });
    heroStatus.textContent = "Saved.";
    heroForm.reset();
  } catch (err) {
    heroStatus.textContent = `Error: ${err.message}`;
  }
});

// ---------- load everything ----------
async function loadDashboard() {
  const content = await api("/api/content");
  renderClips(content.clips);
  renderTestimonials(content.testimonials);
  renderPricingEditor(content.pricing);
}

checkAuth();
