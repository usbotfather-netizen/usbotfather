require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ==========================================
// CONFIGURATION & SETUP
// ==========================================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || null;

if (!TOKEN || TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('\n❌ ERROR: Telegram Bot Token not set!');
  console.error('👉 Kripya .env file me apna BotFather token paste kare:\n');
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
// Seen news stores objects: { id, title, timestamp }
let seenNews = readJSON(SEEN_NEWS_FILE, []);
let notifiedEvents = new Set(readJSON(NOTIFIED_EVENTS_FILE, []));

// Auto-add Chat ID from Environment variable if provided
if (process.env.TELEGRAM_CHAT_ID) {
  const ids = process.env.TELEGRAM_CHAT_ID.split(',').map(s => s.trim());
  ids.forEach(id => {
    if (id) subscribers.add(isNaN(id) ? id : Number(id));
  });
}

function saveSubscribers() {
  writeJSON(SUBSCRIBERS_FILE, Array.from(subscribers));
}

function saveSeenNews() {
  // Keep last 300 news items
  const arr = seenNews.slice(-300);
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
      if (err.response && err.response.statusCode === 403) {
        subscribers.delete(chatId);
        saveSubscribers();
      }
    }
  }
}

// ==========================================
// 1. NLP STRICT DUPLICATE NEWS FILTER
// ==========================================
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'it', 'its', 'be', 'this', 
  'that', 'breaking', 'news', 'update', 'market', 'live', 'says', 'amid', 'ahead'
]);

function cleanTokens(title) {
  return title.toLowerCase()
    .replace(/[-|].*(wsj|reuters|cnbc|bloomberg|fxstreet|kitco|marketwatch|investing|fortune|forbes).*/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function isDuplicateNews(newTitle, newId) {
  // 1. Exact ID / Link check
  if (seenNews.some(item => item.id === newId)) {
    return true;
  }

  // 2. Fuzzy Token Overlap Check with recent news (last 6 hours)
  const now = Date.now();
  const recentItems = seenNews.filter(item => (now - (item.timestamp || now)) < 6 * 60 * 60 * 1000);
  const newTokens = cleanTokens(newTitle);
  if (newTokens.length === 0) return false;

  for (const item of recentItems) {
    const existingTokens = cleanTokens(item.title);
    if (existingTokens.length === 0) continue;

    const setExisting = new Set(existingTokens);
    const matches = newTokens.filter(w => setExisting.has(w)).length;
    const similarity = matches / Math.min(newTokens.length, existingTokens.length);

    // If more than 55% of key words overlap, it's the exact same news story
    if (similarity >= 0.55) {
      console.log(`🚫 Duplicate news skipped: "${newTitle}" matched "${item.title}" (${Math.round(similarity * 100)}% match)`);
      return true;
    }
  }

  return false;
}

function recordSeenNews(id, title) {
  seenNews.push({ id, title, timestamp: Date.now() });
  saveSeenNews();
}

// ==========================================
// 2. REAL-TIME GOLD PRICE & 5M CANDLE DATA
// ==========================================

// Fetch 5-Minute Candles (Twelve Data or Yahoo Finance CME Futures)
async function fetch5mCandles() {
  // Option A: Twelve Data (if user set API key)
  if (TWELVE_DATA_API_KEY) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=35&apikey=${TWELVE_DATA_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.values && data.values.length > 20) {
        const candles = data.values.reverse().map(v => ({
          time: new Date(v.datetime),
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
          volume: parseFloat(v.volume || 0)
        }));
        return candles;
      }
    } catch (e) {
      console.error('Twelve Data error, falling back to Yahoo Finance:', e.message);
    }
  }

  // Option B: Yahoo Finance CME Gold Futures (Free, 23h realtime)
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quote.close[i] !== null && quote.open[i] !== null && quote.high[i] !== null && quote.low[i] !== null) {
        candles.push({
          time: new Date(timestamps[i] * 1000),
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          close: quote.close[i],
          volume: quote.volume[i] || 0
        });
      }
    }
    return candles;
  } catch (err) {
    console.error('Error fetching 5m candles:', err.message);
    return null;
  }
}

