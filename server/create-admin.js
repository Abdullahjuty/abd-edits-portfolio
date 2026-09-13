// One-time setup: creates/overwrites server/data/admin.json with a bcrypt
// password hash. Run with: npm run create-admin -- <username> <password>
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error("Usage: npm run create-admin -- <username> <password>");
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const outPath = path.join(__dirname, "data", "admin.json");
fs.writeFileSync(outPath, JSON.stringify({ username, passwordHash: hash }, null, 2));
console.log(`Admin account saved for "${username}". You can now log in at /admin.`);
