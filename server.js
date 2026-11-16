import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";
import fs from "fs"; // Добавили модуль файловой системы

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));

// Явно указываем пути для статики
app.use(express.static(path.join(__dirname)));
app.use("/data", express.static(path.join(__dirname, "data")));

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

const ADMIN_EMAIL = "mar.maks999@gmail.com";
const ADMIN_PASS = "1495";

async function initDB() {
    if (!db) return console.log("⚠️ Turso не настроен");
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users ( email TEXT PRIMARY KEY, password TEXT, role TEXT DEFAULT 'user' )`);
        await db.execute(`CREATE TABLE IF NOT EXISTS bobor_audio ( audio_key TEXT PRIMARY KEY, audio_data TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )`);
        await db.execute(`CREATE TABLE IF NOT EXISTS bobor_progress ( username TEXT PRIMARY KEY, xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, medals TEXT DEFAULT '[]', last_daily TEXT, units_done TEXT DEFAULT '[]', lessons_today INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )`);
        
        const adm = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [ADMIN_EMAIL] });
        if (adm.rows.length === 0) {
            await db.execute({ sql: "INSERT INTO users (email, password, role) VALUES (?, ?, ?)", args: [ADMIN_EMAIL, ADMIN_PASS, "admin"] });
        }
        console.log("✅ База готова");
    } catch (e) { console.error("❌ Ошибка БД: ", e.message); }
}
initDB();

// --- API Routes ---
app.post("/api/register", async (req, res) => {
    const { email, password } = req.body;
    if (!db) return res.status(500).json({ error: "Нет БД" });
    try {
        const check = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] });
        if (check.rows.length > 0) return res.status(400).json({ error: "Email уже занят" });
        await db.execute({ sql: "INSERT INTO users (email, password, role) VALUES (?, ?, 'user')", args: [email, password] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) return res.json({ success: true, user: { email, role: "admin" } });
    if (!db) return res.status(500).json({ error: "Нет БД" });
    try {
        const u = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] });
        if (u.rows.length === 0) return res.status(401).json({ error: "Аккаунт не найден" });
        if (u.rows[0].password !== password) return res.status(401).json({ error: "Неверный пароль" });
        res.json({ success: true, user: { email: u.rows[0].email, role: u.rows[0].role } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/save-audio", async (req, res) => {
    const { key, audioBase64, role } = req.body;
    if (role !== "admin") return res.status(403).json({ error: "Только админ" });
    if (!db) return res.json({ success: false });
    try {
        await db.execute({ sql: `INSERT INTO bobor_audio (audio_key, audio_data) VALUES (?, ?) ON CONFLICT(audio_key) DO UPDATE SET audio_data = ?`, args: [key, audioBase64, audioBase64] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/get-audio/:key", async (req, res) => {
    if (!db) return res.json({ audio: null });
    try {
        const r = await db.execute({ sql: "SELECT audio_data FROM bobor_audio WHERE audio_key = ?", args: [req.params.key] });
        if (r.rows.length === 0) return res.json({ audio: null });
        res.json({ audio: r.rows[0].audio_data });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/delete-audio", async (req, res) => {
    const { key, role } = req.body;
    if (role !== "admin") return res.status(403).json({ error: "Только админ" });
    if (!db) return res.json({ success: false });
    try {
        await db.execute({ sql: "DELETE FROM bobor_audio WHERE audio_key = ?", args: [key] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/sync-progress", async (req, res) => {
    const { username, xp, streak, medals, last_daily, units_done, lessons_today } = req.body;
    if (!db) return res.json({ success: false });
    try {
        await db.execute({
            sql: `INSERT INTO bobor_progress (username, xp, streak, medals, last_daily, units_done, lessons_today) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET xp=?, streak=?, medals=?, last_daily=?, units_done=?, lessons_today=?`,
            args: [username, xp, streak, JSON.stringify(medals), last_daily, JSON.stringify(units_done), lessons_today,
                   xp, streak, JSON.stringify(medals), last_daily, JSON.stringify(units_done), lessons_today]
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

let openai = null;
if (process.env.GEMINI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" });
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
    } catch (e) { res.json({ reply: "Ошибка AI" }); }
});

// --- SPA Fallback (Исправлено) ---
app.get("*", (req, res) => {
    const indexPath = path.resolve(__dirname, "index.html");
    
    // Проверяем, существует ли файл физически
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        // Если файла нет, отдаем понятную ошибку вместо 500
        res.status(404).send(`
            <h1>Ошибка деплоя</h1>
            <p>Файл index.html не найден по пути: ${indexPath}</p>
            <p>Проверьте, что файл лежит в корне репозитория.</p>
        `);
    }
});

app.listen(PORT, () => console.log(`🦫 Сервер запущен на порту ${PORT}`));