// Fetch Current Live Gold Stats
async function fetchGoldPrice() {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
// 3. AI 5-MINUTE CANDLE CHART ANALYSIS ENGINE
// ==========================================

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(arr, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

async function run5mChartAnalysis() {
  const candles = await fetch5mCandles();
  if (!candles || candles.length < 25) {
    return null;
  }

  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes, 14);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const recentCandles = candles.slice(-20);
  const recentHigh = Math.max(...recentCandles.map(c => c.high));
  const recentLow = Math.min(...recentCandles.map(c => c.low));

  const range = last.high - last.low || 0.01;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const isGreen = last.close >= last.open;

  let pattern = 'Standard Candle';
  let patternScore = 0;

  if (lowerWick >= 2 * body && upperWick <= body * 0.5) {
    pattern = 'Bullish Pinbar / Hammer (Lows Reject Hue)';
    patternScore = 30;
  } else if (upperWick >= 2 * body && lowerWick <= body * 0.5) {
    pattern = 'Bearish Pinbar / Shooting Star (Highs Reject Hue)';
    patternScore = -30;
  } else if (isGreen && last.close > prev.open && last.open < prev.close && prev.close < prev.open) {
    pattern = 'Bullish Engulfing (Buyers Ne Control Liya)';
    patternScore = 35;
  } else if (!isGreen && last.close < prev.open && last.open > prev.close && prev.close > prev.open) {
    pattern = 'Bearish Engulfing (Sellers Ne Control Liya)';
    patternScore = -35;
  } else if (body / range > 0.75) {
    pattern = isGreen ? 'Strong Bullish Expansion Candle' : 'Strong Bearish Expansion Candle';
    patternScore = isGreen ? 20 : -20;
  }

  let score = 0;
  const reasons = [];

  // 1. EMA Trend
  if (ema9 > ema21 && last.close > ema9) {
    score += 25;
    reasons.push(`Trend is BULLISH (EMA 9 [$${ema9.toFixed(2)}] > EMA 21 [$${ema21.toFixed(2)}])`);
  } else if (ema9 < ema21 && last.close < ema9) {
    score -= 25;
    reasons.push(`Trend is BEARISH (EMA 9 [$${ema9.toFixed(2)}] < EMA 21 [$${ema21.toFixed(2)}])`);
  } else {
    reasons.push(`Trend is Sideways / Chop around EMAs`);
  }

  // 2. RSI Momentum
  if (rsi > 52 && rsi < 68) {
    score += 20;
    reasons.push(`RSI(14) at ${rsi.toFixed(1)} (Healthy Bullish Momentum)`);
  } else if (rsi < 48 && rsi > 32) {
    score -= 20;
    reasons.push(`RSI(14) at ${rsi.toFixed(1)} (Downward Bearish Momentum)`);
  } else if (rsi >= 70) {
    score -= 10;
    reasons.push(`RSI Overbought (${rsi.toFixed(1)}) - Pullback Risk`);
  } else if (rsi <= 30) {
    score += 10;
    reasons.push(`RSI Oversold (${rsi.toFixed(1)}) - Bounce Potential`);
  } else {
    reasons.push(`RSI Neutral (${rsi.toFixed(1)})`);
  }

  // 3. Pattern
  score += patternScore;
  if (patternScore !== 0) {
    reasons.push(`5M Pattern: ${pattern}`);
  }

  // 4. Support / Resistance
  if (Math.abs(last.close - recentLow) < (range * 1.5)) {
    score += 15;
    reasons.push(`Price bouncing near 20-candle Support ($${recentLow.toFixed(2)})`);
  } else if (Math.abs(last.close - recentHigh) < (range * 1.5)) {
    score -= 15;
    reasons.push(`Price facing 20-candle Resistance ($${recentHigh.toFixed(2)})`);
  }

  let prediction = 'NEUTRAL / WAIT (No Clear Trade)';
  let icon = '⚪';
  let signalType = 'WAIT';
  let confidence = Math.min(Math.abs(score) + 40, 95);

  let sl = 0, tp1 = 0, tp2 = 0;
  const entry = last.close;

  if (score >= 30) {
    prediction = 'UP (BUY / CALL)';
    icon = '🟢';
    signalType = 'BUY';
    sl = Math.min(last.low, recentLow) - 1.5;
    const risk = entry - sl;
    tp1 = entry + (risk * 1.5);
    tp2 = entry + (risk * 2.5);
  } else if (score <= -30) {
    prediction = 'DOWN (SELL / PUT)';
    icon = '🔴';
    signalType = 'SELL';
    sl = Math.max(last.high, recentHigh) + 1.5;
    const risk = sl - entry;
    tp1 = entry - (risk * 1.5);
    tp2 = entry - (risk * 2.5);
  }

  return {
    time: last.time,
    entry: entry.toFixed(2),
    sl: sl > 0 ? sl.toFixed(2) : null,
    tp1: tp1 > 0 ? tp1.toFixed(2) : null,
    tp2: tp2 > 0 ? tp2.toFixed(2) : null,
    prediction,
    icon,
    signalType,
    confidence: `${confidence}%`,
    score,
    pattern,
    ema9: ema9.toFixed(2),
    ema21: ema21.toFixed(2),
    rsi: rsi.toFixed(1),
    support: recentLow.toFixed(2),
    resistance: recentHigh.toFixed(2),
    reasons
  };
}

// ==========================================
// 4. ULTRA-FAST BREAKING NEWS (FXStreet + Google News)
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

  let bull = 0, bear = 0;
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
      reason: 'US Macro / Gold market me tez movement expected.'
    };
  }
}

