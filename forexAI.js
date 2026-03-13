'use strict';

/**
 * ═══════════════════════════════════════════════════════
 *  FOREX AI ENGINE — IA Própria com Aprendizado
 *  
 *  Features:
 *    - Estratégia + Regime + Bias H1 + Sessão
 *    - ADX band, Score band, RR band
 *    - Hora exata (UTC, granularidade 1h)
 *    - estratégia+hora (detecta FVG Bearish que falha às 12:50)
 *    - estratégia+regime (detecta EMA9 que falha em RANGE)
 *    - par+hora (detecta USD/CAD ruim de tarde)
 *    - Bloqueio automático: estratégia bloqueada se WR < 40% em horário
 * ═══════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');
const MODEL_FILE = path.join(__dirname, '..', 'data', 'ai_model.json');

// ── Feature extractors ─────────────────────────────────────────────────────
function extractFeatures(signal) {
  const dt   = new Date(signal.createdAt);
  // Horário de Fortaleza (UTC-3)
  const hourUTC  = dt.getUTCHours();
  const hourLocal = (hourUTC - 3 + 24) % 24;
  const adx   = parseFloat(signal.adxValue) || 0;
  const strat = signal.strategy || 'unknown';
  const regime = signal.regime || 'unknown';

  return {
    // Features simples
    strategy:    strat,
    regime:      regime,
    h1Bias:      signal.h1Bias   || 'NEUTRAL',
    session:     signal.session  || 'unknown',
    pair:        signal.pair     || 'unknown',
    direction:   signal.direction|| 'unknown',
    adxBand:     adx < 20 ? 'fraco' : adx < 30 ? 'medio' : adx < 40 ? 'forte' : 'muito_forte',
    scoreBand:   signal.confidence < 80 ? '70s' : signal.confidence < 90 ? '80s' : '90plus',
    rrBand:      parseFloat(signal.rr) >= 2 ? 'rr_alto' : parseFloat(signal.rr) >= 1.5 ? 'rr_medio' : 'rr_baixo',

    // Hora granular (1h) no horário local Fortaleza
    hora:        `h${hourLocal}`,

    // Features compostas — mais preditivas
    stratHora:   `${strat}__h${hourLocal}`,       // FVG Bearish às 12 → falha
    stratRegime: `${strat}__${regime}`,           // EMA9 em RANGE → falha
    pairHora:    `${signal.pair}__h${hourLocal}`, // USD/CAD às 13 → ruim
    regimeBias:  `${regime}__${signal.h1Bias||'?'}`,
    h1Session:   `${signal.h1Bias||'?'}__${signal.session||'?'}`,
  };
}

// ── Modelo ─────────────────────────────────────────────────────────────────
class ForexAI {
  constructor() {
    this.model = this._load();
  }

  _defaultModel() {
    return {
      version: 2,
      totalSamples: 0,
      wins: 0,
      losses: 0,
      features: {},
      featureWeights: {
        strategy:    1.5,
        regime:      1.3,
        h1Bias:      1.4,
        session:     1.0,
        pair:        0.8,
        direction:   0.6,
        adxBand:     1.2,
        scoreBand:   1.6,
        rrBand:      1.1,
        hora:        1.4,        // hora sozinha já tem peso alto
        stratHora:   2.5,        // estratégia+hora = feature mais preditiva
        stratRegime: 2.2,        // estratégia+regime
        pairHora:    1.8,        // par+hora
        regimeBias:  2.0,
        h1Session:   1.5,
      },
      // Bloqueios automáticos: { "FVG Bearish__h12": true }
      blockedCombos: {},
      history: [],
      createdAt: new Date().toISOString(),
      lastTrained: null,
    };
  }

  _load() {
    try {
      if (fs.existsSync(MODEL_FILE)) {
        const m = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));
        if (!m.featureWeights) m.featureWeights = this._defaultModel().featureWeights;
        if (!m.history)        m.history = [];
        if (!m.blockedCombos)  m.blockedCombos = {};
        // Garante novas features de peso
        const def = this._defaultModel().featureWeights;
        for (const k of Object.keys(def)) {
          if (m.featureWeights[k] == null) m.featureWeights[k] = def[k];
        }
        return m;
      }
    } catch (e) { console.error('AI load error:', e.message); }
    return this._defaultModel();
  }

  save() {
    try {
      const dir = path.dirname(MODEL_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(MODEL_FILE, JSON.stringify(this.model, null, 2));
    } catch (e) { console.error('AI save error:', e.message); }
  }

  // ── Treina com resultado ───────────────────────────────────────────────
  train(signal, outcome) {
    if (!['WIN', 'LOSS'].includes(outcome)) return;
    const isWin = outcome === 'WIN';
    const feats  = extractFeatures(signal);

    this.model.totalSamples++;
    if (isWin) this.model.wins++; else this.model.losses++;

    for (const [fType, fVal] of Object.entries(feats)) {
      const key = `${fType}::${fVal}`;
      if (!this.model.features[key]) this.model.features[key] = { wins: 0, losses: 0 };
      if (isWin) this.model.features[key].wins++;
      else       this.model.features[key].losses++;
    }

    // Histórico
    this.model.history.push({
      signalId:  signal.signalId,
      pair:      signal.pair,
      strategy:  signal.strategy,
      direction: signal.direction,
      score:     signal.confidence,
      outcome,
      hora:      feats.hora,
      stratHora: feats.stratHora,
      trainedAt: new Date().toISOString(),
    });
    if (this.model.history.length > 1000) this.model.history.shift();

    // Atualiza bloqueios automáticos
    this._updateBlocks();
    // Atualiza pesos adaptativos
    this._updateWeights();

    this.model.lastTrained = new Date().toISOString();
    this.save();

    const blocked = Object.keys(this.model.blockedCombos).filter(k => this.model.blockedCombos[k]);
    console.log(`🧠 AI treinada: ${signal.pair} ${outcome} | ${this.model.totalSamples} amostras | ${blocked.length} combos bloqueados`);
  }

  // ── Detecta e bloqueia combos ruins (WR < 38% com ≥ 5 amostras) ───────
  _updateBlocks() {
    // Analisa features compostas de alto impacto
    const highImpact = ['stratHora', 'stratRegime', 'pairHora'];

    for (const fType of highImpact) {
      const entries = Object.entries(this.model.features)
        .filter(([k]) => k.startsWith(fType + '::'));

      for (const [key, v] of entries) {
        const total = v.wins + v.losses;
        if (total < 5) continue;
        const wr = v.wins / total;
        const comboName = key.replace(fType + '::', '');

        if (wr < 0.38) {
          if (!this.model.blockedCombos[comboName]) {
            this.model.blockedCombos[comboName] = true;
            console.log(`🚫 AI BLOQUEOU combo: ${comboName} (WR ${Math.round(wr*100)}% em ${total} ops)`);
          }
        } else if (wr >= 0.50 && this.model.blockedCombos[comboName]) {
          // Desbloqueia se melhorou
          delete this.model.blockedCombos[comboName];
          console.log(`✅ AI DESBLOQUEOU combo: ${comboName} (WR ${Math.round(wr*100)}%)`);
        }
      }
    }
  }

  // ── Verifica se sinal está em combo bloqueado ──────────────────────────
  _getBlockedReasons(feats) {
    const reasons = [];
    const toCheck = {
      stratHora:   feats.stratHora,
      stratRegime: feats.stratRegime,
      pairHora:    feats.pairHora,
    };
    for (const [fType, val] of Object.entries(toCheck)) {
      if (this.model.blockedCombos[val]) {
        const key = `${fType}::${val}`;
        const entry = this.model.features[key] || { wins: 0, losses: 0 };
        const total = entry.wins + entry.losses;
        const wr    = total > 0 ? Math.round(entry.wins / total * 100) : 0;
        reasons.push({ combo: val, wr, total, fType });
      }
    }
    return reasons;
  }

  // ── Atualiza pesos por variância ───────────────────────────────────────
  _updateWeights() {
    if (this.model.totalSamples < 10) return;
    for (const fType of Object.keys(this.model.featureWeights)) {
      const entries = Object.entries(this.model.features)
        .filter(([k]) => k.startsWith(fType + '::'));
      if (entries.length < 2) continue;
      const rates = entries
        .filter(([, v]) => (v.wins + v.losses) >= 3)
        .map(([, v]) => v.wins / (v.wins + v.losses));
      if (rates.length < 2) continue;
      const mean     = rates.reduce((a, b) => a + b, 0) / rates.length;
      const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
      const newW     = 0.5 + (variance / 0.25) * 2.0;
      this.model.featureWeights[fType] =
        this.model.featureWeights[fType] * 0.7 + Math.min(newW, 3.0) * 0.3;
    }
  }

  // ── Predição ───────────────────────────────────────────────────────────
  predict(signal) {
    const feats = extractFeatures(signal);

    // Verifica bloqueios PRIMEIRO
    const blocked = this._getBlockedReasons(feats);
    if (blocked.length > 0) {
      const b = blocked[0];
      return {
        aprovado:    false,
        confianca:   15,
        motivo:      `🚫 BLOQUEADO: ${b.combo.replace('__', ' às ')} tem WR de apenas ${b.wr}% (${b.total} ops históricas)`,
        risco:       'alto',
        observacao:  'A IA aprendeu que essa combinação falha com frequência nesse horário/regime',
        bloqueado:   true,
        blockedBy:   blocked,
        amostras:    this.model.totalSamples,
        features:    feats,
      };
    }

    const total    = this.model.totalSamples;
    const priorWin = total > 0 ? this.model.wins / total : 0.5;

    if (total < 5) return this._heuristic(signal, feats);

    let logOdds = Math.log(priorWin / (1 - priorWin + 1e-9));

    for (const [fType, fVal] of Object.entries(feats)) {
      const key   = `${fType}::${fVal}`;
      const entry = this.model.features[key] || { wins: 0, losses: 0 };
      const w     = this.model.featureWeights[fType] || 1.0;
      const pWin  = (entry.wins   + 1) / (this.model.wins   + 2);
      const pLoss = (entry.losses + 1) / (this.model.losses + 2);
      logOdds += w * Math.log(pWin / (pLoss + 1e-9));
    }

    const probWin   = 1 / (1 + Math.exp(-logOdds));
    const confianca = Math.round(probWin * 100);

    return this._buildResult(signal, feats, probWin, confianca, blocked);
  }

  _heuristic(signal, feats) {
    let score = 50;
    if (feats.regime === 'TREND_UP'   && feats.h1Bias?.includes('BULLISH')) score += 10;
    if (feats.regime === 'TREND_DOWN' && feats.h1Bias?.includes('BEARISH')) score += 10;
    if (feats.regime === 'RANGE')      score -= 5;
    if (feats.adxBand === 'forte' || feats.adxBand === 'muito_forte') score += 8;
    if (feats.adxBand === 'fraco')     score -= 8;
    if (feats.scoreBand === '90plus')  score += 12;
    if (feats.scoreBand === '80s')     score += 5;
    if (feats.rrBand === 'rr_alto')    score += 8;
    const prob = Math.min(Math.max(score / 100, 0.2), 0.9);
    return this._buildResult(signal, feats, prob, Math.round(prob * 100), []);
  }

  _buildResult(signal, feats, probWin, confianca, blocked) {
    const aprovado = confianca >= 58;
    const risco    = confianca >= 70 ? 'baixo' : confianca >= 55 ? 'médio' : 'alto';
    const total    = this.model.totalSamples;
    const motivos  = [];

    if (total >= 5) {
      for (const [fType, fVal] of Object.entries(feats)) {
        const key   = `${fType}::${fVal}`;
        const entry = this.model.features[key];
        if (!entry || (entry.wins + entry.losses) < 3) continue;
        const wr = entry.wins / (entry.wins + entry.losses);
        const n  = entry.wins + entry.losses;
        const w  = this.model.featureWeights[fType] || 1;
        if (wr >= 0.65 && w >= 1.5) motivos.push(`${fVal.replace(/__/g,' + ')} → ${Math.round(wr*100)}% WR (${n} ops)`);
        if (wr <= 0.35 && w >= 1.5) motivos.push(`⚠️ ${fVal.replace(/__/g,' + ')} → apenas ${Math.round(wr*100)}% WR`);
      }
    } else {
      motivos.push(`Modelo com ${total} amostras — heurísticas iniciais`);
    }

    let observacao = '';
    if (feats.adxBand === 'muito_forte') observacao = 'ADX muito alto — possível exaustão da tendência';
    else if (feats.scoreBand === '90plus') observacao = 'Score excelente — alta convicção do scanner';
    else if (feats.rrBand === 'rr_baixo') observacao = 'RR abaixo de 1.5 — avalie se vale entrar';
    else if (feats.regime === 'RANGE' && feats.adxBand === 'fraco') observacao = 'Mercado em range com ADX fraco — evite entradas';

    return {
      aprovado, confianca,
      motivo: motivos.length > 0
        ? motivos.slice(0, 2).join(' | ')
        : aprovado
          ? `Padrão favorável: ${feats.regime} + ${feats.h1Bias} às ${feats.hora}`
          : `Padrão desfavorável: ${feats.regime} + ${feats.h1Bias} às ${feats.hora}`,
      risco, observacao,
      bloqueado: false,
      amostras:  total,
      probWin:   Math.round(probWin * 100) / 100,
      features:  feats,
    };
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  getStats() {
    const total    = this.model.totalSamples;
    const globalWR = total > 0 ? Math.round(this.model.wins / total * 100) : null;

    const fEntries = Object.entries(this.model.features)
      .filter(([, v]) => (v.wins + v.losses) >= 5)
      .map(([k, v]) => ({ key: k, wr: Math.round(v.wins/(v.wins+v.losses)*100), n: v.wins+v.losses }))
      .sort((a, b) => b.wr - a.wr);

    // Estatísticas por hora
    const byHour = {};
    for (const h of this.model.history) {
      const hora = h.hora || 'h?';
      if (!byHour[hora]) byHour[hora] = { wins: 0, losses: 0 };
      if (h.outcome === 'WIN') byHour[hora].wins++;
      else byHour[hora].losses++;
    }
    const hourStats = Object.entries(byHour)
      .map(([h, v]) => ({ hora: h, wins: v.wins, losses: v.losses, total: v.wins+v.losses, wr: Math.round(v.wins/(v.wins+v.losses)*100) }))
      .sort((a, b) => parseInt(a.hora.slice(1)) - parseInt(b.hora.slice(1)));

    // Estratégias
    const strategies = {};
    for (const h of this.model.history) {
      const s = h.strategy || 'unknown';
      if (!strategies[s]) strategies[s] = { wins: 0, losses: 0 };
      if (h.outcome === 'WIN') strategies[s].wins++;
      else strategies[s].losses++;
    }
    const stratStats = Object.entries(strategies)
      .map(([name, v]) => ({ name, wins: v.wins, losses: v.losses, total: v.wins+v.losses, wr: Math.round(v.wins/(v.wins+v.losses)*100) }))
      .sort((a, b) => b.wr - a.wr);

    // Bloqueios ativos
    const blockedCombos = Object.entries(this.model.blockedCombos)
      .filter(([, v]) => v)
      .map(([combo]) => {
        // Tenta encontrar stats do combo
        const key = Object.keys(this.model.features).find(k => k.endsWith('::' + combo));
        const entry = key ? this.model.features[key] : null;
        const n  = entry ? entry.wins + entry.losses : 0;
        const wr = entry && n > 0 ? Math.round(entry.wins / n * 100) : 0;
        return { combo, wr, total: n };
      });

    return {
      totalSamples:  total,
      wins:          this.model.wins,
      losses:        this.model.losses,
      globalWinRate: globalWR,
      topPositive:   fEntries.slice(0, 8),
      topNegative:   fEntries.slice(-8).reverse(),
      featureWeights: this.model.featureWeights,
      strategies:    stratStats,
      hourStats,
      blockedCombos,
      lastTrained:   this.model.lastTrained,
      createdAt:     this.model.createdAt,
    };
  }

  reset() {
    this.model = this._defaultModel();
    this.save();
    console.log('🧠 AI: modelo resetado');
  }
}

module.exports = { ForexAI };
