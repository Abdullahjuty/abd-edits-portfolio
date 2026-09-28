const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const cloudinary = require("cloudinary").v2;

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const SEED_CONTENT_PATH = path.join(DATA_DIR, "content.json");
const ADMIN_PATH = path.join(DATA_DIR, "admin.json");

const PORT = process.env.PORT || 4000;
// Signs and verifies admin login JWTs. This replaces express-session: a
// JWT is a self-contained, signed proof of login that needs no server-side
// memory to check — which matters because a serverless host (Vercel,
// Cloudflare) may run each request in a fresh process with nothing
// remembered between them. Every instance must use the SAME secret, or a
// login made on one instance is rejected by the next ("Not authenticated"
// mid-session, and after every deploy). Without JWT_SECRET set, derive it
// from the Cloudinary API secret, which every deployed instance already
// shares. The random fallback is only for local testing with neither set.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  (process.env.CLOUDINARY_API_SECRET &&
    crypto.createHmac("sha256", process.env.CLOUDINARY_API_SECRET).update("abd-edits admin jwt").digest("hex")) ||
  crypto.randomBytes(32).toString("hex");
const JWT_COOKIE_NAME = "admin_token";
const JWT_EXPIRY = "30d"; // admins log in rarely — keep them signed in for weeks, not hours

// ---------------------------------------------------------------------
// Firestore: this is where all site content (reels, testimonials,
// before/after, settings) lives permanently — independent of whichever
// host runs this server.
// ---------------------------------------------------------------------
function loadFirebaseCredentials() {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Most host env-var UIs can't store literal newlines, so the key is
      // stored with escaped \n and unescaped here.
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }
  // Local dev convenience: auto-detect a downloaded service account key
  // sitting in the project root (it's git-ignored, never committed).
  const localKeyFile = fs
    .readdirSync(ROOT)
    .find((name) => name.includes("firebase-adminsdk") && name.endsWith(".json"));
  if (localKeyFile) {
    const key = JSON.parse(fs.readFileSync(path.join(ROOT, localKeyFile), "utf-8"));
    return { projectId: key.project_id, clientEmail: key.client_email, privateKey: key.private_key };
  }
  return null;
}

const firebaseCreds = loadFirebaseCredentials();
if (!firebaseCreds) {
  console.error(
    "No Firebase credentials found. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env vars, " +
      "or place the downloaded *firebase-adminsdk*.json file in the project root for local dev."
  );
  process.exit(1);
}

if (!admin.getApps().length) {
  admin.initializeApp({ credential: admin.cert(firebaseCreds) });
}
const db = getFirestore();
const CONTENT_DOC = db.collection("site").doc("content");

async function readContent() {
  const snap = await CONTENT_DOC.get();
  if (snap.exists) return snap.data();
  const seed = JSON.parse(fs.readFileSync(SEED_CONTENT_PATH, "utf-8"));
  await CONTENT_DOC.set(seed);
  return seed;
}

async function writeContent(data) {
  await CONTENT_DOC.set(data);
}

// ---------------------------------------------------------------------
// Cloudinary: the browser uploads files directly here (see the
// /api/admin/upload-signature route below) instead of relaying them
// through this server. Two reasons: serverless hosts like Vercel cap a
// function's request body at ~4.5MB (far too small for video), and even
// without that limit, relaying bytes through our server is a pointless
// extra hop when Cloudinary can take them directly from the browser.
// ---------------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // required for correctly detecting HTTPS behind a host's proxy
app.use(express.json());

// Hosts without shell access can set ADMIN_USERNAME + ADMIN_PASSWORD as
// environment variables instead of running the create-admin script.
function readAdmin() {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    return {
      username: process.env.ADMIN_USERNAME,
      passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12),
    };
  }
  if (!fs.existsSync(ADMIN_PATH)) return null;
  return JSON.parse(fs.readFileSync(ADMIN_PATH, "utf-8"));
}

function getTokenFromRequest(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return parsed[JWT_COOKIE_NAME] || null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
}

function setAuthCookie(res, username) {
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(JWT_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(JWT_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    })
  );
}

// Best-effort: removes the actual file from Cloudinary storage. Failures
// here are logged but never block the delete from completing in
// Firestore — a stray orphaned file in Cloudinary is a much smaller
// problem than a delete button that appears to do nothing.
async function destroyCloudinaryAsset(publicId, resourceType) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "image", invalidate: true });
  } catch (err) {
    console.error(`Failed to delete Cloudinary asset ${publicId}:`, err.message);
  }
}

