# 🟡 US Gold (XAU/USD) Market Telegram Bot

Yeh bot har 5 minute me US Gold market, US Dollar, Fed policies aur economic data scan karta hai aur Telegram par instant update deta hai.

---

## 🚀 Quick Setup (Kaise Chalaye)

### 1. `.env` File me Token Dale:
Is folder me `.env` file ko open kare aur apna BotFather token dale:
```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhI...
```

### 2. Bot Start Kare:
Double click kare **`start.bat`** file par, ya terminal me run kare:
```bash
node bot.js
```

### 3. Telegram me Bot Start Kare:
Telegram me apne bot ko khole aur **`/start`** command bheje.
Bot turant aapko subscribe kar lega aur alerts bhejna shuru kar dega!

---

## ⚡ Bot Features & Sources

1. **Forex Factory (Red Folder US Events):**
   - High-impact data jaise CPI (Inflation), NFP (Jobs), FOMC Interest Rates.
   - Event aane se 15-20 min pehle bot warning alert deta hai.

2. **US Gold & Macro Breaking News:**
   - Google Finance / Reuters / WSJ / CNBC / Kitco RSS feeds se real-time headlines.
   - Har news ke sath **Impact Signal** (🟢 Bullish ya 🔴 Bearish).

3. **Live Gold Price (XAU/USD):**
   - Live gold price, day high/low, and 24h percentage change.

---

## 📌 Telegram Commands:
- `/gold` - Current live XAU/USD price
- `/news` - Top 3 latest breaking news
- `/calendar` - Aaj ke Forex Factory High-Impact events
- `/start` - 5-min auto alert shuru kare
- `/stop` - Alerts pause kare

---

## ☁️ 24x7 Free Cloud Hosting (Render.com)

Agar aap chahte hai ki **PC band hone par bhi bot 24x7 chalta rahe**, toh Render par deploy kare:

1. **GitHub par Repository banaye:**
   - [github.com](https://github.com) par login kare aur New Repository banaye (naam: `gold-telegram-bot`, Private ya Public).
   - "uploading an existing file" par click karke is folder ke files upload kar de (`node_modules` aur `.env` chhod kar).
2. **Render.com par jaye:**
   - [render.com](https://render.com) par free account banaye (Sign up with GitHub).
   - Dashboard me **New +** > **Web Service** par click kare.
   - Apni GitHub repository choose kare.
3. **Settings fill kare:**
   - **Name:** `us-gold-bot`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
4. **Environment Variables me Dale:**
   - `TELEGRAM_BOT_TOKEN` = (Aapka BotFather Token)
   - `CHECK_INTERVAL_MINUTES` = `5`
   - `TIMEZONE` = `Asia/Kolkata`
5. **Deploy Web Service** button dabaye!
   - Bot cloud par 24x7 start ho jayega!

