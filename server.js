'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const { Pool }   = require('pg');
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

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      signal_id TEXT UNIQUE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      level TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS winrate (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_model (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('🗄️ PostgreSQL conectado e tabelas prontas');
}

async function dbSaveSignal(sig) {
  try {
    await pool.query(
      `INSERT INTO signals (signal_id, data) VALUES ($1, $2)
       ON CONFLICT (signal_id) DO UPDATE SET data = $2`,
      [sig.signalId || sig.id || String(Date.now()), JSON.stringify(sig)]
    );
  } catch(e) { console.error('DB save signal:', e.message); }
}

async function dbLoadSignals(limit = 2000) {
  try {
    const r = await pool.query(`SELECT data FROM signals ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(r => r.data);
  } catch(e) { console.error('DB load signals:', e.message); return []; }
}

async function dbSaveLog(level, message) {
  try {
    await pool.query(`INSERT INTO logs (level, message) VALUES ($1, $2)`, [level, message]);
    // keep only last 500
    await pool.query(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY created_at DESC LIMIT 500)`);
  } catch {}
}

async function dbLoadLogs(limit = 100) {
  try {
    const r = await pool.query(`SELECT level, message, created_at as ts FROM logs ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows;
  } catch(e) { return []; }
}

async function dbSaveWinRate(data) {
  try {
    await pool.query(
      `INSERT INTO winrate (id, data, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(data)]
    );
  } catch {}
}

async function dbLoadWinRate() {
  try {
    const r = await pool.query(`SELECT data FROM winrate WHERE id = 1`);
    return r.rows[0]?.data || null;
  } catch { return null; }
}

async function dbSaveAIModel(data) {
  try {
    await pool.query(
      `INSERT INTO ai_model (id, data, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(data)]
    );
  } catch {}
}

async function dbLoadAIModel() {
  try {
    const r = await pool.query(`SELECT data FROM ai_model WHERE id = 1`);
    return r.rows[0]?.data || null;
  } catch { return null; }
}

// ── App ───────────────────────────────────────────────────────────────────────
let appData = { signals: [], logs: [], winRate: null };

const ai = new ForexAI();

// Override AI save/load to use DB
const _origSave = ai._save.bind(ai);
ai._save = async () => {
  try { await dbSaveAIModel(ai.model); } catch { _origSave(); }
};

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({
  running: scanner?.isRunning || false,
  signals: appData.signals.length,
  winRate: appData.winRate,
  aiStats: ai.getStats(),
  config:  { pairs: CONFIG.pairs, timeframe: CONFIG.timeframe, minScore: CONFIG.minScore },
}));

app.get('/api/signals', async (req, res) => {
  const l = parseInt(req.query.limit) || 50;
  try {
    const sigs = await dbLoadSignals(l);
    res.json(sigs);
  } catch { res.json(appData.signals.slice(-l).reverse()); }
});

app.get('/api/logs', async (req, res) => {
  try {
    const logs = await dbLoadLogs(100);
    res.json(logs);
  } catch { res.json(appData.logs.slice(-100).reverse()); }
});

app.get('/api/winrate',  (req, res) => res.json(appData.winRate || {}));
app.get('/api/ai/stats', (req, res) => res.json(ai.getStats()));
app.get('/api/ai/model', (req, res) => res.json(ai.model));

app.get('/api/export', async (req, res) => {
  const sigs = await dbLoadSignals(5000);
  res.setHeader('Content-Disposition', 'attachment; filename=forex-data.json');
  res.json({ signals: sigs, aiModel: ai.getStats(), exportedAt: new Date().toISOString() });
});

app.post('/api/ai/train', async (req, res) => {
  const { signalId, outcome } = req.body;
  const sigs = await dbLoadSignals(2000);
  const sig  = sigs.find(s => s.signalId === signalId);
  if (!sig) return res.status(404).json({ error: 'Sinal não encontrado' });
  ai.train(sig, outcome);
  await dbSaveAIModel(ai.model);
  res.json({ ok: true, stats: ai.getStats() });
});

app.post('/api/ai/reset', async (req, res) => {
  ai.reset();
  await dbSaveAIModel(ai.model);
  res.json({ ok: true });
});

// ── Scanner ───────────────────────────────────────────────────────────────────
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
    dbSaveLog(level, message);
    console.log(`[${level.toUpperCase()}] ${message}`);
  });

  scanner.on('signal', async (sig) => {
    const prediction = ai.predict(sig);
    sig._aiPrediction = prediction;
    appData.signals.push(sig);
    if (appData.signals.length > 2000) appData.signals = appData.signals.slice(-2000);
    await dbSaveSignal(sig);
    broadcast('signal', sig);
    broadcast('ai-prediction', { signalId: sig.signalId, pair: sig.pair, ...prediction });
    console.log(`🎯 ${sig.pair} ${sig.direction} | Score ${sig.confidence} | IA: ${prediction.aprovado?'✅':'❌'} ${prediction.confianca}%`);
  });

  scanner.on('winloss', async (result) => {
    const sigs = await dbLoadSignals(2000);
    const sig  = sigs.find(s => s.signalId === result.signalId);
    if (sig) {
      ai.train(sig, result.outcome);
      await dbSaveAIModel(ai.model);
      broadcast('ai-trained', { signalId: result.signalId, outcome: result.outcome, stats: ai.getStats() });
    }
    broadcast('winloss', result);
  });

  scanner.on('winrate', async (wr) => {
    appData.winRate = wr;
    await dbSaveWinRate(wr);
    broadcast('winrate', wr);
  });

  scanner.on('status',     s => broadcast('status', s));
  scanner.on('price-live', p => broadcast('price', p));

  scanner.start();
  console.log(`✅ Scanner iniciado — ${CONFIG.pairs.length} pares | TF: ${CONFIG.timeframe}`);
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  // Init DB
  await dbInit();

  // Load AI model from DB
  const savedModel = await dbLoadAIModel();
  if (savedModel) {
    ai.model = { ...ai.model, ...savedModel };
    console.log(`🧠 IA carregada do banco — ${ai.model.totalSamples} amostras`);
  } else {
    console.log(`🧠 IA nova — 0 amostras no modelo`);
  }

  // Load winrate from DB
  const savedWR = await dbLoadWinRate();
  if (savedWR) appData.winRate = savedWR;

  // Load recent signals into memory
  appData.signals = await dbLoadSignals(200);

  server.listen(CONFIG.port, () => {
    console.log(`🚀 Forex Scanner Web na porta ${CONFIG.port}`);
    initScanner();
  });
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT',  () => { process.exit(0); });
