import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" })); // Увеличили лимит для аудио

app.use(express.static(__dirname));
app.use("/data", express.static(path.join(__dirname, "data")));
app.use("/images", express.static(path.join(__dirname, "images")));

// Создаём папку для аудио, если её нет
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    console.log("📁 Папка audio создана");
}

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

const ADMIN_EMAIL = "mar.maks999@gmail.com";
const ADMIN_PASS = "1495";

async function initDB() {
    if (!db) { console.log("⚠️ Turso не настроен"); return; }
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, password TEXT, role TEXT DEFAULT 'user')`);
        // audio_data теперь будет хранить короткий путь к файлу, а не огромный base64
        await db.execute(`CREATE TABLE IF NOT EXISTS bobor_audio (audio_key TEXT PRIMARY KEY, audio_data TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS bobor_progress (username TEXT PRIMARY KEY, xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, medals TEXT DEFAULT '[]', last_daily TEXT, units_done TEXT DEFAULT '[]', lessons_today INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        
        const adm = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [ADMIN_EMAIL] });
        if (adm.rows.length === 0) {
            await db.execute({ sql: "INSERT INTO users (email, password, role) VALUES (?, ?, ?)", args: [ADMIN_EMAIL, ADMIN_PASS, "admin"] });
        }
        console.log("✅ База данных готова");
    } catch (e) { console.error("❌ Ошибка инициализации БД: ", e.message); }
}
initDB();

app.post("/api/register", async (req, res) => {
    const { email, password } = req.body;
    if (!db) return res.status(500).json({ error: "База данных не настроена" });
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
    if (!db) return res.status(500).json({ error: "База данных не настроена" });
    try {
        const u = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] });
        if (u.rows.length === 0) return res.status(401).json({ error: "Аккаунт не найден" });
        if (u.rows[0].password !== password) return res.status(401).json({ error: "Неверный пароль" });
        res.json({ success: true, user: { email: u.rows[0].email, role: u.rows[0].role } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ API: Сохранение аудио В ФАЙЛ
app.post("/api/save-audio", async (req, res) => {
    const { key, audioBase64, role } = req.body;
    if (role !== "admin") return res.status(403).json({ error: "Только администратор" });
    if (!db) return res.status(500).json({ error: "База данных не настроена" });

    try {
        const match = audioBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: "Неверный формат аудио" });

        const mimeType = match[1];
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, "base64");

        const ext = mimeType.includes("webm") ? ".webm" : mimeType.includes("mp4") ? ".mp4" : mimeType.includes("wav") ? ".wav" : ".bin";
        const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const fileName = `${safeKey}${ext}`;
        const filePath = path.join(AUDIO_DIR, fileName);

        fs.writeFileSync(filePath, buffer);
        console.log(`💾 Сохранено: ${fileName} (${buffer.length} байт)`);

        // В базу пишем ТОЛЬКО короткий путь, ошибки 400 больше не будет
        const relativePath = `audio/${fileName}`;
        await db.execute({
            sql: `INSERT INTO bobor_audio (audio_key, audio_data) VALUES (?, ?) ON CONFLICT(audio_key) DO UPDATE SET audio_data = ?`,
            args: [key, relativePath, relativePath]
        });

        res.json({ success: true, path: relativePath, size: buffer.length });
    } catch (e) {
        console.error("Save audio error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ✅ API: Получение аудио ИЗ ФАЙЛА
app.get("/api/get-audio/:key", async (req, res) => {
    if (!db) return res.json({ audio: null });
    try {
        const r = await db.execute({ sql: "SELECT audio_data FROM bobor_audio WHERE audio_key = ?", args: [req.params.key] });
        if (r.rows.length === 0) return res.json({ audio: null });

        const dbValue = r.rows[0].audio_data;
        
        // Если в базе лежит путь к файлу
        if (dbValue && dbValue.startsWith("audio/")) {
            const fullPath = path.join(__dirname, dbValue);
            if (!fs.existsSync(fullPath)) {
                console.log(`⚠️ Файл не найден: ${fullPath}`);
                return res.json({ audio: null });
            }
            const buffer = fs.readFileSync(fullPath);
            const base64 = buffer.toString("base64");
            const ext = path.extname(fullPath).toLowerCase();
            const mimeMap = { ".webm": "audio/webm", ".mp4": "audio/mp4", ".wav": "audio/wav" };
            const mime = mimeMap[ext] || "audio/webm";
            return res.json({ audio: `data:${mime};base64,${base64}` });
        }
        
        // Fallback: если там вдруг остался старый base64
        return res.json({ audio: dbValue });

    } catch (e) {
        console.error("Get audio error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ✅ API: Удаление аудио (удаляем файл с диска и запись из БД)
app.post("/api/delete-audio", async (req, res) => {
    const { key, role } = req.body;
    if (role !== "admin") return res.status(403).json({ error: "Только администратор" });
    if (!db) return res.json({ success: false });

    try {
        const r = await db.execute({ sql: "SELECT audio_data FROM bobor_audio WHERE audio_key = ?", args: [key] });
        if (r.rows.length > 0) {
            const dbValue = r.rows[0].audio_data;
            if (dbValue && dbValue.startsWith("audio/")) {
                const fullPath = path.join(__dirname, dbValue);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    console.log(`🗑️ Удалён файл: ${fullPath}`);
                }
            }
        }
        await db.execute({ sql: "DELETE FROM bobor_audio WHERE audio_key = ?", args: [key] });
        res.json({ success: true });
    } catch (e) {
        console.error("Delete audio error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/sync-progress", async (req, res) => {
    const { username, xp, streak, medals, last_daily, units_done, lessons_today } = req.body;
    if (!db) return res.json({ success: false });
    try {
        await db.execute({
            sql: `INSERT INTO bobor_progress (username, xp, streak, medals, last_daily, units_done, lessons_today) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET xp=?, streak=?, medals=?, last_daily=?, units_done=?, lessons_today=?`,
            args: [username, xp, streak, JSON.stringify(medals), last_daily, JSON.stringify(units_done), lessons_today, xp, streak, JSON.stringify(medals), last_daily, JSON.stringify(units_done), lessons_today]
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

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

app.listen(PORT, () => console.log(`🦫 Сервер запущен на порту ${PORT}`));
