require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

// ==========================================
// CONFIGURATION & SETUP
// ==========================================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

if (!TOKEN || TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('\n❌ ERROR: Telegram Bot Token not set!');
  console.error('👉 Kripya .env file me apna BotFather token paste kare:');
  console.error('   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhI...\n');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const rssParser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  timeout: 10000
});

// File paths for persistence
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');
const SEEN_NEWS_FILE = path.join(__dirname, 'seen_news.json');
const NOTIFIED_EVENTS_FILE = path.join(__dirname, 'notified_events.json');

// Helper to read/write JSON
function readJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
  }
  return defaultValue;
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
  }
}

let subscribers = new Set(readJSON(SUBSCRIBERS_FILE, []));
let seenNews = new Set(readJSON(SEEN_NEWS_FILE, []));
let notifiedEvents = new Set(readJSON(NOTIFIED_EVENTS_FILE, []));

// Auto-add Chat ID from Environment variable if provided
if (process.env.TELEGRAM_CHAT_ID) {
  const envChatId = isNaN(process.env.TELEGRAM_CHAT_ID) ? process.env.TELEGRAM_CHAT_ID : Number(process.env.TELEGRAM_CHAT_ID);
  subscribers.add(envChatId);
}

function saveSubscribers() {
  writeJSON(SUBSCRIBERS_FILE, Array.from(subscribers));
}

function saveSeenNews() {
  const arr = Array.from(seenNews).slice(-500); // Keep last 500
  writeJSON(SEEN_NEWS_FILE, arr);
}

function saveNotifiedEvents() {
  const arr = Array.from(notifiedEvents).slice(-200);
  writeJSON(NOTIFIED_EVENTS_FILE, arr);
}

// Broadcast message to all active subscribers
async function broadcast(message, options = { parse_mode: 'HTML', disable_web_page_preview: true }) {
  if (subscribers.size === 0) {
    console.log('⚠️ Koi subscriber nahi hai abhi. Telegram me bot ko /start kare.');
    return;
  }
  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, message, options);
    } catch (err) {
      console.error(`Error sending message to chatId ${chatId}:`, err.message);
      // Remove if user blocked bot
      if (err.response && err.response.statusCode === 403) {
        subscribers.delete(chatId);
        saveSubscribers();
      }
    }
  }
}

// ==========================================
// 1. LIVE GOLD PRICE (XAU/USD - Yahoo Finance)
// ==========================================
async function fetchGoldPrice() {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const currentPrice = meta.regularMarketPrice || 0;
    const prevClose = meta.chartPreviousClose || currentPrice;
    const change = currentPrice - prevClose;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
    const dayHigh = meta.regularMarketDayHigh || currentPrice;
    const dayLow = meta.regularMarketDayLow || currentPrice;

    return {
      price: currentPrice.toFixed(2),
      change: change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2),
      changePercent: changePercent >= 0 ? `+${changePercent.toFixed(2)}%` : `${changePercent.toFixed(2)}%`,
      isUp: change >= 0,
      dayHigh: dayHigh.toFixed(2),
      dayLow: dayLow.toFixed(2)
    };
  } catch (err) {
    console.error('Error fetching Gold Price:', err.message);
    return null;
  }
}

// ==========================================
// 2. IMPACT ANALYZER (Bullish vs Bearish)
// ==========================================
function analyzeGoldImpact(title) {
  const text = title.toLowerCase();

  const bullishTriggers = [
    'rate cut', 'cut rates', 'dovish', 'weak jobs', 'jobless claims rise',
    'dollar falls', 'dollar drops', 'dollar sinks', 'dollar weakens', 'dxy drops', 'dxy slides',
    'yields fall', 'yields drop', 'yields slide', 'inflation cool', 'cpi cool', 'cpi slows',
    'safe-haven', 'safe haven', 'war', 'tensions', 'escalat', 'middle east',
    'gold rallies', 'gold surges', 'gold jumps', 'gold hits record', 'gold gains'
  ];

  const bearishTriggers = [
    'rate hike', 'hike rates', 'hawkish', 'strong jobs', 'payrolls beat', 'nfp beat',
    'dollar surges', 'dollar rallies', 'dollar jumps', 'dollar strengthens', 'dxy rallies', 'dxy jumps',
    'yields surge', 'yields jump', 'yields rise', 'inflation heat', 'cpi hot', 'cpi rises',
    'gold falls', 'gold drops', 'gold sinks', 'gold plunge', 'gold slides', 'gold declines'
  ];

  let bull = 0;
  let bear = 0;

  bullishTriggers.forEach(k => { if (text.includes(k)) bull++; });
  bearishTriggers.forEach(k => { if (text.includes(k)) bear++; });

  if (bull > bear) {
    return {
      status: '🟢 BULLISH FOR GOLD (Price Likely UP)',
      reason: 'Dollar/Yields down ya Safe-Haven buying/Rate Cut hope.'
    };
  } else if (bear > bull) {
    return {
      status: '🔴 BEARISH FOR GOLD (Price Likely DOWN)',
      reason: 'Strong Dollar/Yields ya High Interest Rate impact.'
    };
  } else {
    return {
      status: '⚡ HIGH VOLATILITY / WATCH CLOSELY',
      reason: 'Market me tez movement expect kare.'
    };
  }
}

