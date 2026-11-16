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

app.use(express.json({ limit: "10mb" })); // Увеличил лимит для аудио
app.use(express.static(path.join(__dirname, "public")));

// --- ПОДКЛЮЧЕНИЕ К TURSO ---
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

async function initDB() {
  if (!db) return console.log("⚠️ Turso не настроен");
  try {
    // Таблица для аудио
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bobor_audio (
        audio_key TEXT PRIMARY KEY,
        audio_data TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица прогресса
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bobor_progress (
        username TEXT PRIMARY KEY,
        xp INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        medals TEXT DEFAULT '[]',
        last_daily TEXT,
        units_done TEXT DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ База данных готова");
  } catch (e) {
    console.error("❌ Ошибка БД:", e.message);
  }
}
initDB();

// --- API ДЛЯ АУДИО ---
app.post("/api/save-audio", async (req, res) => {
  const { key, audioBase64 } = req.body;
  if (!db) return res.json({ success: false, error: "no_db" });
  try {
    await db.execute({
      sql: `INSERT INTO bobor_audio (audio_key, audio_data) VALUES (?, ?) ON CONFLICT(audio_key) DO UPDATE SET audio_data = ?`,
      args: [key, audioBase64, audioBase64]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/get-audio/:key", async (req, res) => {
  if (!db) return res.json({ audio: null });
  try {
    const r = await db.execute({
      sql: "SELECT audio_data FROM bobor_audio WHERE audio_key = ?",
      args: [req.params.key]
    });
    if (r.rows.length === 0) return res.json({ audio: null });
    res.json({ audio: r.rows[0].audio_data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API ДЛЯ ПРОГРЕССА ---
app.post("/api/sync-progress", async (req, res) => {
  const { username, xp, streak, medals, last_daily, units_done } = req.body;
  if (!db) return res.json({ success: false });
  try {
    await db.execute({
      sql: `INSERT INTO bobor_progress (username, xp, streak, medals, last_daily, units_done) 
            VALUES (?, ?, ?, ?, ?, ?) 
            ON CONFLICT(username) DO UPDATE SET xp=?, streak=?, medals=?, last_daily=?, units_done=?`,
      args: [username, xp, streak, JSON.stringify(medals), last_daily, JSON.stringify(units_done),
             xp, streak, JSON.stringify(medals), last_daily, JSON.stringify(units_done)]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/get-progress/:username", async (req, res) => {
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

// --- GEMINI AI ---
let openai = null;
if (process.env.GEMINI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
  });
}

app.post("/api/chat", async (req, res) => {
  const { message, course } = req.body;
  if (!openai) return res.json({ reply: "Офлайн режим" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gemini-2.0-flash",
      messages: [{ role: "system", content: `Отвечай на языке: ${course}` }, { role: "user", content: message }],
      max_tokens: 100
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (e) {
    res.json({ reply: "Ошибка AI" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`🦫 Сервер запущен на порту ${PORT}`));
