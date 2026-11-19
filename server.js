import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));

app.use(express.static(__dirname));
app.use("/data", express.static(path.join(__dirname, "data")));
app.use("/images", express.static(path.join(__dirname, "images")));

// ============================================
// ХРАНИЛИЩЕ НА ДИСКЕ (вместо Turso)
// ============================================
const DATA_DIR = path.join(__dirname, "storage");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");
const AUDIO_INDEX_FILE = path.join(DATA_DIR, "audio-index.json");

// Создаём папки и файлы если их нет
function ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(PROGRESS_FILE)) fs.writeFileSync(PROGRESS_FILE, JSON.stringify({}, null, 2));
    if (!fs.existsSync(AUDIO_INDEX_FILE)) fs.writeFileSync(AUDIO_INDEX_FILE, JSON.stringify({}, null, 2));
    console.log("📁 Хранилище готово:", DATA_DIR);
}
ensureStorage();

// Чтение/запись JSON
function readJSON(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// Данные администратора
const ADMIN_EMAIL = "mar.maks999@gmail.com";
const ADMIN_PASS = "1495";

// Создаём админа при старте
function ensureAdmin() {
    const users = readJSON(USERS_FILE);
    if (!users[ADMIN_EMAIL]) {
        users[ADMIN_EMAIL] = { email: ADMIN_EMAIL, password: ADMIN_PASS, role: "admin" };
        writeJSON(USERS_FILE, users);
        console.log("✅ Администратор создан");
    }
}
ensureAdmin();

// ============================================
// API: Регистрация
// ============================================
app.post("/api/register", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Заполни все поля" });

    const users = readJSON(USERS_FILE);
    if (users[email]) return res.status(400).json({ error: "Email уже занят" });

    users[email] = { email, password, role: "user" };
    writeJSON(USERS_FILE, users);
    res.json({ success: true });
});

// ============================================
// API: Вход
// ============================================
app.post("/api/login", (req, res) => {
    const { email, password } = req.body;

    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
        return res.json({ success: true, user: { email, role: "admin" } });
    }

    const users = readJSON(USERS_FILE);
    const u = users[email];
    if (!u) return res.status(401).json({ error: "Аккаунт не найден" });
    if (u.password !== password) return res.status(401).json({ error: "Неверный пароль" });

    res.json({ success: true, user: { email: u.email, role: u.role } });
});

// ============================================
// API: Сохранение аудио В ФАЙЛ
// ============================================
app.post("/api/save-audio", (req, res) => {
    const { key, audioBase64, role } = req.body;

    console.log("🔍 save-audio:", { key, role, type: typeof audioBase64, len: audioBase64?.length });

    if (role !== "admin") return res.status(403).json({ error: "Только администратор" });
    if (!audioBase64 || typeof audioBase64 !== "string") {
        return res.status(400).json({ error: "Аудио не передано" });
    }

    // Парсим data URL. Допускаем варианты:
    // data:audio/webm;base64,XXXX
    // data:audio/webm;codecs=opus;base64,XXXX
    // data:;base64,XXXX
    const match = audioBase64.match(/^data:([^,]*?)?base64,(.+)$/);
    if (!match) {
        console.error("❌ Не распознан data URL. Начало:", audioBase64.substring(0, 100));
        return res.status(400).json({ error: "Неверный формат аудио. Ожидался data URL." });
    }

    const mimePart = match[1] || "";
    const base64Data = match[2];

    try {
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length === 0) return res.status(400).json({ error: "Аудио пустое" });

        let ext = ".webm";
        if (mimePart.includes("mp4")) ext = ".mp4";
        else if (mimePart.includes("wav")) ext = ".wav";
        else if (mimePart.includes("ogg")) ext = ".ogg";

        const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const fileName = `${safeKey}${ext}`;
        const filePath = path.join(AUDIO_DIR, fileName);

        fs.writeFileSync(filePath, buffer);
        console.log(`💾 Файл сохранён: ${fileName} (${buffer.length} байт)`);

        // Обновляем индекс
        const index = readJSON(AUDIO_INDEX_FILE);
        index[key] = {
            file: fileName,
            mime: mimePart || "audio/webm",
            size: buffer.length,
            updated: new Date().toISOString()
        };
        writeJSON(AUDIO_INDEX_FILE, index);

        res.json({ success: true, file: fileName, size: buffer.length });
    } catch (e) {
        console.error("❌ Ошибка сохранения:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Получение аудио ИЗ ФАЙЛА
// ============================================
app.get("/api/get-audio/:key", (req, res) => {
    const key = req.params.key;
    const index = readJSON(AUDIO_INDEX_FILE);
    const entry = index[key];

    if (!entry) return res.json({ audio: null });

    const filePath = path.join(AUDIO_DIR, entry.file);
    if (!fs.existsSync(filePath)) {
        console.log("⚠️ Файл потерян:", filePath);
        return res.json({ audio: null });
    }

    try {
        const buffer = fs.readFileSync(filePath);
        const base64 = buffer.toString("base64");
        res.json({ audio: `data:${entry.mime};base64,${base64}` });
    } catch (e) {
        console.error("❌ Ошибка чтения:", e.message);
        res.json({ audio: null });
    }
});

// ============================================
// API: Удаление аудио
// ============================================
app.post("/api/delete-audio", (req, res) => {
    const { key, role } = req.body;
    if (role !== "admin") return res.status(403).json({ error: "Только администратор" });

    try {
        const index = readJSON(AUDIO_INDEX_FILE);
        const entry = index[key];
        if (entry) {
            const filePath = path.join(AUDIO_DIR, entry.file);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            delete index[key];
            writeJSON(AUDIO_INDEX_FILE, index);
            console.log("🗑️ Удалено:", key);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Синхронизация прогресса
// ============================================
app.post("/api/sync-progress", (req, res) => {
    const { username, xp, streak, medals, last_daily, units_done, lessons_today } = req.body;
    if (!username) return res.status(400).json({ error: "Нет username" });

    const progress = readJSON(PROGRESS_FILE);
    progress[username] = {
        xp, streak, medals, last_daily, units_done, lessons_today,
        updated: new Date().toISOString()
    };
    writeJSON(PROGRESS_FILE, progress);
    res.json({ success: true });
});

// ============================================
// API: Получение прогресса (для ранкеда)
// ============================================
app.get("/api/leaderboard", (req, res) => {
    const progress = readJSON(PROGRESS_FILE);
    const list = Object.entries(progress)
        .map(([username, data]) => ({
            n: username.split("@")[0],
            x: data.xp || 0
        }))
        .sort((a, b) => b.x - a.x)
        .slice(0, 20);
    res.json({ leaders: list });
});

// ============================================
// API: Чат с AI (Gemini)
// ============================================
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
            messages: [
                { role: "system", content: `Отвечай на языке: ${course}` },
                { role: "user", content: message }
            ],
            max_tokens: 100
        });
        res.json({ reply: completion.choices[0].message.content });
    } catch (e) {
        res.json({ reply: "Ошибка AI" });
    }
});

// ============================================
// SPA fallback
// ============================================
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
    console.log(`🦫 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Хранилище: ${DATA_DIR}`);
});
