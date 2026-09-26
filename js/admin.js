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

// fetch() can't report upload progress, so file uploads use XHR instead —
// this is what lets the admin panel show a real "42% uploaded" bar instead
// of just a stuck "Uploading…" with no feedback until it either finishes
// or silently fails.
function uploadWithProgress(path, formData, method, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method || "POST", path);
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Request failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.send(formData);
  });
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

const loginBtn = loginForm.querySelector('button[type="submit"]');
const loginBtnDefaultText = loginBtn.textContent;

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = "Logging in…";
  const formData = new FormData(loginForm);
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: formData.get("username"), password: formData.get("password") }),
      headers: { "Content-Type": "application/json" },
    });
    await checkAuth();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = loginBtnDefaultText;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" });
  checkAuth();
});

function deleteRow(container, label) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-3 bg-white border border-[#E8E8E3] rounded-md px-3 py-2 text-sm";
  const span = document.createElement("span");
  span.className = "truncate";
  span.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Delete";
  btn.className = "text-red-600 border border-red-600 rounded-full px-3 py-1 text-xs shrink-0 hover:bg-red-600 hover:text-white transition";
  row.append(span, btn);
  container.appendChild(row);
  return btn;
}

// ---------- reels ----------
const reelForm = document.getElementById("reel-form");
const reelStatus = document.getElementById("reel-status");
const reelList = document.getElementById("reel-list");

reelForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = reelForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  reelStatus.textContent = "Uploading… 0%";
  try {
    await uploadWithProgress("/api/admin/reels", new FormData(reelForm), "POST", (pct) => {
      reelStatus.textContent = `Uploading… ${pct}%`;
    });
    reelStatus.textContent = "✅ Uploaded successfully.";
    reelForm.reset();
    loadDashboard();
  } catch (err) {
    reelStatus.textContent = `❌ Upload failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderReels(reels) {
  reelList.innerHTML = "";
  ["row1", "row2", "row3"].forEach((row) => {
    (reels[row] || []).forEach((r) => {
      const del = deleteRow(reelList, `[${row}] reel`);
      del.addEventListener("click", async () => {
        await api(`/api/admin/reels/${row}/${r.id}`, { method: "DELETE" });
        loadDashboard();
      });
    });
  });
}

// ---------- video testimonials ----------
const vtForm = document.getElementById("vt-form");
const vtStatus = document.getElementById("vt-status");
const vtList = document.getElementById("vt-list");

vtForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = vtForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  vtStatus.textContent = "Uploading… 0%";
  try {
    await uploadWithProgress("/api/admin/video-testimonials", new FormData(vtForm), "POST", (pct) => {
      vtStatus.textContent = `Uploading… ${pct}%`;
    });
    vtStatus.textContent = "✅ Uploaded successfully.";
    vtForm.reset();
    loadDashboard();
  } catch (err) {
    vtStatus.textContent = `❌ Upload failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderVideoTestimonials(list) {
  vtList.innerHTML = "";
  list.forEach((t) => {
    const del = deleteRow(vtList, `${t.name} — ${t.quote ? t.quote.slice(0, 40) : "(no quote)"}`);
    del.addEventListener("click", async () => {
      await api(`/api/admin/video-testimonials/${t.id}`, { method: "DELETE" });
      loadDashboard();
    });
  });
}

// ---------- written testimonials ----------
const wtForm = document.getElementById("wt-form");
const wtStatus = document.getElementById("wt-status");
const wtList = document.getElementById("wt-list");

wtForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(wtForm);
  try {
    await api("/api/admin/written-testimonials", {
      method: "POST",
      body: JSON.stringify({ name: formData.get("name"), quote: formData.get("quote") }),
      headers: { "Content-Type": "application/json" },
    });
    wtStatus.textContent = "Added.";
    wtForm.reset();
    loadDashboard();
  } catch (err) {
    wtStatus.textContent = `Error: ${err.message}`;
  }
});

function renderWrittenTestimonials(list) {
  wtList.innerHTML = "";
  list.forEach((t) => {
    const del = deleteRow(wtList, `${t.name} — "${t.quote.slice(0, 50)}${t.quote.length > 50 ? "…" : ""}"`);
    del.addEventListener("click", async () => {
      await api(`/api/admin/written-testimonials/${t.id}`, { method: "DELETE" });
      loadDashboard();
    });
  });
}

