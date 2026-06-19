import express from "express";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", true); // honor X-Forwarded-For behind a proxy/CDN
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));

// Config (all overridable via env for deployment)
const DB_PATH = process.env.DB_PATH || join(__dirname, "craft-cache.db");
const MAX_NEW_PER_DAY = Number(process.env.MAX_NEW_PER_DAY || 400); // global cost circuit-breaker
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);        // per-IP new-discovery attempts/min
const ENABLE_IMAGES = process.env.ENABLE_IMAGES !== "0";            // set 0 to disable icon gen

// ---- DB: the shared "canon" — every first-time interaction, forever -----
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS combos (
    combo_key   TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    discoverer  TEXT
  );
`);
const getCombo = db.prepare("SELECT result_json, discoverer, created_at FROM combos WHERE combo_key = ?");
const putCombo = db.prepare(
  "INSERT OR IGNORE INTO combos (combo_key, result_json, created_at, discoverer) VALUES (?, ?, ?, ?)"
);
const countSince = db.prepare("SELECT COUNT(*) AS n FROM combos WHERE created_at >= ?");
const recentCanon = db.prepare("SELECT result_json FROM combos ORDER BY created_at DESC LIMIT ?");
const feedRows = db.prepare("SELECT result_json, discoverer, created_at FROM combos ORDER BY created_at DESC LIMIT ?");

// Stable, order-independent key for a pair of items (identity = item name).
function comboKey(a, b) {
  return [String(a.name).toLowerCase().trim(), String(b.name).toLowerCase().trim()]
    .sort()
    .join("  +  ");
}

function cleanHandle(h) {
  const s = String(h || "").replace(/[^\w \-。-ヿ一-鿿ぁ-ゖ]/g, "").trim().slice(0, 24);
  return s || "anonymous";
}

// ---- Per-IP rate limit (sliding window, in-memory) ----------------------
const hits = new Map(); // ip -> number[] timestamps
function rateLimited(ip, now) {
  const win = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_PER_MIN;
}

function newToday(now) {
  const startOfDay = now - (now % 86_400_000);
  return countSince.get(startOfDay).n;
}

// ---- LLM (Gemini): invent the crafted item ------------------------------
const MODEL = "gemini-3.5-flash";
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Pull a sample of established canon to keep new generations coherent with
// the world's existing ontology (the consistency engine — CANON's moat).
function canonContext() {
  const rows = recentCanon.all(40);
  const names = rows.map((r) => {
    try { const x = JSON.parse(r.result_json); return `${x.name} (${x.category})`; }
    catch { return null; }
  }).filter(Boolean);
  if (!names.length) return "";
  return "\n\nThis world already contains these items (stay consistent with this " +
    "ontology; reuse an existing item verbatim if the combination logically yields " +
    "one of them, otherwise invent a new one that fits the same style/power-level):\n- " +
    names.join("\n- ");
}

async function inventItem(a, b) {
  const sys =
    "You are the world-law engine of CANON, an open-ended sandbox where the result of " +
    "combining two things becomes permanent canon for ALL players. " +
    "Given two input items (as JSON), invent the single most plausible resulting item. " +
    "Be creative but logical and internally consistent with the established world. " +
    "Reply with ONLY a JSON object, no prose, matching exactly this shape:\n" +
    "{\n" +
    '  "name": string,\n' +
    '  "emoji": string (one emoji),\n' +
    '  "color": string (hex like #88cc44),\n' +
    '  "rarity": "common"|"uncommon"|"rare"|"epic"|"legendary",\n' +
    '  "category": "tool"|"block"|"material"|"weapon"|"consumable"|"decoration"|"misc",\n' +
    '  "placeable": boolean (true if it makes sense to place this in the world as a block, e.g. stone/wood/blocks/decorations),\n' +
    '  "tool": null OR {"targets": string[] (which materials it breaks fast, e.g. ["wood"],["stone"],["dirt","grass"]), "speed": number 2-6 (mining speed multiplier)},\n' +
    '  "description": string (<=140 chars)\n' +
    "}\n" +
    "Rules: a tool (axe/pickaxe/shovel/etc.) MUST have category 'tool', placeable false, and a non-null tool object. " +
    "A raw material/block MUST have placeable true and tool null. Be logical about targets: axe->wood, pickaxe->stone, shovel->dirt/grass.";

  const user =
    "Item A:\n" + JSON.stringify(a) + "\n\nItem B:\n" + JSON.stringify(b) +
    canonContext() +
    "\n\nInvent the crafted result.";

  const resp = await fetch(GEMINI_URL(MODEL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 1.0, responseMimeType: "application/json" },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  let text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  // strip code fences if present
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM did not return JSON: " + text);
  const obj = JSON.parse(text.slice(start, end + 1));

  // normalize / guard
  let tool = null;
  if (obj.tool && typeof obj.tool === "object") {
    const targets = Array.isArray(obj.tool.targets)
      ? obj.tool.targets.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
      : [];
    const speed = Number(obj.tool.speed);
    tool = { targets, speed: Number.isFinite(speed) ? Math.min(8, Math.max(1.2, speed)) : 3 };
  }
  return {
    name: String(obj.name || "Unknown").slice(0, 60),
    emoji: String(obj.emoji || "✨").slice(0, 8),
    color: /^#[0-9a-fA-F]{6}$/.test(obj.color || "") ? obj.color : "#aaaaaa",
    rarity: ["common", "uncommon", "rare", "epic", "legendary"].includes(obj.rarity)
      ? obj.rarity
      : "common",
    category: ["tool", "block", "material", "weapon", "consumable", "decoration", "misc"].includes(obj.category)
      ? obj.category
      : "misc",
    placeable: tool ? false : Boolean(obj.placeable),
    tool,
    description: String(obj.description || "").slice(0, 160),
  };
}

// ---- LLM (Gemini): generate a simple item icon -------------------------
const IMAGE_MODEL = "gemini-2.5-flash-image";

async function generateIcon(item) {
  try {
    const prompt =
      `A simple, cute pixel-art game item icon of "${item.name}" (${item.description}). ` +
      `Single centered object, flat colors, minimalist, on a plain solid white background. ` +
      `No text, no border, no shadow. Video game inventory icon style.`;
    const resp = await fetch(GEMINI_URL(IMAGE_MODEL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    if (!resp.ok) {
      console.error(`icon gen ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData?.data);
    if (!img) return null;
    const mime = img.inlineData.mimeType || "image/png";
    return `data:${mime};base64,${img.inlineData.data}`;
  } catch (e) {
    console.error("icon gen failed:", e.message);
    return null;
  }
}