// Fetches institutional feeds: FXStreet (Myfxbook core source) + Google News institutional
async function fetchBreakingGoldNews() {
  const allItems = [];

  // Feed 1: FXStreet Raw News Wire (Source used by Myfxbook & brokers)
  try {
    const fxFeed = await rssParser.parseURL('https://www.fxstreet.com/rss/news');
    if (fxFeed && fxFeed.items) {
      fxFeed.items.forEach(item => {
        const text = `${item.title} ${item.contentSnippet || ''}`.toLowerCase();
        // Filter specifically for gold or USD macro movers
        if (text.includes('gold') || text.includes('xau') || text.includes('fed') || text.includes('cpi') || text.includes('nfp') || text.includes('dollar') || text.includes('powell') || text.includes('yield')) {
          allItems.push({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            snippet: item.contentSnippet ? item.contentSnippet.replace(/\s+/g, ' ').slice(0, 180) : '',
            id: item.guid || item.link || item.title,
            source: 'FXStreet Live'
          });
        }
      });
    }
  } catch (e) {
    console.error('FXStreet RSS error:', e.message);
  }

  // Feed 2: Google News Aggregator (Reuters, Bloomberg, WSJ, CNBC, Kitco)
  try {
    const query = encodeURIComponent('(gold OR XAUUSD) AND ("Fed" OR "Powell" OR "CPI" OR "inflation" OR "NFP" OR "rates" OR "dollar" OR "yields" OR "rally" OR "drop" OR "war") when:12h');
    const gFeed = await rssParser.parseURL(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`);
    if (gFeed && gFeed.items) {
      gFeed.items.forEach(item => {
        allItems.push({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          snippet: item.contentSnippet ? item.contentSnippet.replace(/\s+/g, ' ').slice(0, 180) : '',
          id: item.guid || item.link || item.title,
          source: 'Institutional Wire'
        });
      });
    }
  } catch (e) {
    console.error('Google News RSS error:', e.message);
  }

  return allItems;
}

// ==========================================
// 5. FOREX FACTORY US ECONOMIC CALENDAR
// ==========================================
const GOLD_EVENT_KEYWORDS = [
  'fomc', 'fed', 'powell', 'rate', 'cpi', 'ppi', 'pce', 'inflation',
  'employment', 'payrolls', 'nfp', 'unemployment claims', 'jobless claims',
  'ism', 'gdp', 'retail sales', 'consumer sentiment', 'bond auction', 'speaks'
];

function isGoldMovingEvent(event) {
  if (event.country !== 'USD') return false;
  if (event.impact === 'High') return true;
  const titleLower = event.title.toLowerCase();
  return GOLD_EVENT_KEYWORDS.some(kw => titleLower.includes(kw));
}

function getEventTradingHint(title) {
  const t = title.toLowerCase();
  if (t.includes('unemployment claims') || t.includes('jobless claims')) {
    return 'Claims badh kar aaye (Weak Jobs) -> Dollar Down, Gold UP 📈\nClaims kam aaye (Strong Jobs) -> Dollar Up, Gold DOWN 📉';
  }
  if (t.includes('cpi') || t.includes('ppi') || t.includes('pce') || t.includes('inflation')) {
    return 'Inflation cooling -> Fed rate cuts -> Gold Rallies UP 📈\nInflation hot/rising -> Rates high -> Gold Slides DOWN 📉';
  }
  if (t.includes('nfp') || t.includes('payrolls') || t.includes('employment')) {
    return 'NFP weak aayi -> Dollar crash, Gold SURGE 🚀\nNFP strong aayi -> Dollar rally, Gold DUMP 📉';
  }
  if (t.includes('fomc') || t.includes('powell') || t.includes('rate') || t.includes('speaks')) {
    return 'Dovish tone (Rate cut umeed) -> Gold UP 📈\nHawkish tone (High rates) -> Gold DOWN 📉';
  }
  if (t.includes('ism') || t.includes('gdp') || t.includes('retail sales')) {
    return 'Weak economic data -> Gold Safe-Haven UP 📈\nStrong data -> Dollar Strong, Gold DOWN 📉';
  }
  return 'High Volatility candle expected! Dollar move ke opposite Gold react karega.';
}

async function fetchForexFactoryUSDCalendar() {
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.filter(isGoldMovingEvent);
  } catch (err) {
    console.error('Error fetching Forex Factory Calendar:', err.message);
    return [];
  }
}

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
// 6. PERIODIC ENGINE (Every 5 Minutes)
// ==========================================
async function checkMarket() {
  console.log(`[${new Date().toLocaleTimeString('en-IN', { timeZone: TIMEZONE })}] 🔍 Running 5-min Gold Market & Candle Scanner...`);

  // Step A: Check Forex Factory Calendar (Alert 15 mins before)
  try {
    const calendarEvents = await fetchForexFactoryUSDCalendar();
    const now = new Date();

    for (const ev of calendarEvents) {
      const eventTime = new Date(ev.date);
      const diffMinutes = Math.round((eventTime.getTime() - now.getTime()) / (60 * 1000));
      const eventKey = `${ev.title}_${ev.date}`;

      if (diffMinutes >= 0 && diffMinutes <= 20 && !notifiedEvents.has(eventKey)) {
        notifiedEvents.add(eventKey);
        saveNotifiedEvents();

        const timeStr = eventTime.toLocaleTimeString('en-IN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
        const relatedNews = await fetchRelatedEventNews(ev.title);
        let relatedNewsBlock = '';
        if (relatedNews.length > 0) {
          relatedNewsBlock = `\n📰 <b>Related Market News & Reports:</b>\n` +
            relatedNews.map((n, idx) => `${idx + 1}. <b>${n.title}</b>\n🔗 <a href="${n.link}">Report Padhe</a>`).join('\n\n') + `\n`;
        }

        const tradingHint = getEventTradingHint(ev.title);

        const calMsg = `⚠️ <b>US EVENT ALERT & GOLD IMPACT</b> ⚠️\n\n` +
          `📌 <b>Event:</b> ${ev.title} (${ev.impact} Impact)\n` +
          `⏰ <b>Release Time:</b> ${timeStr} IST (Sirf ${diffMinutes} min me!)\n` +
          `📊 <b>Forecast:</b> ${ev.forecast || 'N/A'} | <b>Previous:</b> ${ev.previous || 'N/A'}\n\n` +
          `🎯 <b>How It Affects Gold:</b>\n` +
          `${tradingHint}\n` +
          `${relatedNewsBlock}\n` +
          `⚡ <i>Positions dhyan se manage kare!</i>`;

        await broadcast(calMsg);
      }
    }
  } catch (e) {
    console.error('Calendar check error:', e.message);
  }

  // Step B: Check Breaking News with Strict Deduplication
  try {
    const newsItems = await fetchBreakingGoldNews();
    const freshNews = [];

    for (const item of newsItems) {
      if (!isDuplicateNews(item.title, item.id)) {
        recordSeenNews(item.id, item.title);
        freshNews.push(item);
      }
    }

    if (freshNews.length > 0) {
      console.log(`📢 Found ${freshNews.length} verified non-duplicate breaking news item(s)!`);
      const gold = await fetchGoldPrice();

      for (const item of freshNews.slice(0, 3)) {
        const impact = analyzeGoldImpact(item.title);
        const priceText = gold 
          ? `💰 <b>XAU/USD Spot:</b> $${gold.price} (${gold.changePercent})` 
          : '';

        const snippetText = item.snippet && !item.snippet.toLowerCase().includes(item.title.toLowerCase().slice(0, 20))
          ? `📝 <b>Summary:</b> <i>${item.snippet}</i>\n\n`
          : '';

        const msg = `🟡 <b>US GOLD BREAKING NEWS ALERT</b>\n` +
          `📡 <i>Source: ${item.source}</i>\n\n` +
          `📰 <b>Headline:</b> ${item.title}\n\n` +
          `${snippetText}` +
          `🎯 <b>Impact:</b> ${impact.status}\n` +
          `ℹ️ <b>Analysis:</b> ${impact.reason}\n\n` +
          `${priceText}\n` +
          `🔗 <a href="${item.link}">Full Article Padhe</a>`;

        await broadcast(msg);
        await new Promise(r => setTimeout(r, 1200));
      }
    } else {
      console.log('✅ No new non-duplicate news in this cycle.');
    }
  } catch (e) {
    console.error('News check error:', e.message);
  }

  // Step C: 5-Minute Candle Close AI Signal (Broadcast only high-probability trades)
  try {
    const analysis = await run5mChartAnalysis();
    if (analysis && (analysis.signalType === 'BUY' || analysis.signalType === 'SELL')) {
      const signalMsg = `🤖 <b>5-MIN GOLD (XAU/USD) AI CHART SIGNAL</b> 📊\n\n` +
        `🎯 <b>Signal:</b> ${analysis.icon} <b>${analysis.prediction}</b>\n` +
        `⚡ <b>Confidence:</b> ${analysis.confidence}\n` +
        `💵 <b>Entry Price:</b> $${analysis.entry}\n` +
        `🛑 <b>Stop Loss (SL):</b> $${analysis.sl}\n` +
        `🎯 <b>Target 1 (TP1):</b> $${analysis.tp1}\n` +
        `🎯 <b>Target 2 (TP2):</b> $${analysis.tp2}\n\n` +
        `📈 <b>Chart Indicators:</b>\n` +
        `• Pattern: <b>${analysis.pattern}</b>\n` +
        `• EMA 9: $${analysis.ema9} | EMA 21: $${analysis.ema21}\n` +
        `• RSI (14): ${analysis.rsi}\n` +
        `• Support: $${analysis.support} | Resistance: $${analysis.resistance}\n\n` +
        `💡 <b>Logic:</b>\n` +
        analysis.reasons.map(r => `• ${r}`).join('\n') + `\n\n` +
        `⚠️ <i>Risk Management zaroor follow kare!</i>`;

      await broadcast(signalMsg);
    }
  } catch (e) {
    console.error('5M Analysis error:', e.message);
  }
}

// ==========================================
// 7. TELEGRAM BOT COMMANDS
// ==========================================

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  subscribers.add(chatId);
  saveSubscribers();

  const gold = await fetchGoldPrice();
  const priceInfo = gold 
    ? `\n💰 <b>Live Gold (XAU/USD):</b> $${gold.price} (${gold.changePercent})\n`
    : '';

  const welcome = `👋 <b>Namaste ${msg.from.first_name || 'Trader'}!</b>\n\n` +
    `Aapka Pro US Gold (XAU/USD) Market Bot Active Ho Gaya Hai! ✅\n` +
    `${priceInfo}\n` +
    `⚡ <b>Features Active:</b>\n` +
    `• <b>Real-time Gold CFD Price</b> & 24h Trend\n` +
    `• <b>5-Min Candle AI Analysis</b> (UP / DOWN Signals with SL & Targets)\n` +
    `• <b>Institutional Breaking News</b> (FXStreet + Reuters + Bloomberg)\n` +
    `• <b>Forex Factory US Events</b> & Gold Impact Guide\n` +
    `• <b>Smart Zero-Duplicate News Filter</b>\n\n` +
    `📌 <b>Available Commands:</b>\n` +
    `👉 /candle - 5-Min Chart AI Analysis (UP / DOWN Signal)\n` +
    `👉 /gold - Current Live Price & Day High/Low\n` +
    `👉 /news - Fresh Breaking News Stories\n` +
    `👉 /calendar - Today's US Economic Calendar Events\n` +
    `👉 /stop - Alerts Pause Karne Ke Liye\n\n` +
    `🆔 <b>Aapki Chat ID:</b> <code>${chatId}</code>`;

  bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
});

// /candle or /analyze
bot.onText(/\/(candle|analyze)/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  const analysis = await run5mChartAnalysis();
  if (!analysis) {
    bot.sendMessage(chatId, '⚠️ Chart candle data fetch karne me dikkat aayi. Kripya 1 minute baad try kare.');
    return;
  }

  const tradeLevels = analysis.sl 
    ? `💵 <b>Entry Price:</b> $${analysis.entry}\n` +
      `🛑 <b>Stop Loss (SL):</b> $${analysis.sl}\n` +
      `🎯 <b>Target 1 (TP1):</b> $${analysis.tp1}\n` +
      `🎯 <b>Target 2 (TP2):</b> $${analysis.tp2}\n\n`
    : `💵 <b>Current Price:</b> $${analysis.entry}\n💡 <i>Abhi consolidation / sideways zone hai. Breakout ka wait kare!</i>\n\n`;

  const report = `🤖 <b>5-MIN GOLD (XAU/USD) AI CHART ANALYSIS</b> 📊\n\n` +
    `🎯 <b>AI PREDICTION:</b> ${analysis.icon} <b>${analysis.prediction}</b>\n` +
    `⚡ <b>Confidence:</b> ${analysis.confidence}\n\n` +
    `${tradeLevels}` +
    `📈 <b>Technical Indicators:</b>\n` +
    `• Pattern: <b>${analysis.pattern}</b>\n` +
    `• EMA 9: $${analysis.ema9} | EMA 21: $${analysis.ema21}\n` +
    `• RSI (14): ${analysis.rsi}\n` +
    `• Support Level: $${analysis.support}\n` +
    `• Resistance Level: $${analysis.resistance}\n\n` +
    `🧠 <b>AI Rationale:</b>\n` +
    analysis.reasons.map(r => `• ${r}`).join('\n') + `\n\n` +
    `🕒 <i>Analyzed at: ${new Date().toLocaleTimeString('en-IN', { timeZone: TIMEZONE })} IST</i>`;

  bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
});

