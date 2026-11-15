const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

const MEDALS_CATALOG = {
  common: { id: 'common', name: 'Обычная медаль', price: 1200, icon: '🥉', desc: 'Базовый знак ученика' },
  wooden: { id: 'wooden', name: 'Деревянная медаль', price: 2000, icon: '🪵', desc: 'За упорство в сербском' },
  iron: { id: 'iron', name: 'Железная медаль', price: 3400, icon: '🛡️', desc: 'Твёрдые знания грамматики' },
  diamond: { id: 'diamond', name: 'Алмазная медаль', price: 4000, icon: '💎', desc: 'Редкий мастер языка' },
  netherite: { id: 'netherite', name: 'Незеритовая медаль', price: 5000, icon: '🖤', desc: 'Легенда BOBOR-LINGUO' }
};

const FREEZE_PRICE = 520;

function hashPass(pass) {
  return crypto.createHash('sha256').update(String(pass)).digest('hex');
}

function getMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getDateKey(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bolts INTEGER DEFAULT 0,
      season_bolts INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      freezes INTEGER DEFAULT 0,
      last_active_date TEXT DEFAULT '',
      medals TEXT DEFAULT '[]',
      equipped_medal TEXT DEFAULT '',
      modules_progress TEXT DEFAULT '{}',
      learned_letters TEXT DEFAULT '[]'
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const curMonth = getMonthKey();
  const res = await db.execute({
    sql: 'SELECT value FROM system_state WHERE key = ?',
    args: ['active_season']
  });

  if (res.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO system_state (key, value) VALUES (?, ?)',
      args: ['active_season', curMonth]
    });
  }
}

// Ежемесячный сброс ранкеда и награда +500 молний лидеру
async function checkMonthlySeason() {
  const curMonth = getMonthKey();
  const res = await db.execute({
    sql: 'SELECT value FROM system_state WHERE key = ?',
    args: ['active_season']
  });

  const savedMonth = res.rows[0]?.value;
  if (savedMonth && savedMonth !== curMonth) {
    const winnerRes = await db.execute(
      'SELECT id FROM users WHERE season_bolts > 0 ORDER BY season_bolts DESC, bolts DESC LIMIT 1'
    );

    if (winnerRes.rows.length > 0) {
      await db.execute({
        sql: 'UPDATE users SET bolts = bolts + 500 WHERE id = ?',
        args: [winnerRes.rows[0].id]
      });
    }

    await db.execute('UPDATE users SET season_bolts = 0');
    await db.execute({
      sql: 'UPDATE system_state SET value = ? WHERE key = ?',
      args: [curMonth, 'active_season']
    });
  }
}

// Проверка ежедневной серии и авто-применение заморозки
async function syncStreak(user) {
  const today = getDateKey(0);
  const yesterday = getDateKey(-1);
  const twoDaysAgo = getDateKey(-2);
  const last = user.last_active_date;

  if (!last || last === today || last === yesterday) {
    return user;
  }

  if (last === twoDaysAgo && user.freezes > 0) {
    const newFreezes = user.freezes - 1;
    await db.execute({
      sql: 'UPDATE users SET freezes = ?, last_active_date = ? WHERE id = ?',
      args: [newFreezes, yesterday, user.id]
    });
    user.freezes = newFreezes;
    user.last_active_date = yesterday;
  } else {
    await db.execute({
      sql: 'UPDATE users SET streak = 0 WHERE id = ?',
      args: [user.id]
    });
    user.streak = 0;
  }
  return user;
}

