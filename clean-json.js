import fs from 'fs';
import path from 'path';

// Функция рекурсивной очистки объекта от пробелов в ключах и значениях
function cleanJson(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(cleanJson);
    
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
        const cleanKey = key.trim();
        const cleanValue = typeof value === 'string' ? value.trim() : cleanJson(value);
        cleaned[cleanKey] = cleanValue;
    }
    return cleaned;
}

// Список файлов для очистки
const filesToClean = [
    'data/pl.json',
    'data/tr.json'
];

console.log('🧹 Начинаю очистку JSON файлов...\n');

filesToClean.forEach(filePath => {
    const fullPath = path.join(process.cwd(), filePath);
    
    if (!fs.existsSync(fullPath)) {
        console.log(`❌ Файл не найден: ${fullPath}`);
        return;
    }
    
    try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const cleaned = cleanJson(parsed);
        const output = JSON.stringify(cleaned, null, 2);
        
        fs.writeFileSync(fullPath, output, 'utf-8');
        console.log(`✅ Очищен: ${filePath}`);
    } catch (e) {
        console.error(`❌ Ошибка при обработке ${filePath}:`, e.message);
    }
});

console.log('\n🎉 Готово! Все файлы очищены от пробелов.');
