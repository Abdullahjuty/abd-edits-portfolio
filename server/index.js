const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const bcrypt = require("bcryptjs");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const CONTENT_PATH = path.join(DATA_DIR, "content.json");
const ADMIN_PATH = path.join(DATA_DIR, "admin.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

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
      // secure cookies require HTTPS — enable once the real domain is live behind TLS
      secure: process.env.NODE_ENV === "production" && process.env.FORCE_HTTPS === "1",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

// ---------- helpers ----------
function readContent() {
  return JSON.parse(fs.readFileSync(CONTENT_PATH, "utf-8"));
}

function writeContent(data) {
  fs.writeFileSync(CONTENT_PATH, JSON.stringify(data, null, 2));
}

// Hosts without shell/file-persistence (e.g. Render's free tier) can set
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

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const isVideo = file.mimetype.startsWith("video/");
    cb(null, path.join(UPLOADS_DIR, isVideo ? "videos" : "images"));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${newId("file")}${ext}`);
  },
});

const ALLOWED_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const upload = multer({
  storage,
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
  const admin = readAdmin();
  if (!admin) {
    return res.status(500).json({ error: "No admin account set up yet. Run: npm run create-admin -- <user> <pass>" });
  }
  if (username !== admin.username || !bcrypt.compareSync(password || "", admin.passwordHash)) {
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
app.get("/api/content", (req, res) => {
  res.json(readContent());
});

// ---------- admin content management ----------
app.post("/api/admin/clips", requireAuth, upload.fields([{ name: "media" }, { name: "poster" }]), (req, res) => {
  try {
    const { row, size, tag, time } = req.body;
    if (!["rtl", "ltr", "rtl-slow"].includes(row)) return res.status(400).json({ error: "Invalid row" });

    const mediaFile = req.files?.media?.[0];
    const posterFile = req.files?.poster?.[0];
    if (!mediaFile) return res.status(400).json({ error: "A video or image file is required" });

    const isVideo = mediaFile.mimetype.startsWith("video/");
    const mediaUrl = `/uploads/${isVideo ? "videos" : "images"}/${mediaFile.filename}`;
    const posterUrl = posterFile ? `/uploads/images/${posterFile.filename}` : (isVideo ? "" : mediaUrl);

    const content = readContent();
    const clip = {
      id: newId("c"),
      row,
      size: size || "normal",
      type: isVideo ? "video" : "image",
      src: isVideo ? mediaUrl : "",
      poster: isVideo ? posterUrl : mediaUrl,
      time: time || "",
      tag: tag || "",
    };
    content.clips.unshift(clip);
    writeContent(content);
    res.json({ ok: true, clip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/clips/:id", requireAuth, (req, res) => {
  const content = readContent();
  content.clips = content.clips.filter((c) => c.id !== req.params.id);
  writeContent(content);
  res.json({ ok: true });
});

app.post("/api/admin/testimonials", requireAuth, (req, res) => {
  const { quote, name, role, avatar, place, featured } = req.body || {};
  if (!quote || !name) return res.status(400).json({ error: "Quote and name are required" });
  const content = readContent();
  const testimonial = {
    id: newId("t"),
    quote,
    name,
    role: role || "",
    avatar: avatar || name.slice(0, 2).toUpperCase(),
    place: place || "",
    featured: Boolean(featured),
  };
  content.testimonials.push(testimonial);
  writeContent(content);
  res.json({ ok: true, testimonial });
});

app.delete("/api/admin/testimonials/:id", requireAuth, (req, res) => {
  const content = readContent();
  content.testimonials = content.testimonials.filter((t) => t.id !== req.params.id);
  writeContent(content);
  res.json({ ok: true });
});

app.put("/api/admin/pricing", requireAuth, (req, res) => {
  const { pricing } = req.body || {};
  if (!Array.isArray(pricing)) return res.status(400).json({ error: "pricing must be an array" });
  const content = readContent();
  content.pricing = pricing;
  writeContent(content);
  res.json({ ok: true });
});

app.post("/api/admin/hero", requireAuth, upload.fields([{ name: "vslVideo" }, { name: "vslPoster" }]), (req, res) => {
  const content = readContent();
  const videoFile = req.files?.vslVideo?.[0];
  const posterFile = req.files?.vslPoster?.[0];
  if (videoFile) content.hero.vslVideo = `/uploads/videos/${videoFile.filename}`;
  if (posterFile) content.hero.vslPoster = `/uploads/images/${posterFile.filename}`;
  const { eyebrow, headline1, headline2, valueProp } = req.body || {};
  if (eyebrow) content.hero.eyebrow = eyebrow;
  if (headline1) content.hero.headline1 = headline1;
  if (headline2) content.hero.headline2 = headline2;
  if (valueProp) content.hero.valueProp = valueProp;
  writeContent(content);
  res.json({ ok: true, hero: content.hero });
});

// ---------- static files ----------
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(ROOT, { index: "index.html" }));

app.listen(PORT, () => {
  console.log(`ABD Edits server running at http://localhost:${PORT}`);
  if (!readAdmin()) {
    console.log('No admin account found yet. Create one with: npm run create-admin -- <username> <password>');
  }
});
