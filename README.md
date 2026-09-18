# 🏰 Castle Battle — Битва Замков в TikTok LIVE

Интерактивная HTML5-игра для TikTok LIVE, где зрители подарками управляют битвой. Идея простая: разделить все подарки TikTok на две армии и дать чату воевать друг с другом — и зарабатывать на этом деньги с прямых эфиров. Каждый подарок это реальные деньги для стримера, а игра делает так, что зрителям хочется дарить еще больше, чтобы победила их сторона.

Сделано на **Phaser 3 + Vite**, вертикальный формат `1080x1440` под захват в TikTok LIVE Studio.

### 🎯 Фишка
- Подарки = юниты. Чат делится на `left` / `right` и атакует замки
- Ник зрителя появляется над его рыцарем
- Победа, салют, новый раунд — удержание эфира в разы выше

## Быстрый запуск

В папке с игрой:

```powershell
npm install
npm run dev
```

Открой:

```
http://localhost:5173/
```

## Запуск TikTok LIVE подарков

Второй терминал в той же папке:

```powershell
npm run server
```

Сервер подарков:

```
http://localhost:3001
```

Игра подключается через Socket.IO автоматически. Если сервер не запущен — игра работает и без него, просто без реальных событий.

## Проверка без прямого эфира

Симуляция подарка через браузер:

```
http://localhost:3001/test?giftId=5655&donor=test-viewer
```

Примеры из твоего маппинга:
```
5655   Rose              -> левая команда (АЛМАТЫ)
5269   TikTok            -> правая команда (ШЫМКЕНТ)
5487   Finger Heart      -> левая команда
105781 Spinning Soccer   -> правая команда
```

Маппинг лежит в `giftMapping.json`:
```json
{
  "5655": "left",
  "5269": "right",
  "5487": "left",
  "105781": "right"
}
```

## Управление во время эфира

- `Q` — заспавнить рыцаря левой команды
- `E` — заспавнить рыцаря правой команды
- `` ` `` — показать/скрыть debug-панель

Ручной спавн через Q/E не показывает ник, чтобы не путать с подарком.

## Debug-панель (клавиша `)

- `[SPAWN LEFT]` / `[SPAWN RIGHT]` — по 1 рыцарю
- `[SPAWN BURST 10]` — залп 10 рыцарей
- `[DAMAGE LEFT/RIGHT CASTLE]` — тестовый урон
- `[TRIGGER COMBO LEFT/RIGHT]` — тест комбо

## Что реализовано

- Спавн рыцарей от подарков TikTok LIVE
- Агрегация быстрых подарков (отличие одиночных от массовых)
- Ник донора над рыцарем
- Бой рыцарь vs рыцарь, атака замков по стадиям
- Щепки, тряска, hit flash, взрыв замка
- Эндгейм < 20% HP, камбэк-бафф проигрывающим
- Комбо-система, лента доноров, счет побед, салют и новый раунд
- Звуки: удары, смерть, разрушение, комбо, эндгейм, победа, спавн
- Аудиолимитер + `disableVisibilityChange: true` чтобы не паузилось

## Где менять баланс

`src/config.js`:

```javascript
LEFT_TEAM = 'АЛМАТЫ'
RIGHT_TEAM = 'ШЫМКЕНТ'
MAX_CASTLE_HP = 2000
KNIGHT_DAMAGE = 5
CASTLE_DAMAGE = 1
SFX_MASTER_VOLUME = 0.75
ENDGAME_HP_THRESHOLD_PERCENT = 0.2 // 20% -> при 2000 HP эндгейм с 400 HP
```

## TikTok-настройки

`tiktok-live.js`:

```javascript
export const TIKTOK_USERNAME = 'TIKTOK_USERNAME'; // замени на реальный, в .env
export const EULER_API_KEY = 'EULER_API_KEY';
```

Для продакшна используй `.env`, файл `.gitignore` уже не дает залить ключи.

## Команды npm

```
npm run dev     # игра
npm run server  # сервер подарков
npm run build   # production сборка
npm test        # тесты очереди подарков
```

## Структура

```
src/CastleBattleScene.js   основная логика
src/config.js              баланс и команды
src/main.js                конфиг Phaser
src/giftSocket.js          Socket.IO клиент
src/spawnQueue.js          очередь подарков
server.js                  Express + Socket.IO
tiktok-live.js             подключение к TikTok LIVE
giftMapping.json           giftId -> команда
sounds/                    SFX
src/assets/                фон, замки, рыцари
```

---
Копия для экспериментов: `outputs/castle-battle-iphone-vs-android` — чтобы не ломать готовую версию для эфира.