// Helper to fetch news specifically related to an economic event
async function fetchRelatedEventNews(eventTitle) {
  try {
    const cleanTitle = encodeURIComponent(eventTitle.replace(/[^a-zA-Z0-9 ]/g, '').trim());
    const url = `https://news.google.com/rss/search?q=(${cleanTitle}+OR+USD)+AND+(gold+OR+XAUUSD)+when:24h&hl=en-US&gl=US&ceid=US:en`;
    const feed = await rssParser.parseURL(url);
    if (feed && feed.items && feed.items.length > 0) {
      return feed.items.slice(0, 2).map(item => ({
        title: item.title,
        link: item.link
      }));
    }
  } catch (e) {
    console.error('Error fetching event related news:', e.message);
  }
  return [];
}

// ==========================================
// 3. BREAKING US GOLD & MACRO NEWS (Google News RSS)
// ==========================================
async function fetchGoldNews() {
  try {
    // Specifically targets Gold, US Fed, CPI, NFP, Dollar Index, Geopolitics
    const query = encodeURIComponent('(gold OR XAUUSD) AND ("Fed" OR "Powell" OR "CPI" OR "inflation" OR "NFP" OR "rates" OR "dollar" OR "yields" OR "rally" OR "drop" OR "war") when:12h');
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    const feed = await rssParser.parseURL(url);
    if (!feed || !feed.items) return [];

    return feed.items.map(item => ({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      snippet: item.contentSnippet ? item.contentSnippet.replace(/\s+/g, ' ').slice(0, 180) : '',
      id: item.guid || item.link || item.title
    }));
  } catch (err) {
    console.error('Error fetching Gold News RSS:', err.message);
    return [];
  }
}

// ==========================================
// 4. FOREX FACTORY US ECONOMIC CALENDAR
// ==========================================
async function fetchForexFactoryUSDCalendar() {
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Filter only US High-Impact Events (Red Folder)
    const usdHighEvents = data.filter(e => e.country === 'USD' && e.impact === 'High');
    return usdHighEvents;
  } catch (err) {
    console.error('Error fetching Forex Factory Calendar:', err.message);
    return [];
  }
}