function sanitizeUser(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

// Вход или регистрация
app.post('/api/auth', async (req, res) => {
  try {
    await checkMonthlySeason();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();

    if (username.length < 2 || password.length < 3) {
      return res.status(400).json({ error: 'Ник от 2 символов, пароль от 3 символов' });
    }

    let result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
      await db.execute({
        sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        args: [username, hashPass(password)]
      });
      result = await db.execute({
        sql: 'SELECT * FROM users WHERE username = ?',
        args: [username]
      });
    } else if (result.rows[0].password_hash !== hashPass(password)) {
      return res.status(401).json({ error: 'Неверный пароль для этого никнейма' });
    }

    let user = { ...result.rows[0] };
    user = await syncStreak(user);

    res.json({
      user: sanitizeUser(user),
      medalsCatalog: MEDALS_CATALOG,
      freezePrice: FREEZE_PRICE
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сохранение прогресса модулей, букв и начисление молний
app.post('/api/progress', async (req, res) => {
  try {
    await checkMonthlySeason();
    const { username, earnedBolts, moduleId, moduleStep, learnedLetters } = req.body;

    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Игрок не найден' });

    let user = { ...result.rows[0] };
    user = await syncStreak(user);

    const today = getDateKey(0);
    let streak = user.streak;
    if (user.last_active_date !== today) {
      streak += 1;
    }

    const modProg = JSON.parse(user.modules_progress || '{}');
    if (moduleId) {
      modProg[moduleId] = Math.max(modProg[moduleId] || 0, Number(moduleStep) || 0);
    }

    const lettersJson = Array.isArray(learnedLetters)
      ? JSON.stringify(learnedLetters)
      : user.learned_letters;

    const add = Math.max(0, Number(earnedBolts) || 0);

    await db.execute({
      sql: `UPDATE users 
            SET bolts = bolts + ?, season_bolts = season_bolts + ?, streak = ?, 
                last_active_date = ?, modules_progress = ?, learned_letters = ?
            WHERE id = ?`,
      args: [add, add, streak, today, JSON.stringify(modProg), lettersJson, user.id]
    });

    const updated = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [user.id]
    });
    res.json({ user: sanitizeUser(updated.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

// Покупка медали или заморозки
app.post('/api/shop/buy', async (req, res) => {
  try {
    const { username, type, itemId } = req.body;
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Игрок не найден' });

    const user = result.rows[0];

    if (type === 'freeze') {
      if (user.bolts < FREEZE_PRICE) {
        return res.status(400).json({ error: 'Недостаточно молний для заморозки' });
      }
      await db.execute({
        sql: 'UPDATE users SET bolts = bolts - ?, freezes = freezes + 1 WHERE id = ?',
        args: [FREEZE_PRICE, user.id]
      });
    } else if (type === 'medal') {
      const medal = MEDALS_CATALOG[itemId];
      if (!medal) return res.status(400).json({ error: 'Медаль не найдена' });

      const owned = JSON.parse(user.medals || '[]');
      if (owned.includes(itemId)) return res.status(400).json({ error: 'Медаль уже куплена' });
      if (user.bolts < medal.price) return res.status(400).json({ error: 'Недостаточно молний' });

      owned.push(itemId);
      await db.execute({
        sql: 'UPDATE users SET bolts = bolts - ?, medals = ?, equipped_medal = ? WHERE id = ?',
        args: [medal.price, JSON.stringify(owned), itemId, user.id]
      });
    }

    const updated = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [user.id]
    });
    res.json({ user: sanitizeUser(updated.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка покупки' });
  }
});

// Смена надетой медали
app.post('/api/shop/equip', async (req, res) => {
  try {
    const { username, medalId } = req.body;
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Игрок не найден' });

    const user = result.rows[0];
    const owned = JSON.parse(user.medals || '[]');
    if (!owned.includes(medalId)) return res.status(400).json({ error: 'Медаль не куплена' });

    await db.execute({
      sql: 'UPDATE users SET equipped_medal = ? WHERE id = ?',
      args: [medalId, user.id]
    });

    const updated = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [user.id]
    });
    res.json({ user: sanitizeUser(updated.rows[0]) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Таблица лидеров ежемесячного ранкеда
app.get('/api/leaderboard', async (req, res) => {
  try {
    await checkMonthlySeason();
    const top = await db.execute(
      'SELECT username, season_bolts, bolts, streak, equipped_medal FROM users ORDER BY season_bolts DESC, bolts DESC LIMIT 50'
    );
    res.json({ season: getMonthKey(), players: top.rows });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка загрузки рейтинга' });
}
});
const PORT = process.env.PORT || 3000;
initDB().then(() => {
app.listen(PORT, () => console.log(BOBOR-LINGUO запущен на порту ${PORT}));
});
