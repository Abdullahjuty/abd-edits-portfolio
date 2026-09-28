const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const whoEl = document.getElementById("who");

// ---------- sidebar tab navigation ----------
const navButtons = [...document.querySelectorAll(".nav-btn")];
const panels = [...document.querySelectorAll(".panel")];
const panelTitle = document.getElementById("panel-title");
const navList = document.getElementById("nav-list");
const navToggle = document.getElementById("nav-toggle");

function showTab(tab) {
  panels.forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  navButtons.forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("bg-yellow", active);
    b.classList.toggle("text-[#6E6E6A]", !active);
  });
  const activeBtn = navButtons.find((b) => b.dataset.tab === tab);
  if (activeBtn) panelTitle.textContent = activeBtn.textContent;
  if (window.matchMedia("(max-width: 767px)").matches) navList.classList.add("hidden");
}

navButtons.forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));
navToggle.addEventListener("click", () => navList.classList.toggle("hidden"));
showTab("reels");

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
function uploadWithProgress(url, formData, method, onProgress, withCredentials) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method || "POST", url);
    xhr.withCredentials = withCredentials !== false;
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || data.error?.message || `Request failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.send(formData);
  });
}

// The browser uploads the file straight to Cloudinary (not through our
// server) — our backend only ever hands out a short-lived, folder-scoped
// signature. This matters because serverless hosts cap a function's
// request body at a few MB, far too small for video, and it's also just
// faster: one hop instead of two.
// "Auto" ratio reads the file's real dimensions client-side (via a
// throwaway <video> element) instead of guessing — this runs once at
// upload time so the site never has to detect it later.
function detectVideoRatio(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const { videoWidth, videoHeight } = video;
      URL.revokeObjectURL(video.src);
      resolve(videoWidth && videoHeight ? `${videoWidth}/${videoHeight}` : "9/16");
    };
    video.onerror = () => resolve("9/16");
    video.src = URL.createObjectURL(file);
  });
}

async function resolveRatio(ratioChoice, file) {
  return ratioChoice === "auto" ? detectVideoRatio(file) : ratioChoice;
}

// Reads the video's real length client-side instead of asking the admin
// to type it in (which is exactly the kind of manual, error-prone step
// worth removing) — formatted the same "m:ss" way it's displayed.
function detectVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const seconds = video.duration;
      URL.revokeObjectURL(video.src);
      if (!isFinite(seconds)) return resolve("");
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60).toString().padStart(2, "0");
      resolve(`${mins}:${secs}`);
    };
    video.onerror = () => resolve("");
    video.src = URL.createObjectURL(file);
  });
}

async function uploadToCloudinary(file, folder, resourceType, onProgress) {
  const sig = await api("/api/admin/upload-signature", {
    method: "POST",
    body: JSON.stringify({ folder, resourceType }),
    headers: { "Content-Type": "application/json" },
  });
  const formData = new FormData();
  formData.append("file", file);
  formData.append("api_key", sig.apiKey);
  formData.append("timestamp", sig.timestamp);
  formData.append("signature", sig.signature);
  formData.append("folder", sig.folder);
  const result = await uploadWithProgress(
    `https://api.cloudinary.com/v1_1/${sig.cloudName}/${resourceType}/upload`,
    formData,
    "POST",
    onProgress,
    false
  );
  // public_id is what lets us actually delete the file from Cloudinary
  // later — the secure_url alone isn't enough for that.
  return { url: result.secure_url, publicId: result.public_id, resourceType };
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

// Every delete button goes through here so the loading/error behavior is
// consistent everywhere: disable + "Deleting…" while the request is in
// flight, an inline error message (with the button re-enabled) if it
// fails instead of silently doing nothing, and only refresh the list on
// confirmed success.
function deleteRow(container, label, onDelete) {
  const row = document.createElement("div");
  row.className = "bg-white border border-[#E8E8E3] rounded-md px-3 py-2 text-sm";
  const line = document.createElement("div");
  line.className = "flex items-center justify-between gap-3";
  const span = document.createElement("span");
  span.className = "truncate";
  span.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Delete";
  btn.className = "text-red-600 border border-red-600 rounded-full px-3 py-1 text-xs shrink-0 hover:bg-red-600 hover:text-white transition disabled:opacity-50";
  const error = document.createElement("p");
  error.className = "text-red-600 text-xs mt-1 hidden";
  line.append(span, btn);
  row.append(line, error);
  container.appendChild(row);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Deleting…";
    error.classList.add("hidden");
    try {
      await onDelete();
      await loadDashboard();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Delete";
      error.textContent = `Failed to delete: ${err.message}`;
      error.classList.remove("hidden");
    }
  });

  return btn;
}

// ---------- reels ----------
const reelForm = document.getElementById("reel-form");
const reelStatus = document.getElementById("reel-status");
const reelList = document.getElementById("reel-list");

reelForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = reelForm.querySelector('button[type="submit"]');
  const formData = new FormData(reelForm);
  const row = formData.get("row");
  const file = formData.get("media");
  const ratioChoice = formData.get("ratio");
  const label = formData.get("label");
  btn.disabled = true;
  reelStatus.textContent = "Uploading… 0%";
  try {
    const ratio = await resolveRatio(ratioChoice, file);
    const media = await uploadToCloudinary(file, "abd-edits/reels", "video", (pct) => {
      reelStatus.textContent = `Uploading… ${pct}%`;
    });
    await api("/api/admin/reels", {
      method: "POST",
      body: JSON.stringify({ row, src: media.url, publicId: media.publicId, ratio, label }),
      headers: { "Content-Type": "application/json" },
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
      deleteRow(reelList, `[${row}] ${r.label || "(untitled reel)"}`, () =>
        api(`/api/admin/reels/${row}/${r.id}`, { method: "DELETE" })
      );
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
  const formData = new FormData(vtForm);
  const mediaFile = formData.get("media");
  const posterFile = formData.get("poster");
  const ratioChoice = formData.get("ratio");
  btn.disabled = true;
  try {
    const [ratio, duration] = await Promise.all([
      resolveRatio(ratioChoice, mediaFile),
      detectVideoDuration(mediaFile),
    ]);
    vtStatus.textContent = "Uploading video… 0%";
    const media = await uploadToCloudinary(mediaFile, "abd-edits/video-testimonials", "video", (pct) => {
      vtStatus.textContent = `Uploading video… ${pct}%`;
    });
    let poster = "";
    let posterPublicId = "";
    if (posterFile && posterFile.size > 0) {
      vtStatus.textContent = "Uploading poster… 0%";
      const posterMedia = await uploadToCloudinary(posterFile, "abd-edits/video-testimonials", "image", (pct) => {
        vtStatus.textContent = `Uploading poster… ${pct}%`;
      });
      poster = posterMedia.url;
      posterPublicId = posterMedia.publicId;
    }
    await api("/api/admin/video-testimonials", {
      method: "POST",
      body: JSON.stringify({
        label: formData.get("label"),
        name: formData.get("name"),
        handle: formData.get("handle"),
        followers: formData.get("followers"),
        quote: formData.get("quote"),
        duration,
        src: media.url,
        publicId: media.publicId,
        poster,
        posterPublicId,
        ratio,
      }),
      headers: { "Content-Type": "application/json" },
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
    const label = t.label ? `${t.label} — ` : "";
    deleteRow(vtList, `${label}${t.name} — ${t.quote ? t.quote.slice(0, 40) : "(no text)"}`, () =>
      api(`/api/admin/video-testimonials/${t.id}`, { method: "DELETE" })
    );
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
    deleteRow(wtList, `${t.name} — "${t.quote.slice(0, 50)}${t.quote.length > 50 ? "…" : ""}"`, () =>
      api(`/api/admin/written-testimonials/${t.id}`, { method: "DELETE" })
    );
  });
}

// ---------- before / after ----------
const baForm = document.getElementById("ba-form");
const baStatus = document.getElementById("ba-status");
const baList = document.getElementById("ba-list");

baForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = baForm.querySelector('button[type="submit"]');
  const formData = new FormData(baForm);
  const file = formData.get("media");
  const ratioChoice = formData.get("ratio");
  const label = formData.get("label");
  btn.disabled = true;
  baStatus.textContent = "Uploading… 0%";
  try {
    const ratio = await resolveRatio(ratioChoice, file);
    const media = await uploadToCloudinary(file, "abd-edits/before-after", "video", (pct) => {
      baStatus.textContent = `Uploading… ${pct}%`;
    });
    await api("/api/admin/before-after", {
      method: "POST",
      body: JSON.stringify({ video: media.url, videoPublicId: media.publicId, ratio, label }),
      headers: { "Content-Type": "application/json" },
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
    deleteRow(baList, b.label || "(untitled result)", () =>
      api(`/api/admin/before-after/${b.id}`, { method: "DELETE" })
    );
  });
}

// ---------- client screenshots ----------
const csForm = document.getElementById("cs-form");
const csStatus = document.getElementById("cs-status");
const csList = document.getElementById("cs-list");

csForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = csForm.querySelector('button[type="submit"]');
  const formData = new FormData(csForm);
  const file = formData.get("media");
  const label = formData.get("label");
  btn.disabled = true;
  csStatus.textContent = "Uploading… 0%";
  try {
    const media = await uploadToCloudinary(file, "abd-edits/client-screenshots", "image", (pct) => {
      csStatus.textContent = `Uploading… ${pct}%`;
    });
    await api("/api/admin/client-screenshots", {
      method: "POST",
      body: JSON.stringify({ src: media.url, publicId: media.publicId, label }),
      headers: { "Content-Type": "application/json" },
    });
    csStatus.textContent = "✅ Added successfully.";
    csForm.reset();
    loadDashboard();
  } catch (err) {
    csStatus.textContent = `❌ Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderClientScreenshots(list) {
  csList.innerHTML = "";
  list.forEach((s) => {
    deleteRow(csList, s.label || "(untitled screenshot)", () =>
      api(`/api/admin/client-screenshots/${s.id}`, { method: "DELETE" })
    );
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
      status.textContent = "Uploading… 0%";
      try {
        const media = await uploadToCloudinary(fileInput.files[0], "abd-edits/process", "image", (pct) => {
          status.textContent = `Uploading… ${pct}%`;
        });
        await api(`/api/admin/process/${slot}`, {
          method: "POST",
          body: JSON.stringify({ url: media.url, publicId: media.publicId }),
          headers: { "Content-Type": "application/json" },
        });
        status.textContent = "✅ Saved.";
        loadDashboard();
      } catch (err) {
        status.textContent = `❌ ${err.message}`;
      }
    });
    const clearBtn = box.querySelector(".clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        clearBtn.disabled = true;
        clearBtn.textContent = "Clearing…";
        status.textContent = "";
        try {
          await api(`/api/admin/process/${slot}`, { method: "DELETE" });
          loadDashboard();
        } catch (err) {
          clearBtn.disabled = false;
          clearBtn.textContent = "Clear";
          status.textContent = `❌ Failed to clear: ${err.message}`;
        }
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
  renderClientScreenshots(content.clientScreenshots || []);
  renderProcessSlots(content.process || {});
  fillSettings(content.settings || {});
}

checkAuth();
