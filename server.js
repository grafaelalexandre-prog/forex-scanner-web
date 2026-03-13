'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const { ScannerEngine } = require('./src/scannerEngine');
const { ForexAI }       = require('./src/forexAI');

const CONFIG = {
  port:           process.env.PORT             || 3000,
  apiKey:         process.env.TWELVE_API_KEY   || '',
  apiKeys:        (process.env.TWELVE_EXTRA_KEYS || '').split(',').filter(Boolean),
  finnhubKey:     process.env.FINNHUB_KEY       || 'd6lge5pr01qrq6i2kj3gd6lge5pr01qrq6i2kj40',
  telegramToken:  process.env.TELEGRAM_TOKEN    || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID  || '',
  pairs: ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','EUR/GBP','USD/CHF','GBP/JPY'],
  minScore:         75,
  cooldownMinutes:  10,
  pollIntervalMs:   60000,
  timeframe:        '15min',
};

const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'signals.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { signals: [], logs: [], winRate: null }; }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch {}
}

let appData = loadData();
const ai = new ForexAI();
console.log(`🧠 IA carregada — ${ai.model.totalSamples} amostras no modelo`);

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

app.get('/api/status', (req, res) => res.json({
  running: scanner?.isRunning || false,
  signals: appData.signals.length,
  winRate: appData.winRate,
  aiStats: ai.getStats(),
  config:  { pairs: CONFIG.pairs, timeframe: CONFIG.timeframe, minScore: CONFIG.minScore },
}));
app.get('/api/signals',  (req, res) => { const l = parseInt(req.query.limit)||50; res.json(appData.signals.slice(-l).reverse()); });
app.get('/api/logs',     (req, res) => res.json(appData.logs.slice(-100).reverse()));
app.get('/api/winrate',  (req, res) => res.json(appData.winRate || {}));
app.get('/api/ai/stats', (req, res) => res.json(ai.getStats()));
app.get('/api/ai/model', (req, res) => res.json(ai.model));
app.get('/api/export',   (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=forex-data.json');
  res.json({ signals: appData.signals, aiModel: ai.getStats(), exportedAt: new Date().toISOString() });
});
app.post('/api/ai/train', (req, res) => {
  const { signalId, outcome } = req.body;
  const sig = appData.signals.find(s => s.signalId === signalId);
  if (!sig) return res.status(404).json({ error: 'Sinal não encontrado' });
  ai.train(sig, outcome);
  res.json({ ok: true, stats: ai.getStats() });
});
app.post('/api/ai/reset', (req, res) => { ai.reset(); res.json({ ok: true }); });

let scanner;
function initScanner() {
  scanner = new ScannerEngine({
    apiKey: CONFIG.apiKey, apiKeys: CONFIG.apiKeys, finnhubKey: CONFIG.finnhubKey,
    telegramBotToken: CONFIG.telegramToken, telegramChatId: CONFIG.telegramChatId,
    pairs: CONFIG.pairs, minScore: CONFIG.minScore, cooldownMinutes: CONFIG.cooldownMinutes,
    pollIntervalMs: CONFIG.pollIntervalMs, timeframe: CONFIG.timeframe, enabled: true,
  });

  scanner.on('log', ({ level, message }) => {
    const entry = { ts: new Date().toISOString(), level, message };
    appData.logs.push(entry);
    if (appData.logs.length > 500) appData.logs = appData.logs.slice(-500);
    broadcast('log', entry);
    console.log(`[${level.toUpperCase()}] ${message}`);
  });

  scanner.on('signal', (sig) => {
    const prediction = ai.predict(sig);
    sig._aiPrediction = prediction;
    appData.signals.push(sig);
    if (appData.signals.length > 2000) appData.signals = appData.signals.slice(-2000);
    saveData(appData);
    broadcast('signal', sig);
    broadcast('ai-prediction', { signalId: sig.signalId, pair: sig.pair, ...prediction });
    console.log(`🎯 ${sig.pair} ${sig.direction} | Score ${sig.confidence} | IA: ${prediction.aprovado?'✅':'❌'} ${prediction.confianca}%`);
  });

  scanner.on('winloss', (result) => {
    const sig = appData.signals.find(s => s.signalId === result.signalId);
    if (sig) {
      ai.train(sig, result.outcome);
      broadcast('ai-trained', { signalId: result.signalId, outcome: result.outcome, stats: ai.getStats() });
    }
    broadcast('winloss', result);
  });

  scanner.on('winrate', (wr) => { appData.winRate = wr; saveData(appData); broadcast('winrate', wr); });
  scanner.on('status',     s => broadcast('status', s));
  scanner.on('price-live', p => broadcast('price', p));

  scanner.start();
  console.log(`✅ Scanner iniciado — ${CONFIG.pairs.length} pares | TF: ${CONFIG.timeframe}`);
}

server.listen(CONFIG.port, () => {
  console.log(`🚀 Forex Scanner Web na porta ${CONFIG.port}`);
  initScanner();
});

process.on('SIGTERM', () => { saveData(appData); process.exit(0); });
process.on('SIGINT',  () => { saveData(appData); process.exit(0); });