// ==========================================
// 5. PERIODIC CHECK ENGINE (Runs every 5 mins)
// ==========================================
async function checkMarket() {
  console.log(`[${new Date().toLocaleTimeString('en-IN', { timeZone: TIMEZONE })}] 🔍 Checking Gold market updates...`);

  // Step A: Check Forex Factory Calendar for events in next 20 mins + fetch RELATED NEWS
  try {
    const calendarEvents = await fetchForexFactoryUSDCalendar();
    const now = new Date();

    for (const ev of calendarEvents) {
      const eventTime = new Date(ev.date);
      const diffMinutes = Math.round((eventTime.getTime() - now.getTime()) / (60 * 1000));
      const eventKey = `${ev.title}_${ev.date}`;

      // If event is in the next 0 to 20 minutes and not alerted yet
      if (diffMinutes >= 0 && diffMinutes <= 20 && !notifiedEvents.has(eventKey)) {
        notifiedEvents.add(eventKey);
        saveNotifiedEvents();

        const timeStr = eventTime.toLocaleTimeString('en-IN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
        
        // Fetch real-time news related to this event
        const relatedNews = await fetchRelatedEventNews(ev.title);
        let relatedNewsBlock = '';
        if (relatedNews.length > 0) {
          relatedNewsBlock = `\n📰 <b>Event Se Related Latest News & Reports:</b>\n` +
            relatedNews.map((n, idx) => `${idx + 1}. <b>${n.title}</b>\n🔗 <a href="${n.link}">Report Padhe</a>`).join('\n\n') + `\n`;
        }

        const calMsg = `⚠️ <b>HIGH IMPACT US EVENT & RELATED NEWS</b> ⚠️\n\n` +
          `📌 <b>Event:</b> ${ev.title}\n` +
          `⏰ <b>Release Time:</b> ${timeStr} (Sirf ${diffMinutes} min me!)\n` +
          `📊 <b>Forecast:</b> ${ev.forecast || 'N/A'} | <b>Previous:</b> ${ev.previous || 'N/A'}\n\n` +
          `💡 <b>Impact on Gold (XAU/USD):</b>\n` +
          `Is data ke aate hi Gold me bohot tez swing ($15-$40) aa sakta hai!\n` +
          `${relatedNewsBlock}\n` +
          `⚡ <i>Positions dhyan se manage kare!</i>`;

        await broadcast(calMsg);
      }
    }
  } catch (e) {
    console.error('Calendar check error:', e.message);
  }

  // Step B: Check Breaking News
  try {
    const newsItems = await fetchGoldNews();
    const freshNews = [];

    for (const item of newsItems) {
      if (!seenNews.has(item.id)) {
        seenNews.add(item.id);
        freshNews.push(item);
      }
    }
    saveSeenNews();

    if (freshNews.length > 0) {
      console.log(`📢 Found ${freshNews.length} new breaking news item(s)!`);
      const gold = await fetchGoldPrice();

      // Send up to 3 freshest news items
      for (const item of freshNews.slice(0, 3)) {
        const impact = analyzeGoldImpact(item.title);
        const priceText = gold 
          ? `💰 <b>XAU/USD Spot:</b> $${gold.price} (${gold.changePercent})` 
          : '';

        const snippetText = item.snippet && !item.snippet.toLowerCase().includes(item.title.toLowerCase().slice(0, 20))
          ? `📝 <b>Summary:</b> <i>${item.snippet}</i>\n\n`
          : '';

        const msg = `🟡 <b>US GOLD MARKET BREAKING NEWS UPDATE</b>\n\n` +
          `📰 <b>Headline:</b> ${item.title}\n\n` +
          `${snippetText}` +
          `🎯 <b>Impact:</b> ${impact.status}\n` +
          `ℹ️ <b>Analysis:</b> ${impact.reason}\n\n` +
          `${priceText}\n` +
          `🔗 <a href="${item.link}">Full Article Padhe</a>`;

        await broadcast(msg);
        // Small pause between messages
        await new Promise(r => setTimeout(r, 1000));
      }
    } else {
      console.log('✅ No new breaking news in this cycle.');
    }
  } catch (e) {
    console.error('News check error:', e.message);
  }
}

// ==========================================
// 6. TELEGRAM BOT COMMANDS
// ==========================================

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  subscribers.add(chatId);
  saveSubscribers();

  const gold = await fetchGoldPrice();
  const priceInfo = gold 
    ? `\n💰 <b>Current Gold (XAU/USD):</b> $${gold.price} (${gold.changePercent})\n`
    : '';

  const welcome = `👋 <b>Namaste ${msg.from.first_name || 'Trader'}!</b>\n\n` +
    `Aapka US Gold Market Alert Bot active ho gaya hai! ✅\n` +
    `${priceInfo}\n` +
    `⚡ <b>Features:</b>\n` +
    `• Har <b>${INTERVAL_MINUTES} minute</b> me US Gold market aur Fed news scanning.\n` +
    `• Forex Factory se High-Impact US Data (CPI, NFP, Fed Rates) ka instant alert.\n` +
    `• Har news ke sath Gold UP/DOWN hone ka impact hint.\n\n` +
    `📌 <b>Commands:</b>\n` +
    `👉 /gold - Current live Gold price aur day high/low\n` +
    `👉 /news - Top 3 breaking news abhi ke abhi\n` +
    `👉 /calendar - Aaj ke High Impact US Economic events\n` +
    `👉 /stop - Updates pause karne ke liye`;

  bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
});

// /stop command
bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  subscribers.delete(chatId);
  saveSubscribers();
  bot.sendMessage(chatId, '🛑 Aapne updates unsubscribe kar diya hai. Dobara shuru karne ke liye /start dabaye.');
});

