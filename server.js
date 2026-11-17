import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";

// Загрузка переменных окружения
dotenv.config();

// Получение пути к текущему файлу
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Инициализация Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для парсинга JSON (увеличен лимит для аудио)
app.use(express.json({ limit: "50mb" }));

// Раздача статических файлов
app.use(express.static(__dirname));
app.use("/data", express.static(path.join(__dirname, "data")));
app.use("/images", express.static(path.join(__dirname, "images")));

// Папка для аудио — создаём если нет
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    console.log("📁 Папка audio создана");
}

// Подключение к базе данных Turso
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN
}) : null;

// Данные администратора
const ADMIN_EMAIL = "mar.maks999@gmail.com";
const ADMIN_PASS = "1495";

// Инициализация базы данных
async function initDB() {
    if (!db) {
        console.log("⚠️ Turso не настроен");
        return;
    }

    try {
        // Создание таблицы пользователей
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                password TEXT,
                role TEXT DEFAULT 'user'
            )
        `);

        // Создание таблицы аудио (audio_data теперь хранит путь к файлу, а не base64)
        await db.execute(`
            CREATE TABLE IF NOT EXISTS bobor_audio (
                audio_key TEXT PRIMARY KEY,
                audio_data TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Создание таблицы прогресса
        await db.execute(`
            CREATE TABLE IF NOT EXISTS bobor_progress (
                username TEXT PRIMARY KEY,
                xp INTEGER DEFAULT 0,
                streak INTEGER DEFAULT 0,
                medals TEXT DEFAULT '[]',
                last_daily TEXT,
                units_done TEXT DEFAULT '[]',
                lessons_today INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Создание администратора, если его нет
        const adm = await db.execute({
            sql: "SELECT * FROM users WHERE email = ?",
            args: [ADMIN_EMAIL]
        });

        if (adm.rows.length === 0) {
            await db.execute({
                sql: "INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
                args: [ADMIN_EMAIL, ADMIN_PASS, "admin"]
            });
            console.log("✅ Администратор создан");
        }

        console.log("✅ База данных готова");
    } catch (e) {
        console.error("❌ Ошибка инициализации БД: ", e.message);
    }
}

// Запуск инициализации
initDB();

// ============================================
// API: Регистрация
// ============================================
app.post("/api/register", async (req, res) => {
    const { email, password } = req.body;

    if (!db) {
        return res.status(500).json({ error: "База данных не настроена" });
    }

    try {
        // Проверка существования пользователя
        const check = await db.execute({
            sql: "SELECT * FROM users WHERE email = ?",
            args: [email]
        });

        if (check.rows.length > 0) {
            return res.status(400).json({ error: "Email уже занят" });
        }

        // Создание нового пользователя
        await db.execute({
            sql: "INSERT INTO users (email, password, role) VALUES (?, ?, 'user')",
            args: [email, password]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Вход
// ============================================
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    // Проверка администратора
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
        return res.json({
            success: true,
            user: { email, role: "admin" }
        });
    }

    if (!db) {
        return res.status(500).json({ error: "База данных не настроена" });
    }

    try {
        const u = await db.execute({
            sql: "SELECT * FROM users WHERE email = ?",
            args: [email]
        });

        if (u.rows.length === 0) {
            return res.status(401).json({ error: "Аккаунт не найден" });
        }

        if (u.rows[0].password !== password) {
            return res.status(401).json({ error: "Неверный пароль" });
        }

        res.json({
            success: true,
            user: {
                email: u.rows[0].email,
                role: u.rows[0].role
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Сохранение аудио (В ФАЙЛ, а не в БД)
// ============================================
app.post("/api/save-audio", async (req, res) => {
    const { key, audioBase64, role } = req.body;

    console.log("🔍 Получен запрос на сохранение аудио:");
    console.log("   Ключ:", key);
    console.log("   Роль:", role);
    console.log("   Тип audioBase64:", typeof audioBase64);
    console.log("   Длина:", audioBase64 ? audioBase64.length : 0);
    if (audioBase64) {
        console.log("   Начало строки:", audioBase64.substring(0, 80));
    }

    if (role !== "admin") {
        return res.status(403).json({ error: "Только администратор" });
    }

    if (!db) {
        return res.status(500).json({ error: "База данных не настроена" });
    }

    if (!audioBase64 || typeof audioBase64 !== 'string') {
        return res.status(400).json({ error: "Аудио не передано или имеет неверный тип" });
    }

    try {
        // Парсим data URL: "data:audio/webm;base64,XXXX..." или "data:;base64,XXXX..."
        const match = audioBase64.match(/^data:([^;]*)?;?base64,(.+)$/);
        if (!match) {
            console.error("❌ Regex не совпал. Первые 100 символов:", audioBase64.substring(0, 100));
            return res.status(400).json({ error: "Неверный формат аудио. Ожидался data URL." });
        }

        const mimeType = match[1] || "audio/webm";
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, "base64");

        console.log(`   MIME тип: ${mimeType}, размер: ${buffer.length} байт`);

        // Определяем расширение
        const ext = mimeType.includes("webm") ? ".webm" 
                  : mimeType.includes("mp4") ? ".mp4" 
                  : mimeType.includes("wav") ? ".wav" 
                  : ".bin";
        
        // Безопасное имя файла (убираем спецсимволы)
        const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const fileName = `${safeKey}${ext}`;
        const filePath = path.join(AUDIO_DIR, fileName);

        // Сохраняем файл на диск
        fs.writeFileSync(filePath, buffer);
        console.log(`💾 Сохранено: ${filePath}`);

        // В базе храним только короткий путь к файлу
        const relativePath = `audio/${fileName}`;
        await db.execute({
            sql: `INSERT INTO bobor_audio (audio_key, audio_data) 
                  VALUES (?, ?) 
                  ON CONFLICT(audio_key) 
                  DO UPDATE SET audio_data = ?`,
            args: [key, relativePath, relativePath]
        });

        console.log(`✅ Запись в БД: ${key} -> ${relativePath}`);
        res.json({ success: true, path: relativePath, size: buffer.length });
    } catch (e) {
        console.error("❌ Ошибка сохранения аудио:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Получение аудио (ИЗ ФАЙЛА)
// ============================================
app.get("/api/get-audio/:key", async (req, res) => {
    if (!db) {
        return res.json({ audio: null });
    }

    try {
        const r = await db.execute({
            sql: "SELECT audio_data FROM bobor_audio WHERE audio_key = ?",
            args: [req.params.key]
        });

        if (r.rows.length === 0) {
            return res.json({ audio: null });
        }

        const dbValue = r.rows[0].audio_data;

        // Если в базе лежит путь к файлу (формат: "audio/ключ.webm")
        if (dbValue && dbValue.startsWith("audio/")) {
            const fullPath = path.join(__dirname, dbValue);
            
            if (!fs.existsSync(fullPath)) {
                console.log(`⚠️ Файл не найден: ${fullPath}`);
                return res.json({ audio: null });
            }

            const buffer = fs.readFileSync(fullPath);
            const base64 = buffer.toString("base64");
            
            // Определяем MIME по расширению файла
            const ext = path.extname(fullPath).toLowerCase();
            const mimeMap = { 
                ".webm": "audio/webm", 
                ".mp4": "audio/mp4", 
                ".wav": "audio/wav" 
            };
            const mime = mimeMap[ext] || "audio/webm";

            return res.json({ audio: `data:${mime};base64,${base64}` });
        }
        
        // Fallback: если там вдруг остался старый base64 напрямую
        return res.json({ audio: dbValue });

    } catch (e) {
        console.error("❌ Ошибка получения аудио:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Удаление аудио (файл + запись в БД)
// ============================================
app.post("/api/delete-audio", async (req, res) => {
    const { key, role } = req.body;

    if (role !== "admin") {
        return res.status(403).json({ error: "Только администратор" });
    }

    if (!db) {
        return res.json({ success: false });
    }

    try {
        // Сначала получаем путь к файлу из БД
        const r = await db.execute({
            sql: "SELECT audio_data FROM bobor_audio WHERE audio_key = ?",
            args: [key]
        });

        if (r.rows.length > 0) {
            const dbValue = r.rows[0].audio_data;
            
            // Если это путь к файлу — удаляем файл с диска
            if (dbValue && dbValue.startsWith("audio/")) {
                const fullPath = path.join(__dirname, dbValue);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    console.log(`🗑️ Удалён файл: ${fullPath}`);
                }
            }
        }

        // Удаляем запись из БД
        await db.execute({
            sql: "DELETE FROM bobor_audio WHERE audio_key = ?",
            args: [key]
        });

        res.json({ success: true });
    } catch (e) {
        console.error("❌ Ошибка удаления аудио:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// API: Синхронизация прогресса
// ============================================
app.post("/api/sync-progress", async (req, res) => {
    const { username, xp, streak, medals, last_daily, units_done, lessons_today } = req.body;

    if (!db) {
        return res.json({ success: false });
    }

    try {
        await db.execute({
            sql: `INSERT INTO bobor_progress 
                  (username, xp, streak, medals, last_daily, units_done, lessons_today) 
                  VALUES (?, ?, ?, ?, ?, ?, ?) 
                  ON CONFLICT(username) 
                  DO UPDATE SET xp=?, streak=?, medals=?, last_daily=?, units_done=?, lessons_today=?`,
            args: [
                username, xp, streak,
                JSON.stringify(medals),
                last_daily,
                JSON.stringify(units_done),
                lessons_today,
                xp, streak,
                JSON.stringify(medals),
                last_daily,
                JSON.stringify(units_done),
                lessons_today
            ]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

    if (!openai) {
        return res.json({ reply: "Офлайн режим" });
    }

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
// Обработка всех остальных запросов — отдаём index.html
// ============================================
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ============================================
// Запуск сервера
// ============================================
app.listen(PORT, () => {
    console.log(`🦫 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Аудио сохраняются в: ${AUDIO_DIR}`);
});
