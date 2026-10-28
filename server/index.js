const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { AwsClient } = require("aws4fetch");

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
// Cloudflare R2: all videos and images live in one R2 bucket and are
// served from its public URL. R2 charges nothing for bandwidth, so a
// popular reel can't use up a monthly quota and take the media offline
// (which is what happened on Cloudinary's free plan).
// The browser uploads files directly to R2 with a short-lived presigned
// URL (see the /api/admin/upload-url route below) instead of relaying
// them through this server: serverless hosts like Vercel cap a
// function's request body at ~4.5MB, far too small for video.
// ---------------------------------------------------------------------
const R2_BUCKET = process.env.R2_BUCKET || "abd-edits";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
const R2_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`;
const r2 = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  service: "s3",
  region: "auto",
});

function r2ObjectUrl(key) {
  return `${R2_ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// Hard cap on everything stored in the bucket, kept well under R2's 10GB
// free tier so storage never costs money. Every upload is checked against it.
const STORAGE_LIMIT_BYTES = 6 * 1024 ** 3;
const MAX_FILE_BYTES = 500 * 1024 ** 2;

// Total size of every object in the bucket (ListObjectsV2, 1000 keys a page).
async function r2BucketBytes() {
  let total = 0;
  let token = "";
  do {
    const url = new URL(R2_ENDPOINT);
    url.searchParams.set("list-type", "2");
    if (token) url.searchParams.set("continuation-token", token);
    const res = await r2.fetch(url);
    if (!res.ok) throw new Error(`Could not check storage usage (HTTP ${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) total += Number(m[1]);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] || "" : "";
  } while (token);
  return total;
}

function formatGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

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

// Best-effort: removes the actual file from R2 storage. Failures here are
// logged but never block the delete from completing in Firestore — a
// stray orphaned file in R2 is a much smaller problem than a delete
// button that appears to do nothing. publicId is the file's R2 key.
async function destroyStoredAsset(publicId) {
  if (!publicId) return;
  // A video's poster frame (<same name>.jpg) and tile preview copy
  // (<same name>-tile.mp4, if one was made) go with it.
  const keys = /\.(mp4|mov|webm|m4v)$/i.test(publicId)
    ? [publicId, publicId.replace(/\.[a-z0-9]+$/i, ".jpg"), publicId.replace(/\.[a-z0-9]+$/i, "-tile.mp4")]
    : [publicId];
  for (const key of keys) {
    try {
      const res = await r2.fetch(r2ObjectUrl(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error(`Failed to delete R2 object ${key}:`, err.message);
    }
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

// Gives the browser a presigned URL to PUT one file straight into R2.
// The URL is valid for 15 minutes and for exactly one new key, so it
// can't be reused to overwrite other files or upload after it expires.
// The file's size is signed into the URL (Content-Length), so the browser
// can't upload a bigger file than the one checked against the 6GB cap.
app.post(
  "/api/admin/upload-url",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { folder, resourceType, filename, size } = req.body || {};
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(folder || "") || !["image", "video"].includes(resourceType)) {
      return res.status(400).json({ error: "folder and a valid resourceType are required" });
    }
    if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: "File size is required" });
    if (size > MAX_FILE_BYTES) {
      return res.status(400).json({
        error: `This file is ${(size / 1024 ** 2).toFixed(0)} MB — the limit is 500 MB per file. Export a smaller version (720p or 1080p) and try again.`,
      });
    }
    const used = await r2BucketBytes();
    if (used + size > STORAGE_LIMIT_BYTES) {
      return res.status(400).json({
        error: `Storage is full: ${formatGB(used)} of ${formatGB(STORAGE_LIMIT_BYTES)} used. Delete some old videos first.`,
      });
    }
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(filename || "")?.[1] || (resourceType === "video" ? "mp4" : "jpg")).toLowerCase();
    let key = `${folder}/${crypto.randomBytes(10).toString("hex")}.${ext}`;
    // A video's poster frame goes next to it as <same name>.jpg, which is
    // where the homepage looks for it.
    const { posterFor } = req.body || {};
    if (posterFor) {
      if (resourceType !== "image" || !new RegExp(`^${folder}/[a-f0-9]{20}\\.[a-z0-9]{1,5}$`).test(posterFor)) {
        return res.status(400).json({ error: "Invalid poster target" });
      }
      key = posterFor.replace(/\.[a-z0-9]+$/, ".jpg");
    }
    const url = new URL(r2ObjectUrl(key));
    url.searchParams.set("X-Amz-Expires", "900");
    const signed = await r2.sign(new Request(url, { method: "PUT", headers: { "Content-Length": String(size) } }), {
      aws: { signQuery: true, allHeaders: true },
    });
    res.json({ uploadUrl: signed.url, url: `${R2_PUBLIC_URL}/${key}`, publicId: key });
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
// image bytes already went straight from the browser to R2 via the
// upload-url route above, so none of this ever touches a request body size
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
    if (reel) await destroyStoredAsset(reel.publicId);
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
      await destroyStoredAsset(testimonial.publicId);
      await destroyStoredAsset(testimonial.posterPublicId);
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
    if (entry) await destroyStoredAsset(entry.videoPublicId);
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
    if (shot) await destroyStoredAsset(shot.publicId);
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
    if (previousPublicId) await destroyStoredAsset(previousPublicId);
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
    if (publicId) await destroyStoredAsset(publicId);
    res.json({ ok: true });
  })
);

// "How we work together" section: show/hide it, and edit its heading and
// each step's title + text. An empty field means "use the site's built-in
// text", so older saved content without this field keeps working too.
app.put(
  "/api/admin/how-it-works",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { hidden, heading, steps } = req.body || {};
    if (!Array.isArray(steps) || steps.length !== 4) return res.status(400).json({ error: "steps must be a list of 4" });
    const clean = (value, max) => String(value ?? "").trim().slice(0, max);
    const content = await readContent();
    content.howItWorks = {
      hidden: Boolean(hidden),
      heading: clean(heading, 120),
      steps: steps.map((s) => ({ title: clean(s?.title, 80), text: clean(s?.text, 600) })),
    };
    await writeContent(content);
    res.json({ ok: true, howItWorks: content.howItWorks });
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