// /gold command
bot.onText(/\/gold/, async (msg) => {
  const chatId = msg.chat.id;
  const gold = await fetchGoldPrice();

  if (!gold) {
    bot.sendMessage(chatId, '⚠️ Gold price fetch karne me dikkat aayi. Kripya thodi der baad try kare.');
    return;
  }

  const icon = gold.isUp ? '📈' : '📉';
  const response = `🟡 <b>US GOLD (XAU/USD) LIVE STATS</b>\n\n` +
    `💵 <b>Price:</b> $${gold.price} / oz\n` +
    `${icon} <b>24h Change:</b> ${gold.change} (${gold.changePercent})\n` +
    `🔺 <b>Day High:</b> $${gold.dayHigh}\n` +
    `🔻 <b>Day Low:</b> $${gold.dayLow}\n\n` +
    `🕒 <i>Updated at: ${new Date().toLocaleTimeString('en-IN', { timeZone: TIMEZONE })} IST</i>`;

  bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
});

// /news command
bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  const news = await fetchGoldNews();

  if (news.length === 0) {
    bot.sendMessage(chatId, 'Abhi koi tazi news nahi mili.');
    return;
  }

  let text = `📰 <b>TOP LATEST US GOLD & MACRO NEWS:</b>\n\n`;
  news.slice(0, 3).forEach((item, index) => {
    const impact = analyzeGoldImpact(item.title);
    text += `<b>${index + 1}.</b> ${item.title}\n`;
    text += `🎯 ${impact.status}\n`;
    text += `🔗 <a href="${item.link}">Source link</a>\n\n`;
  });

  bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// /calendar command
bot.onText(/\/calendar/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  const events = await fetchForexFactoryUSDCalendar();

  if (events.length === 0) {
    bot.sendMessage(chatId, '📅 Is hafte koi High-Impact USD event schedule nahi hai.');
    return;
  }

  let text = `🔴 <b>FOREX FACTORY - HIGH IMPACT US EVENTS (Red Folders):</b>\n\n`;
  events.slice(0, 5).forEach((ev, i) => {
    const d = new Date(ev.date);
    const dateStr = d.toLocaleDateString('en-IN', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-IN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

    text += `<b>${i + 1}. ${ev.title}</b>\n`;
    text += `📅 <b>Time:</b> ${dateStr} at ${timeStr} IST\n`;
    text += `📊 <b>Forecast:</b> ${ev.forecast || '-'} | <b>Previous:</b> ${ev.previous || '-'}\n\n`;
  });

  text += `💡 <i>In events ke time Gold me heavy volatility hoti hai!</i>`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// /help command
bot.onText(/\/help/, (msg) => {
  const helpText = `🛠️ <b>US GOLD BOT COMMANDS GUIDE</b>\n\n` +
    `/gold - Current Live XAU/USD Gold Price\n` +
    `/news - Fresh US Macro & Gold Market News\n` +
    `/calendar - Forex Factory High-Impact US Economic Events\n` +
    `/start - Subscribe to 5-minute Auto Alerts\n` +
    `/stop - Stop Alerts`;

  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
});

// ==========================================
// 7. BOT LAUNCH & CRON
// ==========================================
console.log('🚀 US Gold Telegram Bot service starting...');
console.log(`⏱️ Scanning interval set to every ${INTERVAL_MINUTES} minute(s).`);

// Initial run
checkMarket();

// Recurring interval
setInterval(checkMarket, INTERVAL_MINUTES * 60 * 1000);

// ==========================================
// 8. RENDER CLOUD WEB SERVICE & KEEP-ALIVE
// ==========================================
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    service: 'US Gold Telegram Bot',
    subscribersCount: subscribers.size,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  }));
});

server.listen(PORT, () => {
  console.log(`🌐 Health server listening on port ${PORT} (Render Web Service Ready)`);
});

// Self-ping to prevent Render Free Tier from going to sleep (Spindown prevention)
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  console.log(`⚡ Keep-alive enabled for: ${RENDER_EXTERNAL_URL}`);
  setInterval(() => {
    fetch(RENDER_EXTERNAL_URL)
      .then(() => console.log('💓 Keep-alive ping sent.'))
      .catch(err => console.error('Keep-alive ping error:', err.message));
  }, 10 * 60 * 1000); // Har 10 minute me ping
}
