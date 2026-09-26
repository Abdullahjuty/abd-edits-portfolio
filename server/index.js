const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const cloudinary = require("cloudinary").v2;

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const SEED_CONTENT_PATH = path.join(DATA_DIR, "content.json");
const ADMIN_PATH = path.join(DATA_DIR, "admin.json");

const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// ---------------------------------------------------------------------
// Firestore: this is where all site content (clips, testimonials,
// pricing, hero text) lives permanently. It survives server restarts
// and redeploys, unlike a local JSON file on a host with ephemeral disk
// (e.g. Render's free tier), which resets to whatever is in the git
// repo every time the container restarts.
// ---------------------------------------------------------------------
function loadFirebaseCredentials() {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Render (and most host env-var UIs) can't store literal newlines,
      // so the key is stored with escaped \n and unescaped here.
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

admin.initializeApp({ credential: admin.cert(firebaseCreds) });
const db = getFirestore();
const CONTENT_DOC = db.collection("site").doc("content");

async function readContent() {
  const snap = await CONTENT_DOC.get();
  if (snap.exists) return snap.data();
  // First run: seed Firestore from the bundled defaults, then always
  // read/write Firestore from here on.
  const seed = JSON.parse(fs.readFileSync(SEED_CONTENT_PATH, "utf-8"));
  await CONTENT_DOC.set(seed);
  return seed;
}

async function writeContent(data) {
  await CONTENT_DOC.set(data);
}

// ---------------------------------------------------------------------
// Cloudinary: actual video/image files are uploaded here instead of the
// server's local disk, for the same persistence reason as Firestore
// above — local disk uploads would vanish on every restart.
// ---------------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadBufferToCloudinary(buffer, resourceType, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, folder },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// ---------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // required for secure cookies behind Render's HTTPS proxy
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.FORCE_HTTPS === "1",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

// Hosts without shell access (e.g. Render's free tier) can set
// ADMIN_USERNAME + ADMIN_PASSWORD as environment variables instead of
// running the create-admin script on the server. Env vars take priority
// over the local admin.json file when both are present.
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

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Not authenticated" });
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

// ---------- uploads (kept in memory, then streamed straight to Cloudinary) ----------
const ALLOWED_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }
    cb(null, true);
  },
});

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
  req.session.isAdmin = true;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/me", (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.json({ authenticated: false });
});

// ---------- public content ----------
app.get(
  "/api/content",
  asyncRoute(async (req, res) => {
    res.json(await readContent());
  })
);

// ---------- admin content management ----------

// Reels (the 3 scrolling proof rows)
app.post(
  "/api/admin/reels",
  requireAuth,
  upload.single("media"),
  asyncRoute(async (req, res) => {
    const { row } = req.body;
    if (!["row1", "row2", "row3"].includes(row)) return res.status(400).json({ error: "Invalid row" });
    if (!req.file) return res.status(400).json({ error: "A video file is required" });
    if (!req.file.mimetype.startsWith("video/")) return res.status(400).json({ error: "File must be a video" });

    const uploaded = await uploadBufferToCloudinary(req.file.buffer, "video", "abd-edits/reels");
    const content = await readContent();
    const reel = { id: newId("r"), src: uploaded.secure_url };
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
    content.reels[row] = content.reels[row].filter((r) => r.id !== id);
    await writeContent(content);
    res.json({ ok: true });
  })
);

