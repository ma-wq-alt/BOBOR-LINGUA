import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

// Инициализация базы (добавили поля для молний, медалей и даты)
async function initDB() {
  if (!db) return console.log("⚠️ Turso не настроен");
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bobor_users (
        username TEXT PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        lightning INTEGER DEFAULT 0,
        medal TEXT DEFAULT 'none',
        streak INTEGER DEFAULT 1,
        freeze_count INTEGER DEFAULT 0,
        last_login TEXT,
        last_rank_win TEXT,
        learned_letters TEXT,
        learned_words TEXT,
        modules_progress TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Таблица bobor_users готова");
  } catch (e) {
    console.error("❌ Ошибка базы:", e.message);
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
  res.json({ ok: true, openai: !!openai, turso: !!db });
});

// --- ЧАТ ---
const SYSTEM_PROMPT = `Ti si Marko, prijateljski bobar 🦫 koji pomaže ljudima da nauče srpski jezik.
PRAVILA:
1. Uvek odgovaraj SAMO na srpskom jeziku.
2. Odgovori kratki: 1-2 rečenice.
3. Budi prijateljski i podstiči korisnika.`;

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body || {};
  if (!message) return res.status(400).json({ error: "empty message" });
  if (!openai) return res.json({ reply: "Извини, тренутно сам офлајн.", fallback: true });

  try {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }];
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
    res.status(500).json({ reply: "Марко је заузет." });
  }
});

// --- ПРОГРЕСС ПОЛЬЗОВАТЕЛЯ ---
app.get("/api/user/:username", async (req, res) => {
  if (!db) return res.json(null);
  try {
    const r = await db.execute({
      sql: "SELECT * FROM bobor_users WHERE username = ?",
      args: [req.params.username]
    });
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/user", async (req, res) => {
  const { username, xp, lightning, medal, streak, freeze_count, learned_letters, learned_words, modules_progress } = req.body;
  if (!db || !username) return res.json({ success: false });

  try {
    await db.execute({
      sql: `INSERT INTO bobor_users (username, xp, lightning, medal, streak, freeze_count, learned_letters, learned_words, modules_progress, last_login)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET 
            xp=?, lightning=?, medal=?, streak=?, freeze_count=?, learned_letters=?, learned_words=?, modules_progress=?, last_login=?`,
      args: [username, xp, lightning, medal, streak, freeze_count, learned_letters, learned_words, modules_progress, new Date().toISOString(),
             xp, lightning, medal, streak, freeze_count, learned_letters, learned_words, modules_progress, new Date().toISOString()]
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- РЕЙТИНГ (ТОП ИГРОКОВ) ---
app.get("/api/leaderboard", async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.execute("SELECT username, xp, lightning, medal FROM bobor_users ORDER BY lightning DESC LIMIT 10");
    res.json(r.rows);
  } catch (e) { res.json([]); }
});

app.listen(PORT, () => console.log(`🦫 BOBOR-LINGUO с геймификацией на порту ${PORT}`));