// ---- API ----------------------------------------------------------------
app.post("/api/craft", async (req, res) => {
  try {
    const { a, b, handle } = req.body || {};
    if (!a || !b || !a.name || !b.name) {
      return res.status(400).json({ error: "two items {name,...} required" });
    }
    const key = comboKey(a, b);

    // Known canon -> reproduce from DB, no LLM call (free, global consistency)
    const cached = getCombo.get(key);
    if (cached) {
      console.log(`[craft] cache  ${key}`);
      return res.json({
        result: JSON.parse(cached.result_json),
        source: "cache",
        discovery: { first: false, by: cached.discoverer || null },
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set on server" });
    }

    const now = Date.now();
    const ip = req.ip || "unknown";
    if (rateLimited(ip, now)) {
      return res.status(429).json({ error: "発見のペースが速すぎます。少し待ってね。" });
    }
    if (newToday(now) >= MAX_NEW_PER_DAY) {
      return res.status(503).json({
        error: "本日の『世界初の発見』上限に達しました。既知の組み合わせは引き続き遊べます。",
      });
    }

    const who = cleanHandle(handle);
    const result = await inventItem(a, b);
    if (ENABLE_IMAGES) result.image = await generateIcon(result); // null -> emoji fallback
    result.discoverer = who;
    result.discoveredAt = now;
    putCombo.run(key, JSON.stringify(result), now, who);
    console.log(
      `[craft] LLM    ${key} => ${result.emoji} ${result.name} ` +
      `[${result.category}${result.tool ? " tool x" + result.tool.speed : ""}${result.placeable ? " placeable" : ""}] ` +
      `by ${who} ${result.image ? "+icon" : "no-icon"}`
    );
    res.json({ result, source: "llm", discovery: { first: true, by: who } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Global feed of recent world-first discoveries (lightweight: no images)
app.get("/api/feed", (_req, res) => {
  const rows = feedRows.all(15).map((r) => {
    try {
      const x = JSON.parse(r.result_json);
      return { name: x.name, emoji: x.emoji, rarity: x.rarity, by: r.discoverer || "anonymous", at: r.created_at };
    } catch { return null; }
  }).filter(Boolean);
  res.json({ feed: rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CANON running: http://localhost:${PORT} (images:${ENABLE_IMAGES?"on":"off"}, cap:${MAX_NEW_PER_DAY}/day)`));
