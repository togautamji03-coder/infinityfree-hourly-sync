const express = require("express");
const crypto = require("crypto");
const { runSync } = require("./sync");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

const secret = process.env.SYNC_SECRET;
if (!secret || secret.length < 32) {
  console.error("SYNC_SECRET must be set to a random secret of at least 32 characters.");
  process.exit(1);
}
let running = false;

function authorized(req) {
  const supplied = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.get("/", (_req, res) => res.status(200).send("Hourly website sync service is running."));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, running }));
app.post("/sync", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  if (running) return res.status(409).json({ error: "Sync already running" });
  running = true;
  console.log("Authenticated sync trigger received:", new Date().toISOString());
  try {
    const result = await runSync();
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error("SYNC FAILED:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: "Sync failed; inspect Render logs." });
  } finally {
    running = false;
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log(`Sync web service listening on ${port}`));