// /gold
bot.onText(/\/gold/, async (msg) => {
  const chatId = msg.chat.id;
  const gold = await fetchGoldPrice();

  if (!gold) {
    bot.sendMessage(chatId, '⚠️ Gold price fetch karne me dikkat aayi. Kripya thodi der baad try kare.');
    return;
  }

  const icon = gold.isUp ? '📈' : '📉';
  const response = `🟡 <b>US GOLD (XAU/USD) REAL-TIME STATS</b>\n\n` +
    `💵 <b>Price:</b> $${gold.price} / oz\n` +
    `${icon} <b>24h Change:</b> ${gold.change} (${gold.changePercent})\n` +
    `🔺 <b>Day High:</b> $${gold.dayHigh}\n` +
    `🔻 <b>Day Low:</b> $${gold.dayLow}\n\n` +
    `🕒 <i>Updated at: ${new Date().toLocaleTimeString('en-IN', { timeZone: TIMEZONE })} IST</i>`;

  bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
});

// /news
bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  const news = await fetchBreakingGoldNews();

  // Deduplicate on the fly
  const uniqueNews = [];
  const seenTitles = new Set();
  for (const item of news) {
    const cleaned = cleanTokens(item.title).join(' ');
    if (!seenTitles.has(cleaned)) {
      seenTitles.add(cleaned);
      uniqueNews.push(item);
    }
  }

  if (uniqueNews.length === 0) {
    bot.sendMessage(chatId, 'Abhi koi tazi news nahi mili.');
    return;
  }

  let text = `📰 <b>TOP LATEST US GOLD & MACRO NEWS (Deduplicated):</b>\n\n`;
  uniqueNews.slice(0, 4).forEach((item, index) => {
    const impact = analyzeGoldImpact(item.title);
    text += `<b>${index + 1}.</b> ${item.title}\n`;
    text += `🎯 ${impact.status}\n`;
    if (item.snippet) text += `📝 <i>${item.snippet.slice(0, 100)}...</i>\n`;
    text += `🔗 <a href="${item.link}">Source link</a>\n\n`;
  });

  bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// /calendar
