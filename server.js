import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client"; // Библиотека Turso

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- ПОДКЛЮЧЕНИЕ К TURSO ---
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

async function initDB() {
  if (!db) return console.log("⚠️ Turso не настроен, прогресс будет только в браузере");
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bobor_progress (
        username TEXT PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        learned_words TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Таблица bobor_progress в Turso готова");

    const cols = await db.execute("PRAGMA table_info(bobor_progress)");
    const existing = new Set(cols.rows.map(r => r.name));
    const newCols = [
      ["medals", "TEXT DEFAULT '[]'"],
      ["active_medal", "TEXT DEFAULT NULL"],
      ["freeze_count", "INTEGER DEFAULT 0"],
      ["last_daily", "DATE DEFAULT NULL"],
      ["season_xp", "INTEGER DEFAULT 0"],
      ["season_id", "TEXT DEFAULT NULL"],
      ["course", "TEXT DEFAULT 'sr'"]
    ];
    for (const [name, def] of newCols) {
      if (!existing.has(name)) {
        await db.execute(`ALTER TABLE bobor_progress ADD COLUMN ${name} ${def}`);
        console.log(`  ➕ добавлена колонка ${name}`);
      }
    }
    console.log("✅ Колонки bobor_progress проверены");

    await db.execute(`
      CREATE TABLE IF NOT EXISTS bobor_ranked (
        username TEXT PRIMARY KEY,
        season_xp INTEGER DEFAULT 0,
        season_id TEXT,
        course TEXT DEFAULT 'sr',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Таблица bobor_ranked в Turso готова");
  } catch (e) {
    console.error("❌ Ошибка базы Turso:", e.message);
  }
}
initDB();

// --- GEMINI ---
let openai = null;
if (process.env.GEMINI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, openai: !!openai, model: "gemini-2.0-flash", turso: !!db });
});

// --- [НОВОЕ] buildSystemPrompt(course) ---
const COURSE_NAMES = {
  sr: "serbian", be: "belarusian", kk: "kazakh",
  tt: "tatar", pl: "polish", tr: "turkish"
};
const COURSE_NATIVE = {
  sr: "српски", be: "беларуская", kk: "қазақша",
  tt: "татарча", pl: "polski", tr: "türkçe"
};

function buildSystemPrompt(course) {
  const name = COURSE_NAMES[course] || "serbian";
  const native = COURSE_NATIVE[course] || "српски";
  return `Ti si Marko, prijateljski bobar 🦫 koji pomaže ljudima da nauče ${name} jezik (${native}).
PRAVILA:
1. Uvek odgovaraj SAMO na ${name} jeziku (${native}).
2. Odgovori kratki: 1-2 rečenice.
3. Budi prijateljski i podstiči korisnika.
4. Ako korisnik greši, blago ga ispravi.`;
}

app.post("/api/chat", async (req, res) => {
  const { message, history, course } = req.body || {};
  if (!message) return res.status(400).json({ error: "empty message" });

  if (!openai) {
    return res.json({ reply: "Извини, тренутно сам офлајн.", fallback: true });
  }

  try {
    const messages = [{ role: "system", content: buildSystemPrompt(course) }];
    if (Array.isArray(history)) {
      history.slice(-10).forEach(m => {
        messages.push({ role: m.who === "user" ? "user" : "assistant", content: m.sr });
      });
    }
    messages.push({ role: "user", content: message.trim() });

    const completion = await openai.chat.completions.create({
      model: "gemini-2.0-flash",
      messages,
      max_tokens: 150
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("AI Error:", err);
    res.status(500).json({ reply: "Марко је заузет, покушај поново." });
  }
});

// --- ПРОГРЕСС (TURSO) ---
app.post("/api/progress", async (req, res) => {
  const { username, xp, streak, learnedWords } = req.body;
  if (!db) return res.json({ success: false, error: "no_db" });
  if (!username) return res.status(400).json({ error: "no_username" });

  try {
    await db.execute({
      sql: `INSERT INTO bobor_progress (username, xp, streak, learned_words) 
            VALUES (?, ?, ?, ?) 
            ON CONFLICT(username) DO UPDATE SET 
            xp = ?, streak = ?, learned_words = ?, updated_at = CURRENT_TIMESTAMP`,
      args: [username, xp, streak, JSON.stringify(learnedWords), xp, streak, JSON.stringify(learnedWords)]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/progress/:username", async (req, res) => {
  if (!db) return res.json(null);
  try {
    const r = await db.execute({
      sql: "SELECT * FROM bobor_progress WHERE username = ?",
      args: [req.params.username]
    });
    res.json(r.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- РАНКЕД ---
app.post("/api/ranked/sync", async (req, res) => {
  const { username, seasonXp, seasonId, course } = req.body || {};
  if (!db) return res.json({ success: false, error: "no_db" });
  if (!username) return res.status(400).json({ error: "no_username" });
  try {
    await db.execute({
      sql: `INSERT INTO bobor_ranked (username, season_xp, season_id, course)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
            season_xp = ?, season_id = ?, course = ?, updated_at = CURRENT_TIMESTAMP`,
      args: [username, Number(seasonXp) || 0, seasonId || null, course || "sr",
             Number(seasonXp) || 0, seasonId || null, course || "sr"]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ranked/leaderboard", async (req, res) => {
  if (!db) return res.json({ rows: [] });
  try {
    const r = await db.execute(
      "SELECT username, season_xp, course FROM bobor_ranked ORDER BY season_xp DESC LIMIT 50"
    );
    res.json({ rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ranked/close-season", async (req, res) => {
  if (!db) return res.json({ success: false, error: "no_db" });
  const mode = (req.body && req.body.mode) === "quarter" ? "quarter" : "month";
  try {
    const top = await db.execute(
      "SELECT username, season_xp FROM bobor_ranked ORDER BY season_xp DESC LIMIT 1"
    );
    const winner = top.rows[0] || null;

    if (mode === "quarter") {
      await db.execute("UPDATE bobor_ranked SET season_xp = 0, updated_at = CURRENT_TIMESTAMP");
    } else {
      await db.execute("UPDATE bobor_ranked SET season_xp = CAST(season_xp * 0.3 AS INTEGER), updated_at = CURRENT_TIMESTAMP");
    }

    if (winner && winner.username) {
      await db.execute({
        sql: `UPDATE bobor_progress
              SET xp = xp + 300, season_xp = COALESCE(season_xp,0) + 300, updated_at = CURRENT_TIMESTAMP
              WHERE username = ?`,
        args: [winner.username]
      });
      await db.execute({
        sql: `UPDATE bobor_ranked
              SET season_xp = season_xp + 300, updated_at = CURRENT_TIMESTAMP
              WHERE username = ?`,
        args: [winner.username]
      });
    }

    res.json({ success: true, mode, winner: winner ? winner.username : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/profile/sync", async (req, res) => {
  const { username, medals, activeMedal, freezeCount, lastDaily, seasonXp, seasonId, course } = req.body || {};
  if (!db) return res.json({ success: false, error: "no_db" });
  if (!username) return res.status(400).json({ error: "no_username" });
  try {
    await db.execute({
      sql: `INSERT INTO bobor_progress (username, medals, active_medal, freeze_count, last_daily, season_xp, season_id, course)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
            medals = ?, active_medal = ?, freeze_count = ?, last_daily = ?, season_xp = ?, season_id = ?, course = ?, updated_at = CURRENT_TIMESTAMP`,
      args: [username, JSON.stringify(medals || []), activeMedal || null,
             Number(freezeCount) || 0, lastDaily || null, Number(seasonXp) || 0, seasonId || null, course || "sr",
             JSON.stringify(medals || []), activeMedal || null,
             Number(freezeCount) || 0, lastDaily || null, Number(seasonXp) || 0, seasonId || null, course || "sr"]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`🦫 BOBOR-LINGUO на порту ${PORT}`));