// Accepts a CSS aspect-ratio value like "16/9" (preset or detected from
// the real video dimensions client-side) — validated so a bad/missing
// value can't break the layout, falling back to the site's original
// portrait default.
function sanitizeRatio(ratio) {
  if (typeof ratio === "string" && /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(ratio.trim())) return ratio.trim();
  return "9/16";
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function asyncRoute(handler) {
  return (req, res) => handler(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  });
}

// ---------- auth routes ----------
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const adminAccount = readAdmin();
  if (!adminAccount) {
    return res.status(500).json({ error: "No admin account set up yet. Set ADMIN_USERNAME/ADMIN_PASSWORD env vars." });
  }
  if (username !== adminAccount.username || !bcrypt.compareSync(password || "", adminAccount.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  setAuthCookie(res, username);
  res.json({ ok: true, username });
});

app.post("/api/admin/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) return res.json({ authenticated: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, username: payload.username });
  } catch {
    res.json({ authenticated: false });
  }
});

// Gives the browser everything it needs to upload one file straight to
// Cloudinary. The signature is time-limited (the timestamp is baked into
// it) and folder/resource_type-scoped, so it can't be reused to upload
// somewhere else or after it expires.
app.post(
  "/api/admin/upload-signature",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { folder, resourceType } = req.body || {};
    if (!folder || !["image", "video"].includes(resourceType)) {
      return res.status(400).json({ error: "folder and a valid resourceType are required" });
    }
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = { folder, timestamp };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
    res.json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
      resourceType,
    });
  })
);

// ---------- public content ----------
app.get(
  "/api/content",
  asyncRoute(async (req, res) => {
    // Let Vercel's edge cache this for visitors: an uncached call is a
    // serverless start + Firestore read (~1-3s), and the homepage shows
    // nothing until it returns. Edits reach visitors within ~10s. The
    // admin panel requests it with a unique ?fresh= query, which is a
    // separate cache key, so the admin always sees its own changes.
    res.set("Cache-Control", "public, max-age=0, s-maxage=10, stale-while-revalidate=60");
    res.json(await readContent());
  })
);

// ---------- admin content management ----------
// Every route below receives only small JSON metadata — the actual video/
// image bytes already went straight from the browser to Cloudinary via the
// signature route above, so none of this ever touches a request body size
// limit.

// Reels (the 3 scrolling proof rows)
app.post(
  "/api/admin/reels",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { row, src, publicId, ratio, label } = req.body || {};
    if (!["row1", "row2", "row3"].includes(row)) return res.status(400).json({ error: "Invalid row" });
    if (!src) return res.status(400).json({ error: "src is required" });
    const content = await readContent();
    const reel = { id: newId("r"), src, publicId: publicId || "", ratio: sanitizeRatio(ratio), label: label || "" };
    content.reels[row].push(reel);
    await writeContent(content);
    res.json({ ok: true, row, reel });
  })
);

app.delete(
  "/api/admin/reels/:row/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { row, id } = req.params;
    if (!["row1", "row2", "row3"].includes(row)) return res.status(400).json({ error: "Invalid row" });
    const content = await readContent();
    const reel = content.reels[row].find((r) => r.id === id);
    content.reels[row] = content.reels[row].filter((r) => r.id !== id);
    await writeContent(content);
    if (reel) await destroyCloudinaryAsset(reel.publicId, "video");
    res.json({ ok: true });
  })
);

// Video testimonials
app.post(
  "/api/admin/video-testimonials",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { label, name, handle, followers, quote, duration, focus, src, publicId, poster, posterPublicId, ratio } = req.body || {};
    if (!name || !src) return res.status(400).json({ error: "Name and src are required" });
    const content = await readContent();
    const testimonial = {
      id: newId("vt"),
      label: label || "",
      name,
      handle: handle || "",
      followers: followers || "",
      quote: quote || "",
      duration: duration || "",
      focus: focus || "center",
      src,
      publicId: publicId || "",
      poster: poster || "",
      posterPublicId: posterPublicId || "",
      ratio: sanitizeRatio(ratio),
    };
    content.videoTestimonials.push(testimonial);
    await writeContent(content);
    res.json({ ok: true, testimonial });
  })
);

app.delete(
  "/api/admin/video-testimonials/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const content = await readContent();
    const testimonial = content.videoTestimonials.find((t) => t.id === req.params.id);
    content.videoTestimonials = content.videoTestimonials.filter((t) => t.id !== req.params.id);
    await writeContent(content);
    if (testimonial) {
      await destroyCloudinaryAsset(testimonial.publicId, "video");
      await destroyCloudinaryAsset(testimonial.posterPublicId, "image");
    }
    res.json({ ok: true });
  })
);