// ---------- before / after ----------
const baForm = document.getElementById("ba-form");
const baStatus = document.getElementById("ba-status");
const baList = document.getElementById("ba-list");

baForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = baForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  baStatus.textContent = "Uploading… 0%";
  try {
    await uploadWithProgress("/api/admin/before-after", new FormData(baForm), "POST", (pct) => {
      baStatus.textContent = `Uploading… ${pct}%`;
    });
    baStatus.textContent = "✅ Added successfully.";
    baForm.reset();
    loadDashboard();
  } catch (err) {
    baStatus.textContent = `❌ Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderBeforeAfter(list) {
  baList.innerHTML = "";
  list.forEach((b) => {
    const del = deleteRow(baList, `${b.client} (${b.stats.length} stat rows)`);
    del.addEventListener("click", async () => {
      await api(`/api/admin/before-after/${b.id}`, { method: "DELETE" });
      loadDashboard();
    });
  });
}

// ---------- process screenshots ----------
const processSlotsEl = document.getElementById("process-slots");
const PROCESS_LABELS = { record: "1. Send your footage", edit: "2. We research & edit", review: "3. Review & approve", upload: "4. We handle posting" };

function renderProcessSlots(process) {
  processSlotsEl.innerHTML = "";
  Object.entries(PROCESS_LABELS).forEach(([slot, label]) => {
    const box = document.createElement("div");
    box.className = "border border-[#E8E8E3] rounded-md p-3 bg-white";
    const hasImage = Boolean(process[slot]);
    box.innerHTML = `
      <p class="text-sm font-semibold mb-2">${label}</p>
      <p class="text-xs text-[#6E6E6A] mb-2">${hasImage ? "Custom screenshot set." : "Using drawn placeholder."}</p>
      <input type="file" accept="image/jpeg,image/png,image/webp" class="w-full text-xs mb-2" />
      <div class="flex gap-2">
        <button type="button" class="upload-btn bg-yellow text-[#0B0B0B] text-xs font-bold uppercase px-3 py-1.5 rounded-full">Upload</button>
        ${hasImage ? '<button type="button" class="clear-btn border border-red-600 text-red-600 text-xs font-bold uppercase px-3 py-1.5 rounded-full">Clear</button>' : ""}
      </div>
      <p class="text-xs mt-1 status"></p>
    `;
    const fileInput = box.querySelector("input[type=file]");
    const status = box.querySelector(".status");
    box.querySelector(".upload-btn").addEventListener("click", async () => {
      if (!fileInput.files[0]) { status.textContent = "Choose a file first."; return; }
      const fd = new FormData();
      fd.append("media", fileInput.files[0]);
      status.textContent = "Uploading…";
      try {
        await uploadWithProgress(`/api/admin/process/${slot}`, fd, "POST", (pct) => { status.textContent = `Uploading… ${pct}%`; });
        status.textContent = "✅ Saved.";
        loadDashboard();
      } catch (err) {
        status.textContent = `❌ ${err.message}`;
      }
    });
    const clearBtn = box.querySelector(".clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        await api(`/api/admin/process/${slot}`, { method: "DELETE" });
        loadDashboard();
      });
    }
    processSlotsEl.appendChild(box);
  });
}

// ---------- settings ----------
const settingsForm = document.getElementById("settings-form");
const settingsStatus = document.getElementById("settings-status");

function fillSettings(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = settingsForm.elements.namedItem(key);
    if (el) el.value = value || "";
  }
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(settingsForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    await api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
    settingsStatus.textContent = "Saved.";
  } catch (err) {
    settingsStatus.textContent = `Error: ${err.message}`;
  }
});

// ---------- load everything ----------
async function loadDashboard() {
  const content = await api("/api/content");
  renderReels(content.reels || { row1: [], row2: [], row3: [] });
  renderVideoTestimonials(content.videoTestimonials || []);
  renderWrittenTestimonials(content.writtenTestimonials || []);
  renderBeforeAfter(content.beforeAfter || []);
  renderProcessSlots(content.process || {});
  fillSettings(content.settings || {});
}

checkAuth();
