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

// Создание таблицы для прогресса при запуске
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

const SYSTEM_PROMPT = `Ti si Marko, prijateljski bobar 🦫 koji pomaže ljudima da nauče srpski jezik.
PRAVILA:
1. Uvek odgovaraj SAMO na srpskom jeziku.
2. Odgovori kratki: 1-2 rečenice.
3. Budi prijateljski i podstiči korisnika.`;

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body || {};
  if (!message) return res.status(400).json({ error: "empty message" });

  if (!openai) {
    return res.json({ reply: "Извини, тренутно сам офлајн.", fallback: true });
  }

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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`🦫 BOBOR-LINGUO на порту ${PORT}`));