bot.onText(/\/calendar/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  const events = await fetchForexFactoryUSDCalendar();

  if (events.length === 0) {
    bot.sendMessage(chatId, '📅 Is hafte koi High-Impact USD event schedule nahi hai.');
    return;
  }

  let text = `🔴 <b>FOREX FACTORY - US GOLD MOVING EVENTS:</b>\n\n`;
  events.slice(0, 6).forEach((ev, i) => {
    const d = new Date(ev.date);
    const dateStr = d.toLocaleDateString('en-IN', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-IN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });

    text += `<b>${i + 1}. ${ev.title}</b> (${ev.impact} Impact)\n`;
    text += `📅 <b>Time:</b> ${dateStr} at ${timeStr} IST\n`;
    text += `📊 <b>Forecast:</b> ${ev.forecast || '-'} | <b>Previous:</b> ${ev.previous || '-'}\n\n`;
  });

  text += `💡 <i>In events ke release par Gold me tez candle banti hai!</i>`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// /stop
bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  subscribers.delete(chatId);
  saveSubscribers();
  bot.sendMessage(chatId, '🛑 Aapne updates unsubscribe kar diya hai. Dobara shuru karne ke liye /start dabaye.');
});

// /help
bot.onText(/\/help/, (msg) => {
  const helpText = `🛠️ <b>US GOLD PRO BOT COMMANDS</b>\n\n` +
    `/candle - 5-Min Chart AI Analysis (UP/DOWN Prediction & Levels)\n` +
    `/gold - Current Real-Time XAU/USD Price & Stats\n` +
    `/news - Fresh Breaking News Stories (FXStreet & Reuters)\n` +
    `/calendar - Forex Factory US Events Schedule\n` +
    `/start - Subscribe to Automatic 5-Min Alerts\n` +
    `/stop - Stop Alerts`;

  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
});

// ==========================================
// 8. RENDER WEB SERVICE & KEEP-ALIVE
// ==========================================
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    service: 'US Gold Pro Telegram Bot',
    subscribersCount: subscribers.size,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  }));
});

server.listen(PORT, () => {
  console.log(`🌐 Health server listening on port ${PORT} (Render Web Service Ready)`);
});

// Self-ping to prevent Render Free Tier from going to sleep
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  console.log(`⚡ Keep-alive enabled for: ${RENDER_EXTERNAL_URL}`);
  setInterval(() => {
    fetch(RENDER_EXTERNAL_URL)
      .then(() => console.log('💓 Keep-alive ping sent.'))
      .catch(err => console.error('Keep-alive ping error:', err.message));
  }, 10 * 60 * 1000);
}

// ==========================================
// 9. BOT LAUNCH
// ==========================================
console.log('🚀 US Gold Pro Telegram Bot service starting...');
console.log(`⏱️ Scanning interval set to every ${INTERVAL_MINUTES} minute(s).`);

// Initial run
checkMarket();

// Recurring interval
setInterval(checkMarket, INTERVAL_MINUTES * 60 * 1000);