// Video testimonials
app.post(
  "/api/admin/video-testimonials",
  requireAuth,
  upload.fields([{ name: "media" }, { name: "poster" }]),
  asyncRoute(async (req, res) => {
    const { name, handle, followers, quote, duration, focus } = req.body;
    const mediaFile = req.files?.media?.[0];
    if (!name || !mediaFile) return res.status(400).json({ error: "Name and a video file are required" });
    if (!mediaFile.mimetype.startsWith("video/")) return res.status(400).json({ error: "Media file must be a video" });

    const mediaUpload = await uploadBufferToCloudinary(mediaFile.buffer, "video", "abd-edits/video-testimonials");
    let posterUrl = "";
    const posterFile = req.files?.poster?.[0];
    if (posterFile) {
      const posterUpload = await uploadBufferToCloudinary(posterFile.buffer, "image", "abd-edits/video-testimonials");
      posterUrl = posterUpload.secure_url;
    }

    const content = await readContent();
    const testimonial = {
      id: newId("vt"),
      name,
      handle: handle || "",
      followers: followers || "",
      quote: quote || "",
      duration: duration || "",
      focus: focus || "center",
      src: mediaUpload.secure_url,
      poster: posterUrl,
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
    content.videoTestimonials = content.videoTestimonials.filter((t) => t.id !== req.params.id);
    await writeContent(content);
    res.json({ ok: true });
  })
);

// Written testimonials
app.post(
  "/api/admin/written-testimonials",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { quote, name } = req.body || {};
    if (!quote || !name) return res.status(400).json({ error: "Quote and name are required" });
    const content = await readContent();
    const testimonial = { id: newId("wt"), quote, name };
    content.writtenTestimonials.push(testimonial);
    await writeContent(content);
    res.json({ ok: true, testimonial });
  })
);

app.delete(
  "/api/admin/written-testimonials/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const content = await readContent();
    content.writtenTestimonials = content.writtenTestimonials.filter((t) => t.id !== req.params.id);
    await writeContent(content);
    res.json({ ok: true });
  })
);

// Before/after client results
app.post(
  "/api/admin/before-after",
  requireAuth,
  upload.fields([{ name: "before" }, { name: "after" }]),
  asyncRoute(async (req, res) => {
    const { client, handle, stats } = req.body;
    const beforeFile = req.files?.before?.[0];
    const afterFile = req.files?.after?.[0];
    if (!client) return res.status(400).json({ error: "Client name is required" });

    let beforeUrl = "";
    let afterUrl = "";
    if (beforeFile) beforeUrl = (await uploadBufferToCloudinary(beforeFile.buffer, "image", "abd-edits/before-after")).secure_url;
    if (afterFile) afterUrl = (await uploadBufferToCloudinary(afterFile.buffer, "image", "abd-edits/before-after")).secure_url;

    // stats textarea format: one "Label|beforeVal|afterVal" per line.
    // Stored as an array of objects, not an array of arrays — Firestore
    // does not support nested arrays (an array directly containing arrays).
    const parsedStats = (stats || "")
      .split("\n")
      .map((line) => line.split("|").map((s) => s.trim()))
      .filter((parts) => parts.length === 3 && parts[0])
      .map(([label, beforeVal, afterVal]) => ({ label, beforeVal, afterVal }));

    const content = await readContent();
    const entry = {
      id: newId("ba"),
      client,
      handle: handle || "",
      before: beforeUrl,
      after: afterUrl,
      stats: parsedStats,
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
    content.beforeAfter = content.beforeAfter.filter((b) => b.id !== req.params.id);
    await writeContent(content);
    res.json({ ok: true });
  })
);

// Process step screenshots (4 fixed optional slots)
const PROCESS_SLOTS = new Set(["record", "edit", "review", "upload"]);
app.post(
  "/api/admin/process/:slot",
  requireAuth,
  upload.single("media"),
  asyncRoute(async (req, res) => {
    const { slot } = req.params;
    if (!PROCESS_SLOTS.has(slot)) return res.status(400).json({ error: "Invalid slot" });
    if (!req.file) return res.status(400).json({ error: "An image file is required" });
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, "image", "abd-edits/process");
    const content = await readContent();
    content.process[slot] = uploaded.secure_url;
    await writeContent(content);
    res.json({ ok: true, slot, url: uploaded.secure_url });
  })
);

app.delete(
  "/api/admin/process/:slot",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { slot } = req.params;
    if (!PROCESS_SLOTS.has(slot)) return res.status(400).json({ error: "Invalid slot" });
    const content = await readContent();
    content.process[slot] = "";
    await writeContent(content);
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

// ---------- static files ----------
app.use(express.static(ROOT, { index: "index.html" }));

app.listen(PORT, () => {
  console.log(`ABD Edits server running at http://localhost:${PORT}`);
  if (!readAdmin()) {
    console.log("No admin account found yet. Set ADMIN_USERNAME/ADMIN_PASSWORD env vars, or run: npm run create-admin -- <username> <password>");
  }
});
