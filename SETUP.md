# Налаштування середовища (back + front + dashboard)

Проєкт складається з **трьох репозиторіїв**. Цей файл однаковий у всіх трьох
(`Multi-seller_marketplace_back`, `_front`, `_dashboard`) — тут усе, що треба для запуску.

| Частина   | Порт   | Що це                                    | Команда запуску |
|-----------|--------|------------------------------------------|-----------------|
| back      | `5000` | API (Express + MongoDB + Socket.IO)      | `npm run dev`   |
| front     | `5173` | Сайт для покупців                        | `npm run dev`   |
| dashboard | `5001` | Адмінка й кабінет продавця               | `npm run dev`   |

Гілка для роботи: **`main`** (після злиття `mvp-security-fixes`).

---

## Правило №1. `.env` не потрапляє в git

Файл `.env` ігнорується git-ом, тому **у кожному новому Codespace/на новому комп'ютері його
треба створити вручну**: скопіюйте `.env.example` у `.env` і заповніть значення.
Без цього сайт «блимає й зникає» (порожні адреси, `undefined` у запитах).

```
cp .env.example .env
```

`.env` ніколи не комітимо і не вставляємо в чат (там секрети).

Vite (front, dashboard) читає `.env` **лише при старті** — після змін перезапустіть `npm run dev`.
Бек після змін у `.env` теж треба перезапустити вручну (Ctrl+C → `npm run dev`).

---

## Порядок запуску (локально)

1. **back:** `cp .env.example .env` → заповнити (див. нижче) → `npm install` → `npm run dev`.
2. **front:** `cp .env.example .env` → `npm install` → `npm run dev` → http://localhost:5173
3. **dashboard:** `cp .env.example .env` → `npm install` → `npm run dev` → http://localhost:5001

Локально (localhost) адреси за замовчуванням уже правильні, CORS дозволяє
`localhost:5173/5001/5000` автоматично.

---

## Запуск у GitHub Codespaces

У Codespaces кожен сервіс має **власну публічну адресу** виду
`https://<назва>-<порт>.app.github.dev`. Дивіться її на вкладці **PORTS**.
Одночасно на акаунті можна мати лише **2 запущені Codespaces**.

### Кроки

1. **Запустіть кожен сервіс** (`npm run dev`) у його Codespace.
2. На вкладці **PORTS** зробіть порт **Public** (права кнопка → Port Visibility → Public).
   Для кожного порту окремо (5000 у беку, 5173 у фронті, 5001 у дашборді).
   Після зупинки/старту Codespace видимість **скидається на Private** — виставляйте знову.
   Команда замість кліків: `gh codespace ports visibility 5000:public -c $CODESPACE_NAME`
3. Відкривайте сайт у **Chrome**. У Safari приватний порт може показати «Дозволити
   викачування» — це службовий редирект GitHub, не файл; натисніть «Скасувати» і зробіть порт Public.
4. Пропишіть адреси в `.env` кожної частини (див. таблицю нижче) і **перезапустіть** сервіс.

### Які адреси куди вписувати

Нехай адреси з вкладок PORTS такі: `BACK`, `FRONT`, `DASH` (повні, з `https://`, без `/` в кінці).

| Файл | Змінна | Значення |
|------|--------|----------|
| `back/.env`      | `ALLOWED_ORIGINS`        | `FRONT,DASH` (через кому, без пробілів) |
| `front/.env`     | `VITE_LOCAL`             | `BACK` |
| `front/.env`     | `VITE_LOCAL_FRONT`       | `FRONT` |
| `dashboard/.env` | `VITE_LOCAL`             | `BACK` |
| `dashboard/.env` | `VITE_PRODUCTION_FRONT`  | `FRONT` |

`ALLOWED_ORIGINS` замінює ручне редагування `server.js` — файл чіпати не треба.

---

## Змінні back/.env

| Змінна | Призначення |
|--------|-------------|
| `NODE_ENV` | `development` локально, `production` на сервері |
| `PORT` | `5000` |
| `ALLOWED_ORIGINS` | адреси фронта/дашборду для CORS (див. вище) |
| `DB_LOCAL_URL` | рядок підключення MongoDB Atlas (dev) |
| `DB_PRO_URL` | рядок підключення (лише production) |
| `SECRET` | довгий випадковий рядок для JWT (`openssl rand -hex 32`) |
| `JWT_COOKIE_EXPIRES_IN`, `SALT_ROUNDS` | `7`, `10` |
| `STRIPE_SECRET_KEY` | тестовий ключ Stripe (поки `sk_test_dummy`) |
| `CLOUD_NAME`, `API_KEY`, `API_SECRET` | **Cloudinary** — справжні значення, див. нижче |
| `MAX_FILE_SIZE` | макс. розмір фото, МБ (`5`) |
| `ORDER_PAYMENT_CHECK_IN` | скільки днів чекати оплату (`3`) |
| `USER_DASHBOARD_RECENT_ORDERS_LIMIT`, `REVIEWS_PER_PAGE` | `5`, `5` |
| `client_customer_production_url`, `client_admin_production_url` | лише production: домени фронта й адмінки |

### Cloudinary (фото товарів)

Значення беруться з cloudinary.com → **Settings → API Keys**: `Cloud name`, `API Key`, `API Secret`.
Вписувати **без лапок, дужок і пробілів**: `CLOUD_NAME=mycloud`.

> ⚠️ Значення **`dummy` не працюють**: Cloudinary відповідає
> `Slow down. Too many concurrent requests!` (код 420), бо «dummy» — чужий спільний акаунт.
> Якщо бачите цю помилку — перевірте `CLOUD_NAME/API_KEY/API_SECRET` у `back/.env` і перезапустіть бек.
> Бек при старті сам попереджає, якщо Cloudinary не налаштовано.

Швидка перевірка Cloudinary (папка `back`, ключі не виводяться):

```
node -e "require('dotenv').config({quiet:true});const c=require('cloudinary').v2;c.config({cloud_name:process.env.CLOUD_NAME,api_key:process.env.API_KEY,api_secret:process.env.API_SECRET});c.api.ping().then(r=>console.log('PING OK',r.status)).catch(e=>console.log('PING ERR',e.error))"
```

---

## Типові проблеми

| Симптом | Причина | Рішення |
|---------|---------|---------|
| Сайт на мить з'являється й зникає, у консолі `undefined`, `wss://undefined`, `banners.length` | Немає `front/.env` | Створити `.env` з `.env.example`, перезапустити Vite |
| Сторінка «не знайдено» від GitHub / завантажується файл | Порт Private або сервер не запущений | `npm run dev` + порт Public + Chrome |
| У консолі «blocked by CORS policy» | Адреси немає в `ALLOWED_ORIGINS` | Додати адресу в `back/.env`, перезапустити бек |
| «Slow down. Too many concurrent requests» при додаванні товару | `dummy` у Cloudinary | Вписати справжні `CLOUD_NAME/API_KEY/API_SECRET` |
| Дашборд без логотипу/картинок | (виправлено) картинки тепер у `dashboard/public/images` | — |
| Після перезапуску Codespace все «зламалось» | Процеси не запущені, порти знову Private | Запустити `npm run dev`, зробити порти Public |
| Codespace створено зі старого коду | Створено з не тієї гілки | Створювати з `main`; перевірити `git branch --show-current` |

---

## Робота з git

```
git status                      # перед комітом: переконайтесь, що .env немає в списку
git add -A
git commit -m "Короткий опис"
git push
```

Один коміт — один репозиторій: коміт у бекі не зачіпає фронт і дашборд, комітьте кожен окремо.