// Before/after client result videos — a single scrolling row, same shape
// as a reel (video + ratio + admin-only label), just its own section.
app.post(
  "/api/admin/before-after",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { video, videoPublicId, ratio, label } = req.body || {};
    if (!video) return res.status(400).json({ error: "video is required" });
    const content = await readContent();
    const entry = {
      id: newId("ba"),
      video,
      videoPublicId: videoPublicId || "",
      ratio: sanitizeRatio(ratio),
      label: label || "",
    };
    content.beforeAfter.push(entry);
    await writeContent(content);
    res.json({ ok: true, entry });
  })
);

app.delete(
  "/api/admin/before-after/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const content = await readContent();
    const entry = content.beforeAfter.find((b) => b.id === req.params.id);
    content.beforeAfter = content.beforeAfter.filter((b) => b.id !== req.params.id);
    await writeContent(content);
    if (entry) await destroyCloudinaryAsset(entry.videoPublicId, "video");
    res.json({ ok: true });
  })
);

// Client screenshots (reviews / results / wins) — shown as a scattered
// collage on the public site. Just an image plus an admin-only label.
// `|| []` because the live Firestore doc predates this field.
app.post(
  "/api/admin/client-screenshots",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { src, publicId, label } = req.body || {};
    if (!src) return res.status(400).json({ error: "src is required" });
    const content = await readContent();
    const shot = { id: newId("cs"), src, publicId: publicId || "", label: label || "" };
    content.clientScreenshots = [...(content.clientScreenshots || []), shot];
    await writeContent(content);
    res.json({ ok: true, shot });
  })
);

app.delete(
  "/api/admin/client-screenshots/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const content = await readContent();
    const list = content.clientScreenshots || [];
    const shot = list.find((s) => s.id === req.params.id);
    content.clientScreenshots = list.filter((s) => s.id !== req.params.id);
    await writeContent(content);
    if (shot) await destroyCloudinaryAsset(shot.publicId, "image");
    res.json({ ok: true });
  })
);

// Process step screenshots (4 fixed optional slots)
const PROCESS_SLOTS = new Set(["record", "edit", "review", "upload"]);
app.post(
  "/api/admin/process/:slot",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { slot } = req.params;
    const { url, publicId } = req.body || {};
    if (!PROCESS_SLOTS.has(slot)) return res.status(400).json({ error: "Invalid slot" });
    if (!url) return res.status(400).json({ error: "url is required" });
    const content = await readContent();
    const previousPublicId = content.processPublicIds?.[slot];
    content.process[slot] = url;
    content.processPublicIds = { ...content.processPublicIds, [slot]: publicId || "" };
    await writeContent(content);
    if (previousPublicId) await destroyCloudinaryAsset(previousPublicId, "image");
    res.json({ ok: true, slot, url });
  })
);

app.delete(
  "/api/admin/process/:slot",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { slot } = req.params;
    if (!PROCESS_SLOTS.has(slot)) return res.status(400).json({ error: "Invalid slot" });
    const content = await readContent();
    const publicId = content.processPublicIds?.[slot];
    content.process[slot] = "";
    if (content.processPublicIds) content.processPublicIds[slot] = "";
    await writeContent(content);
    if (publicId) await destroyCloudinaryAsset(publicId, "image");
    res.json({ ok: true });
  })
);

// Site settings (contact links, booking URL, meta bar text)
app.put(
  "/api/admin/settings",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { whatsapp, messenger, email, twitter, linkedin, bookingUrl, metaBarBooking } = req.body || {};
    const content = await readContent();
    content.settings = {
      whatsapp: whatsapp ?? content.settings.whatsapp,
      messenger: messenger ?? content.settings.messenger,
      email: email ?? content.settings.email,
      twitter: twitter ?? content.settings.twitter,
      linkedin: linkedin ?? content.settings.linkedin,
      bookingUrl: bookingUrl ?? content.settings.bookingUrl,
      metaBarBooking: metaBarBooking ?? content.settings.metaBarBooking,
    };
    await writeContent(content);
    res.json({ ok: true, settings: content.settings });
  })
);

// ---------- static files (used for local dev / non-Vercel hosts; Vercel
// serves these directly from its CDN without invoking this function).
// Only the public/ folder is served — server/ and node_modules/ must
// never be reachable as static files.
app.use(express.static(path.join(ROOT, "public"), { index: "index.html" }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ABD Edits server running at http://localhost:${PORT}`);
    if (!readAdmin()) {
      console.log("No admin account found yet. Set ADMIN_USERNAME/ADMIN_PASSWORD env vars, or run: npm run create-admin -- <username> <password>");
    }
  });
}

module.exports = app;
