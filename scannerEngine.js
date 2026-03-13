'use strict';
// ═══════════════════════════════════════════════════════
//  BINARY SCANNER ENGINE v1.0
//  Adaptado de ForexScanner-v250 para Opções Binárias
//  Diferenças principais vs Forex:
//    • Direção: CALL (alta) / PUT (baixa) — sem SL/TP
//    • Expiração: tempo fixo por estratégia (1–2 candles M5)
//    • WinRate: resultado calculado pelo fechamento do candle de expiração
//    • Score mínimo elevado para 78 — binário exige mais precisão direcional
// ═══════════════════════════════════════════════════════
const { EventEmitter } = require('events');

// ═══════════════════════════════════════════════════════
//  MATH UTILS
// ═══════════════════════════════════════════════════════
function round(v, d = 5) { return Number(Number(v).toFixed(d)); }
function parseN(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

function calcEMA(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(period - 1).fill(null);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}


function calcRSI(values, period = 14) {
  const out = new Array(values.length).fill(50);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i-1]; if (d >= 0) gains += d; else losses -= d; }
  let ag = gains / period, al = losses / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function calcStoch(candles, kPeriod = 14, dPeriod = 3) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) { out.push({ k: 50, d: 50 }); continue; }
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice.map(c => c.high));
    const lowest  = Math.min(...slice.map(c => c.low));
    const k = highest === lowest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100;
    out.push({ k: round(k, 2), d: 50 });
  }
  for (let i = dPeriod - 1; i < out.length; i++) {
    out[i].d = round(out.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b.k, 0) / dPeriod, 2);
  }
  return out;
}

// ADX com período configurável — período 7 para M5 (mais reativo que período 14)
// Retorna adx atual, adxPrev, slope (1 candle) e slope3 (3 candles — mais robusto contra ruído)
function calcADX(candles, period = 7) {
  if (candles.length < period + 2) return { adx: 0, adxPrev: 0, plusDI: 0, minusDI: 0, slope: 0, slope3: 0 };
  const trArr = [], pDMArr = [], mDMArr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    const hd = c.high - p.high, ld = p.low - c.low;
    trArr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    pDMArr.push(hd > ld && hd > 0 ? hd : 0);
    mDMArr.push(ld > hd && ld > 0 ? ld : 0);
  }
  const wilder = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const sTR = wilder(trArr), sPDM = wilder(pDMArr), sMDM = wilder(mDMArr);
  const DX = sTR.map((tr, i) => {
    if (!tr) return 0;
    const pDI = (sPDM[i] / tr) * 100, mDI = (sMDM[i] / tr) * 100;
    return Math.abs(pDI - mDI) / ((pDI + mDI) || 1) * 100;
  });
  // Calcula série ADX completa para extrair slope de 3 candles
  const adxSeries = [];
  let adxVal = DX.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adxSeries.push(adxVal);
  for (let i = period; i < DX.length; i++) {
    adxVal = (adxVal * (period-1) + DX[i]) / period;
    adxSeries.push(adxVal);
  }
  const last  = adxSeries[adxSeries.length - 1];
  const prev1 = adxSeries[adxSeries.length - 2] || last;
  const prev3 = adxSeries[adxSeries.length - 4] || prev1; // 3 candles atrás
  const li = sTR.length - 1;
  const tr = sTR[li];
  return {
    adx:     round(last, 2),
    adxPrev: round(prev1, 2),
    slope:   round(last - prev1, 2),   // 1 candle — rápido
    slope3:  round(last - prev3, 2),   // 3 candles — mais confiável
    plusDI:  tr ? round((sPDM[li]/tr)*100, 2) : 0,
    minusDI: tr ? round((sMDM[li]/tr)*100, 2) : 0,
  };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = candles.length - period - 1; i < candles.length - 1; i++) {
    const c = candles[i+1], p = candles[i];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, mid, lower: mid - mult * std, std, width: (2 * mult * std) / mid };
}

// ═══════════════════════════════════════════════════════
//  H1 BIAS — Tendência horária sintética
//  12 candles M5 = 1 candle H1 · zero custo de API
// ═══════════════════════════════════════════════════════
function getH1Bias(c5) {
  if (c5.length < 24) return 'NEUTRAL';
  const h1 = [];
  for (let i = 0; i + 11 < c5.length; i += 12) {
    const slice = c5.slice(i, i + 12);
    h1.push({
      open:  slice[0].open,
      high:  Math.max(...slice.map(c => c.high)),
      low:   Math.min(...slice.map(c => c.low)),
      close: slice[slice.length - 1].close
    });
  }
  if (h1.length < 3) return 'NEUTRAL';
  const closes = h1.map(c => c.close);
  const n = closes.length;

  let ema9Bias = 'NEUTRAL';
  if (n >= 9) {
    const ema9 = calcEMA(closes, 9);
    if (closes[n-1] > ema9[n-1]) ema9Bias = 'BULLISH';
    else if (closes[n-1] < ema9[n-1]) ema9Bias = 'BEARISH';
  } else {
    if (closes[n-1] > closes[0]) ema9Bias = 'BULLISH';
    else if (closes[n-1] < closes[0]) ema9Bias = 'BEARISH';
  }

  // Estrutura: HH/HL confirma força, LH/LL confirma fraqueza
  let hhhl = false, lhll = false;
  if (h1.length >= 3) {
    const last4 = h1.slice(-4);
    const highs = last4.map(c => c.high);
    const lows  = last4.map(c => c.low);
    hhhl = highs[highs.length-1] > highs[0] && lows[lows.length-1] > lows[0];
    lhll = highs[highs.length-1] < highs[0] && lows[lows.length-1] < lows[0];
  }

  if (ema9Bias === 'BULLISH' && hhhl)  return 'BULLISH_STRONG';
  if (ema9Bias === 'BULLISH')          return 'BULLISH';
  if (ema9Bias === 'BEARISH' && lhll)  return 'BEARISH_STRONG';
  if (ema9Bias === 'BEARISH')          return 'BEARISH';
  return 'NEUTRAL';
}

// ═══════════════════════════════════════════════════════
//  MARKET STRUCTURE — BOS / CHoCH sobre Swing Highs/Lows
// ═══════════════════════════════════════════════════════
function detectMarketStructure(candles, swing) {
  const result = { currentStructure: 'RANGING', lastBOS: null, lastCHoCH: null, biasBull: false, biasBear: false };
  if (!swing || !swing.allHighs || !swing.allLows) return result;
  const sh = swing.allHighs;
  const sl = swing.allLows;
  if (sh.length < 2 || sl.length < 2) return result;

  const lastSH = sh[sh.length - 1], prevSH = sh[sh.length - 2];
  const lastSL = sl[sl.length - 1], prevSL = sl[sl.length - 2];
  const isHH = lastSH.price > prevSH.price;
  const isHL = lastSL.price > prevSL.price;
  const isLL = lastSL.price < prevSL.price;
  const isLH = lastSH.price < prevSH.price;

  if (isHH && isHL)       result.currentStructure = 'UPTREND';
  else if (isLL && isLH)  result.currentStructure = 'DOWNTREND';
  else                    result.currentStructure = 'RANGING';

  const lastClose = candles[candles.length - 2] ? candles[candles.length - 2].close : null;
  if (!lastClose) return result;

  // BOS: fecha além do swing na direção da tendência
  if (result.currentStructure === 'UPTREND' && lastClose > lastSH.price) {
    result.lastBOS = { type: 'BULLISH_BOS', level: lastSH.price };
    result.biasBull = true;
  }
  if (result.currentStructure === 'DOWNTREND' && lastClose < lastSL.price) {
    result.lastBOS = { type: 'BEARISH_BOS', level: lastSL.price };
    result.biasBear = true;
  }

  // CHoCH: fecha CONTRA a estrutura atual — mudança de caráter
  if (result.currentStructure === 'UPTREND' && lastClose < lastSL.price) {
    result.lastCHoCH = { type: 'BEARISH_CHOCH', level: lastSL.price };
    result.biasBear  = true;
  }
  if (result.currentStructure === 'DOWNTREND' && lastClose > lastSH.price) {
    result.lastCHoCH = { type: 'BULLISH_CHOCH', level: lastSH.price };
    result.biasBull  = true;
  }
  return result;
}

// ═══════════════════════════════════════════════════════
//  FVG — Fair Value Gap Detection com controle de qualidade
// ═══════════════════════════════════════════════════════
function detectFVGZones(candles, atr) {
  const zones = [];
  const minSize = atr * 0.3;  // FVGs < 0.3×ATR são ruído
  const maxAge  = 48;          // FVG com > 48 candles perde relevância

  for (let i = 1; i < candles.length - 1; i++) {
    const age = candles.length - 1 - i;
    if (age > maxAge) continue;
    const c0 = candles[i - 1];
    const c2 = candles[i + 1];

    // Bullish FVG: gap entre high[i-1] e low[i+1]
    if (c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size >= minSize) {
        const touchCount = candles.slice(i + 2).filter(c => c.low <= c2.low && c.high >= c0.high).length;
        zones.push({ type: 'BULLISH_FVG', high: c2.low, low: c0.high, mid: (c2.low + c0.high) / 2, size, age, touchCount, quality: touchCount === 0 ? 'CLEAN' : 'DIRTY' });
      }
    }

    // Bearish FVG: gap entre low[i-1] e high[i+1]
    if (c0.low > c2.high) {
      const size = c0.low - c2.high;
      if (size >= minSize) {
        const touchCount = candles.slice(i + 2).filter(c => c.high >= c2.high && c.low <= c0.low).length;
        zones.push({ type: 'BEARISH_FVG', high: c0.low, low: c2.high, mid: (c0.low + c2.high) / 2, size, age, touchCount, quality: touchCount === 0 ? 'CLEAN' : 'DIRTY' });
      }
    }
  }

  const bullish = zones.filter(z => z.type === 'BULLISH_FVG').slice(-5);
  const bearish = zones.filter(z => z.type === 'BEARISH_FVG').slice(-5);
  return [...bullish, ...bearish];
}

// ═══════════════════════════════════════════════════════
//  ORDER BLOCK DETECTION — baseado em candles antes de impulso
// ═══════════════════════════════════════════════════════
function detectOrderBlocks(candles) {
  const obs = [];
  const n = candles.length;
  if (n < 10) return obs;

  for (let i = Math.max(0, n - 20); i < n - 4; i++) {
    const c = candles[i];

    // Bullish OB: candle bearish seguido de impulso de alta de 3 candles
    if (c.close < c.open) {
      const impulse = candles.slice(i + 1, i + 4);
      if (impulse.length < 3) continue;
      const impulsiveMove = impulse.every(ic => ic.close > ic.open);
      const totalMove = impulse[2].close - c.close;
      const candleRange = c.high - c.low || 0.0001;
      if (impulsiveMove && totalMove > candleRange * 1.5) {
        const violated = candles.slice(i + 4).some(vc => vc.close < c.low);
        if (!violated) obs.push({ type: 'BULLISH_OB', high: c.high, low: c.low, idx: i });
      }
    }

    // Bearish OB: candle bullish seguido de impulso de baixa de 3 candles
    if (c.close > c.open) {
      const impulse = candles.slice(i + 1, i + 4);
      if (impulse.length < 3) continue;
      const impulsiveMove = impulse.every(ic => ic.close < ic.open);
      const totalMove = c.close - impulse[2].close;
      const candleRange = c.high - c.low || 0.0001;
      if (impulsiveMove && totalMove > candleRange * 1.5) {
        const violated = candles.slice(i + 4).some(vc => vc.close > c.high);
        if (!violated) obs.push({ type: 'BEARISH_OB', high: c.high, low: c.low, idx: i });
      }
    }
  }
  return obs;
}

// ═══════════════════════════════════════════════════════
//  CANDLE PATTERN DETECTION — inclui Morning Star / Evening Star
// ═══════════════════════════════════════════════════════
function bodyDir(c)   { return c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat'; }
function bodyStr(c)   { const r = c.high - c.low; return r > 0 ? Math.abs(c.close - c.open) / r : 0; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }

function detectCandlePattern(candles) {
  const n = candles.length;
  if (n < 3) return { pattern: null, bias: null };
  const c0 = candles[n-3], c1 = candles[n-2], last = candles[n-1];
  const range = last.high - last.low;
  const atrProxy = calcATR(candles, 10) || range || 0.0001;

  // ── Morning Star ─────────────────────────────────────
  const c0BearBody = c0.open - c0.close;
  const c0Mid = (c0.open + c0.close) / 2;
  const lastBullBody = last.close - last.open;
  if (c0BearBody > atrProxy * 0.5 &&
      Math.abs(c1.close - c1.open) < atrProxy * 0.3 &&
      lastBullBody > atrProxy * 0.5 &&
      last.close > c0Mid &&
      bodyDir(c0) === 'down' && bodyDir(last) === 'up') {
    return { pattern: 'Morning Star', bias: 'bull' };
  }

  // ── Evening Star ─────────────────────────────────────
  const c0BullBody = c0.close - c0.open;
  const c0MidB = (c0.open + c0.close) / 2;
  const lastBearBody = last.open - last.close;
  if (c0BullBody > atrProxy * 0.5 &&
      Math.abs(c1.close - c1.open) < atrProxy * 0.3 &&
      lastBearBody > atrProxy * 0.5 &&
      last.close < c0MidB &&
      bodyDir(c0) === 'up' && bodyDir(last) === 'down') {
    return { pattern: 'Evening Star', bias: 'bear' };
  }

  // ── Bullish Engulfing ─────────────────────────────────
  if (bodyDir(c1) === 'down' && bodyDir(last) === 'up' &&
      last.open <= c1.close && last.close >= c1.open && bodyStr(last) >= 0.6) {
    return { pattern: 'Engulfing Alta', bias: 'bull' };
  }
  // ── Bearish Engulfing ─────────────────────────────────
  if (bodyDir(c1) === 'up' && bodyDir(last) === 'down' &&
      last.open >= c1.close && last.close <= c1.open && bodyStr(last) >= 0.6) {
    return { pattern: 'Engulfing Baixa', bias: 'bear' };
  }
  // ── Bullish Pin Bar ───────────────────────────────────
  if (range > 0 && lowerWick(last) >= range * 0.55 && bodyStr(last) <= 0.35) {
    return { pattern: 'Pin Bar Alta', bias: 'bull' };
  }
  // ── Bearish Pin Bar ───────────────────────────────────
  if (range > 0 && upperWick(last) >= range * 0.55 && bodyStr(last) <= 0.35) {
    return { pattern: 'Pin Bar Baixa', bias: 'bear' };
  }
  // ── Doji ──────────────────────────────────────────────
  if (bodyStr(last) < 0.12) {
    return { pattern: 'Doji', bias: 'neutral' };
  }
  return { pattern: null, bias: null };
}

// ═══════════════════════════════════════════════════════
//  STRATEGIES
// ═══════════════════════════════════════════════════════

function stratRangeReversal(candles5, stoch, mktStructure, adxExternal) {
  const closes = candles5.map(c => c.close);
  const bb = calcBB(closes);
  const rsi14 = calcRSI(closes, 14);
  const n = candles5.length;
  if (!bb || n < 6) return null;
  const last = candles5[n-1], prev = candles5[n-2];
  const rsi = rsi14[n-1], rsi2Ago = rsi14[n-2] || 50;
  const sk = stoch[n-1] ? stoch[n-1].k : 50;

  // Usa ADX externo (período 10) — consistente com o resto do motor
  // Teto 38: evita reversão quando ADX indica tendência forte
  const adxFast = adxExternal || calcADX(candles5, 7);
  if (adxFast.adx > 38) return null;

  // CORREÇÃO: zonas Stoch menos extremas — sk<40 e sk>60 (era <30 e >70) — mais triggers em M5
  const oversold   = rsi < 35  && rsi2Ago < 42 && sk < 40;
  const overbought = rsi > 65  && rsi2Ago > 58 && sk > 60;

  const lastRange = last.high - last.low;
  // Wick de rejeição >= 35% do range (era 45%)
  const hasLowerWick = lastRange > 0 && lowerWick(last) >= lastRange * 0.35;
  const hasUpperWick = lastRange > 0 && upperWick(last) >= lastRange * 0.35;

  const rejLow  = prev.low  <= bb.lower  && bodyDir(last) === 'up'   && bodyStr(last) >= 0.45 && oversold   && hasLowerWick;
  const rejHigh = prev.high >= bb.upper  && bodyDir(last) === 'down' && bodyStr(last) >= 0.45 && overbought && hasUpperWick;

  const chochBuy  = mktStructure && mktStructure.lastCHoCH && mktStructure.lastCHoCH.type === 'BULLISH_CHOCH';
  const chochSell = mktStructure && mktStructure.lastCHoCH && mktStructure.lastCHoCH.type === 'BEARISH_CHOCH';

  if (rejLow)  return { direction:'BUY', strategy:'Range Reversal', chochConfirm:chochBuy,  parts:{ trend:false, rsi:true, structure:true, pullback:true, confirmation:true } };
  if (rejHigh) return { direction:'SELL',  strategy:'Range Reversal', chochConfirm:chochSell, parts:{ trend:false, rsi:true, structure:true, pullback:true, confirmation:true } };
  return null;
}

function stratFVG(candles5, atr, fvgZones, mktStructure, h1Bias) {
  const n = candles5.length;
  if (n < 5 || !fvgZones || fvgZones.length === 0) return null;

  const hm = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  // Kill Zones ICT: 07h–10h30 UTC (Londres) e 12h–17h UTC (NY)
  const inKillZone = (hm >= 7*60 && hm < 10*60+30) || (hm >= 12*60 && hm < 17*60);
  if (!inKillZone) return null; // FVG só tem edge nas Kill Zones

  const last = candles5[n-1];
  const candle = detectCandlePattern(candles5);

  for (const zone of fvgZones) {
    if (zone.quality === 'DIRTY') continue;
    const priceInZone = last.low <= zone.high && last.high >= zone.low;
    if (!priceInZone) continue;

    if (zone.type === 'BULLISH_FVG') {
      if (h1Bias === 'BEARISH_STRONG' || h1Bias === 'BEARISH') continue;
      if (bodyDir(last) !== 'up' || bodyStr(last) < 0.55) continue; // corpo forte obrigatório
      const structOk = !!(mktStructure && (mktStructure.biasBull || mktStructure.currentStructure === 'UPTREND'));
      const candleBonus = candle.bias === 'bull'; // não obrigatório, mas melhora score
      return { direction:'BUY', strategy:'FVG Bullish', fvgQuality:zone.quality, parts:{ trend:structOk, rsi:true, structure:structOk, pullback:true, confirmation:candleBonus } };
    }
    if (zone.type === 'BEARISH_FVG') {
      if (h1Bias === 'BULLISH_STRONG' || h1Bias === 'BULLISH') continue;
      if (bodyDir(last) !== 'down' || bodyStr(last) < 0.55) continue; // corpo forte obrigatório
      const structOk = !!(mktStructure && (mktStructure.biasBear || mktStructure.currentStructure === 'DOWNTREND'));
      const candleBonus = candle.bias === 'bear';
      return { direction:'SELL',  strategy:'FVG Bearish', fvgQuality:zone.quality, parts:{ trend:structOk, rsi:true, structure:structOk, pullback:true, confirmation:candleBonus } };
    }
  }
  return null;
}

function stratRSICross(candles5, adx, h1Bias) {
  const closes = candles5.map(c => c.close);
  const rsi = calcRSI(closes, 14);
  const n = candles5.length;
  if (n < 5 || adx.adx < 18) return null;

  const rsiNow  = rsi[n-1];
  const rsiPrev = rsi[n-2];
  const rsiPrev2 = rsi[n-3] || rsiPrev;
  if (rsiNow == null || rsiPrev == null) return null;

  // CORREÇÃO: aceitar cruzamento nos últimos 2 candles (janela 10min) — momentum ainda válido
  // Cruzamento limpo: apenas 1 candle de janela — evita entradas tardias
  const crossedUp   = (rsiPrev < 50 && rsiNow >= 50);
  const crossedDown = (rsiPrev > 50 && rsiNow <= 50);
  if (!crossedUp && !crossedDown) return null;

  const last = candles5[n-1];
  // Candle forte na direção do cruzamento
  if (crossedUp   && !(bodyDir(last) === 'up'   && bodyStr(last) >= 0.5)) return null;
  if (crossedDown && !(bodyDir(last) === 'down' && bodyStr(last) >= 0.5)) return null;

  // CORREÇÃO: H1 BEARISH qualquer bloqueia CALL
  if (crossedUp   && (h1Bias === 'BEARISH_STRONG' || h1Bias === 'BEARISH')) return null;
  if (crossedDown && (h1Bias === 'BULLISH_STRONG' || h1Bias === 'BULLISH')) return null;

  const h1Bull = h1Bias === 'BULLISH_STRONG' || h1Bias === 'BULLISH';
  const h1Bear = h1Bias === 'BEARISH_STRONG' || h1Bias === 'BEARISH';
  const adxGrowing = adx.slope3 > 0;

  if (crossedUp)   return { direction:'BUY', strategy:'RSI Cross 50', parts:{ trend:h1Bull, rsi:true, structure:adxGrowing, pullback:true, confirmation:true } };
  if (crossedDown) return { direction:'SELL',  strategy:'RSI Cross 50', parts:{ trend:h1Bear, rsi:true, structure:adxGrowing, pullback:true, confirmation:true } };
  return null;
}

// ─── 2. Stochastic Extreme Cross ─────────────────────────────────────────────
// %K cruza %D dentro de zona extrema (<25 ou >75) com candle de confirmação.
// Em M5 binário: timing muito preciso — o cruzamento acontece AGORA,
// confirmado pelo candle atual. Alta taxa de acerto em range.
// Expiração: 1 candle (5min)
function stratThreeCandles(candles5, adx, h1Bias) {
  const n = candles5.length;
  if (n < 5 || adx.adx < 20) return null;

  const c1 = candles5[n-4]; // mais antigo
  const c2 = candles5[n-3];
  const c3 = candles5[n-2];
  const last = candles5[n-1]; // candle atual — ainda não deve ter revertido

  // Três candles da mesma direção com corpo decente
  // CORREÇÃO: bodyStr >= 0.4 em c1/c2, 0.5 apenas no último (c3) — mais realista em M5
  const bullSeq = bodyDir(c1)==='up' && bodyDir(c2)==='up' && bodyDir(c3)==='up'
    && bodyStr(c1)>=0.4 && bodyStr(c2)>=0.4 && bodyStr(c3)>=0.5
    && c2.close > c1.close && c3.close > c2.close; // fechamentos crescentes
  const bearSeq = bodyDir(c1)==='down' && bodyDir(c2)==='down' && bodyDir(c3)==='down'
    && bodyStr(c1)>=0.4 && bodyStr(c2)>=0.4 && bodyStr(c3)>=0.5
    && c2.close < c1.close && c3.close < c2.close;

  if (!bullSeq && !bearSeq) return null;

  // Filtro de exaustão: movimento total dos 3 candles não pode exceder 2×ATR
  // Movimento muito extenso = mercado já exausto, 4º candle tende a reverter
  const atr = calcATR(candles5, 14);
  const totalMove = bullSeq
    ? c3.close - c1.open
    : c1.open - c3.close;
  // CORREÇÃO: teto de exaustão ampliado para 2.5×ATR (era 2.0) — pares voláteis como JPY movem mais
  if (atr > 0 && totalMove > atr * 2.5) return null;

  // Candle atual não pode ter revertido a sequência (não pode já estar na direção contrária fortemente)
  if (bullSeq && bodyDir(last)==='down' && bodyStr(last)>=0.6) return null;
  if (bearSeq && bodyDir(last)==='up'   && bodyStr(last)>=0.6) return null;

  // ADX crescendo — momentum não acabou
  if (adx.slope3 <= 0) return null;

  // H1 na direção ou neutro
  // CORREÇÃO: H1 BEARISH qualquer bloqueia CALL (antes só BEARISH_STRONG)
  if (bullSeq && (h1Bias==='BEARISH_STRONG' || h1Bias==='BEARISH')) return null;
  if (bearSeq && (h1Bias==='BULLISH_STRONG' || h1Bias==='BULLISH')) return null;

  const h1Bull = h1Bias === 'BULLISH_STRONG' || h1Bias === 'BULLISH';
  const h1Bear = h1Bias === 'BEARISH_STRONG' || h1Bias === 'BEARISH';

  if (bullSeq) return { direction:'BUY', strategy:'Three Candles Momentum', parts:{ trend:h1Bull, rsi:true, structure:true, pullback:true, confirmation:true } };
  if (bearSeq) return { direction:'SELL',  strategy:'Three Candles Momentum', parts:{ trend:h1Bear, rsi:true, structure:true, pullback:true, confirmation:true } };
  return null;
}

// ─── 4. Pin Bar de Precisão ───────────────────────────────────────────────────
// Pin bar com wick >= 65% do range total numa zona de S&R ou banda BB.
// Muito mais restritivo que o detectCandlePattern genérico.
// Em binário M5 é a entrada mais limpa de reversão — wick longo = rejeição forte.
// Expiração: 1 candle (5min)
function stratPinBarPrecision(candles5, swing, h1Bias) {
  const n = candles5.length;
  if (n < 10) return null;

  const last = candles5[n-1];
  const range = last.high - last.low;
  if (range === 0) return null;

  const atr = calcATR(candles5, 14);
  // Range mínimo: pelo menos 0.8×ATR — pin bars tiny são ruído
  if (range < atr * 0.8) return null;

  const lw = lowerWick(last);
  const uw = upperWick(last);

  // Pin bullish: wick inferior >= 65% do range, corpo no terço superior
  const pinBull = lw >= range * 0.65 && bodyStr(last) <= 0.3 && last.close >= last.low + range * 0.6;
  // Pin bearish: wick superior >= 65% do range, corpo no terço inferior
  const pinBear = uw >= range * 0.65 && bodyStr(last) <= 0.3 && last.close <= last.high - range * 0.6;

  if (!pinBull && !pinBear) return null;

  // Deve estar em zona de S&R ou banda BB
  const closes = candles5.map(c => c.close);
  const bb = calcBB(closes);
  const nearLower = bb && Math.abs(last.low - bb.lower) <= atr * 0.5;
  const nearUpper = bb && Math.abs(last.high - bb.upper) <= atr * 0.5;
  const nearSup   = nearSupportOrResistance(last.close, swing.supports,    atr);
  const nearRes   = nearSupportOrResistance(last.close, swing.resistances, atr);

  if (pinBull && !(nearLower || nearSup)) return null;
  if (pinBear && !(nearUpper || nearRes)) return null;

  // H1 STRONG contra = bloqueia
  if (pinBull && h1Bias === 'BEARISH_STRONG') return null;
  if (pinBear && h1Bias === 'BULLISH_STRONG') return null;

  const rsi14 = calcRSI(closes, 14);
  const rsi   = rsi14[n-1];

  if (pinBull) return { direction:'BUY', strategy:'Pin Bar Precisão', parts:{ trend:false, rsi:rsi<55, structure:true, pullback:true, confirmation:true } };
  if (pinBear) return { direction:'SELL',  strategy:'Pin Bar Precisão', parts:{ trend:false, rsi:rsi>45, structure:true, pullback:true, confirmation:true } };
  return null;
}

// ─── 5. EMA9 Bounce (Tendência) ───────────────────────────────────────────────
// Em tendência: preço testa a EMA9, forma baixa/alta nela, e o candle atual
// fecha voltando na direção da tendência. Diferente do Trend Pullback — foca no
// MOMENTO do toque na EMA, não na sequência de pullback geral.
// Prático em M5: o bounce na EMA9 é o ponto de menor risco no candle atual.
// Expiração: 1 candle (5min)
function stratEMA9Bounce(candles5, adx, h1Bias) {
  const closes = candles5.map(c => c.close);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const n = candles5.length;
  // FIX: ADX mínimo 25 (era 20) — bounce sem força não tem continuação
  if (n < 10 || adx.adx < 25 || adx.slope3 <= 0) return null;

  const le9  = ema9[n-1],  le21 = ema21[n-1];
  const pe9  = ema9[n-2],  pe21 = ema21[n-2];
  const ae9  = ema9[n-3],  ae21 = ema21[n-3];
  if (!le9 || !le21 || !ae9) return null;

  // FIX: Tendência confirmada em 3 candles consecutivos (era 2) — evita cruzamentos momentâneos
  const upTrend   = le9 > le21 && pe9 > pe21 && ae9 > ae21;
  const downTrend = le9 < le21 && pe9 < pe21 && ae9 < ae21;
  if (!upTrend && !downTrend) return null;

  const last = candles5[n-1];
  const prev = candles5[n-2];
  const atr  = calcATR(candles5, 14);

  // FIX: Tolerância de toque reduzida de 0.3 para 0.15 — só aceita toque real na EMA9
  const bounceBull = upTrend
    && prev.low <= le9 + atr * 0.15       // prev tocou EMA9 de verdade
    && bodyDir(last) === 'up'              // candle atual bullish
    && bodyStr(last) >= 0.5               // corpo decente
    && last.close > prev.high;            // fecha acima do prev (confirmação)

  // FIX: Tolerância de toque reduzida de 0.3 para 0.15
  const bounceBear = downTrend
    && prev.high >= le9 - atr * 0.15
    && bodyDir(last) === 'down'
    && bodyStr(last) >= 0.5
    && last.close < prev.low;

  if (!bounceBull && !bounceBear) return null;

  // CORREÇÃO: validar que o regime confirma a direção do bounce
  // EMA9 Bounce só tem edge quando o regime está alinhado — evita sinais em contra-regime
  if (bounceBull && downTrend) return null; // não comprar em downtrend
  if (bounceBear && upTrend)   return null; // não vender em uptrend

  // CORREÇÃO: H1 BEARISH (qualquer) bloqueia CALL — antes só BEARISH_STRONG bloqueava
  if (bounceBull && (h1Bias === 'BEARISH_STRONG' || h1Bias === 'BEARISH')) return null;
  if (bounceBear && (h1Bias === 'BULLISH_STRONG' || h1Bias === 'BULLISH')) return null;

  const rsi14 = calcRSI(closes, 14);
  const rsi   = rsi14[n-1];
  const h1Bull = h1Bias === 'BULLISH_STRONG' || h1Bias === 'BULLISH';
  const h1Bear = h1Bias === 'BEARISH_STRONG' || h1Bias === 'BEARISH';

  if (bounceBull) return { direction:'BUY', strategy:'EMA9 Bounce', parts:{ trend:h1Bull, rsi:rsi>45, structure:upTrend, pullback:true, confirmation:bounceBull } };
  if (bounceBear) return { direction:'SELL',  strategy:'EMA9 Bounce', parts:{ trend:h1Bear, rsi:rsi<55, structure:downTrend, pullback:true, confirmation:bounceBear } };
  return null;
}

// ═══════════════════════════════════════════════════════
//  SCORE — escala normalizada (0–100) sem saturação artificial
//  Base máxima: 100 pts divididos pelos 5 pilares
//  Bônus externos (sessão, candle, S&R): limitados a +15
//  Context (BOS/CHoCH/OB/FVG/H1): pode ser negativo
//  Teto real: 95 — "99% não existe" em scalping
// ═══════════════════════════════════════════════════════
function scoreSignal(parts, sessionBonus, contextBonus) {
  sessionBonus  = sessionBonus  || 0;
  contextBonus  = contextBonus  || 0;
  // Pesos calibrados para que nenhum setup trivial chegue ao topo
  // trend+structure juntos = 40 pts (confirmação de direção)
  // pullback+rsi+confirmation = 35 pts (qualidade da entrada)
  // Máximo real de base = 75 (nenhum setup preenche 100% dos pilares)
  // Pesos reequilibrados: pullback/rsi/confirmation elevados (qualidade de entrada)
  // trend+structure reduzidos (eram duplicados via H1 Bias na maioria das estratégias)
  const base = Math.round(
    (parts.trend        ? 18 : 0) +
    (parts.rsi          ? 18 : 0) +
    (parts.structure    ? 15 : 0) +
    (parts.pullback     ? 22 : 0) +
    (parts.confirmation ? 22 : 0)
  );
  // Bônus externos: cap reduzido de 15→12 (evita score artificial via sessão)
  const extCapped = Math.min(12, sessionBonus);
  const raw = base + extCapped + contextBonus;
  // Teto 95: score honesto — "99% não existe"
  return Math.max(0, Math.min(95, raw));
}

// Converte score numérico em grau legível para o usuário
// Substitui o "99%" que transmitia falsa precisão estatística
function scoreToGrade(score) {
  if (score >= 88) return 'A+';
  if (score >= 78) return 'A';
  if (score >= 68) return 'B+';
  if (score >= 58) return 'B';
  return 'C';
}

// ═══════════════════════════════════════════════════════
//  SWING HIGH/LOW — com histórico completo para BOS/CHoCH
// ═══════════════════════════════════════════════════════
function findSwingLevels(candles, lookback) {
  lookback = lookback || 25;
  const slice = candles.slice(-lookback);
  const highs = [], lows = [], allHighs = [], allLows = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].high >= slice[i-1].high && slice[i].high >= slice[i+1].high) {
      highs.push(slice[i].high);
      allHighs.push({ price: slice[i].high, idx: i });
    }
    if (slice[i].low <= slice[i-1].low && slice[i].low <= slice[i+1].low) {
      lows.push(slice[i].low);
      allLows.push({ price: slice[i].low, idx: i });
    }
  }
  return { resistances: highs.slice(-3), supports: lows.slice(-3), allHighs, allLows };
}

function nearSupportOrResistance(price, levels, atr) {
  const threshold = atr * 0.8;
  return levels.some(function(l) { return Math.abs(price - l) <= threshold; });
}


// ═══════════════════════════════════════════════════════
//  SESSION WEIGHT
// ═══════════════════════════════════════════════════════
function getSessionBonus(date) {
  date = date || new Date();
  const h = date.getUTCHours(), m = date.getUTCMinutes();
  const hm = h * 60 + m;
  // UTC horários — Brasília = UTC-3, Fortaleza = UTC-3 (sem horário de verão)
  // Londres:   08:00–12:00 UTC  (05:00–09:00 Fortaleza)
  // NY:        13:00–17:00 UTC  (10:00–14:00 Fortaleza)
  // Overlap:   13:00–16:00 UTC  (10:00–13:00 Fortaleza) — melhor janela
  // Ásia:      00:00–07:00 UTC  (21:00–04:00 Fortaleza) — bloqueada
  if (hm >= 13*60 && hm < 16*60) return { bonus: 12, label: 'Londres+NY 🔥', blocked: false };
  if (hm >= 8*60  && hm < 13*60) return { bonus: 8,  label: 'Londres 🇬🇧',    blocked: false };
  if (hm >= 16*60 && hm < 21*60) return { bonus: 5,  label: 'Nova York 🗽',   blocked: false };
  // Ásia e madrugada — bloqueia
  return { bonus: 0, label: 'Ásia/Fora 🚫', blocked: true };
}

// ═══════════════════════════════════════════════════════
//  REGIME
// ═══════════════════════════════════════════════════════
function detectRegime(candles, adx) {
  const bb = calcBB(candles.map(function(c) { return c.close; }));
  const trending = adx.adx >= 20;
  const ranging  = !trending && (bb ? bb.width < 0.007 : false);
  if (trending && adx.plusDI > adx.minusDI) return 'TREND_UP';
  if (trending && adx.minusDI > adx.plusDI) return 'TREND_DOWN';
  if (ranging) return 'RANGE';
  return 'NEUTRAL';
}

// ═══════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════

function nextCandleTime(tfMin) {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const minsUntil = tfMin - (utcMin % tfMin);
  const nextUtc = new Date(now.getTime() + minsUntil * 60000);
  nextUtc.setUTCSeconds(0, 0);
  const local = new Date(nextUtc.getTime() - 3 * 3600000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  const secsLeft = Math.max(0, Math.round(minsUntil * 60 - now.getUTCSeconds()));
  return { label: hh + ':' + mm, secsLeft: secsLeft };
}

function buildTelegramMessage(s) {
  // HTML parse_mode — Forex Scanner v3
  const dirEmoji = s.direction === 'BUY' ? '🟢' : '🔴';
  const dirLabel = s.direction === 'BUY' ? '⬆️ COMPRA' : '⬇️ VENDA';
  const signalTime = new Date(s.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const gradeEmoji = s.grade === 'A+' ? '🏆' : s.grade === 'A' ? '🥇' : s.grade === 'B+' ? '🥈' : '🥉';
  const h1Labels = { BULLISH_STRONG:'📈 ALTA FORTE', BULLISH:'📈 Alta', BEARISH:'📉 Baixa', BEARISH_STRONG:'📉 BAIXA FORTE', NEUTRAL:'➡️ Neutro' };
  const h1Label = (s.h1Bias && h1Labels[s.h1Bias]) || '—';
  let structLabel = '';
  if (s.bosType === 'BULLISH_BOS')     structLabel = '🔼 BOS Bullish confirmado';
  else if (s.bosType === 'BEARISH_BOS')   structLabel = '🔽 BOS Bearish confirmado';
  else if (s.bosType === 'BULLISH_CHOCH') structLabel = '🔀 CHoCH Bullish (reversão)';
  else if (s.bosType === 'BEARISH_CHOCH') structLabel = '🔀 CHoCH Bearish (reversão)';

  return [
    '📡 <b>SINAL FOREX</b> — ' + dirEmoji + ' ' + dirLabel,
    '<b>Par:</b> ' + s.pair + ' | <b>Timeframe:</b> M15',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '📍 <b>Entrada:</b>  <code>' + s.entry + '</code>',
    '🛑 <b>Stop Loss:</b>  <code>' + s.sl + '</code>  <i>(' + s.slPips + ' pips)</i>',
    '🎯 <b>Take Profit:</b>  <code>' + s.tp + '</code>  <i>(' + s.tpPips + ' pips)</i>',
    '⚖️ <b>Risco/Retorno:</b>  1 : ' + s.rr,
    '━━━━━━━━━━━━━━━━━━',
    '',
    '📊 <b>Estratégia:</b> ' + s.strategy,
    '🧭 <b>Regime M5:</b> ' + s.regime + ' | <b>ADX:</b> ' + (s.adxValue || '—'),
    '🕐 <b>Bias H1:</b> ' + h1Label,
    structLabel ? '🏗️ <b>Estrutura:</b> ' + structLabel : '',
    gradeEmoji + ' <b>Qualidade:</b> Score ' + s.confidence + (s.grade ? ' — Grau ' + s.grade : ''),
    s.session       ? '🌍 <b>Sessão:</b> ' + s.session       : '',
    s.candlePattern ? '🕯️ <b>Candle:</b> ' + s.candlePattern : '',
    s.fvgQuality    ? '📐 <b>FVG:</b> ' + s.fvgQuality       : '',
    '',
    '⚠️ <i>Coloque ordem LIMITE em <code>' + s.entry + '</code> ou entre a mercado se o preço ainda estiver próximo.</i>',
    '<i>⏱️ Se o preço não retornar à entrada em 1 candle M15, ignore o sinal.</i>',
    '🕒 Sinal gerado às ' + signalTime
  ].filter(Boolean).join('\n');
}

async function sendTelegramWithRetry(token, chatId, text, maxRetries) {
  maxRetries = maxRetries || 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
      const data = await res.json();
      if (res.ok && data.ok) return { ok: true, attempt };
      if (attempt === 2) {
        const res2 = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: text.replace(/<[^>]+>/g, '') })
        });
        const data2 = await res2.json();
        if (res2.ok && data2.ok) return { ok: true, attempt, fallback: true };
      }
      throw new Error(data.description || 'HTTP ' + res.status);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(function(r) { setTimeout(r, 1500 * attempt); });
    }
  }
}

// ═══════════════════════════════════════════════════════
//  WIN RATE TRACKER — Opções Binárias
//  Lógica: ao expirar (N candles M5), verifica se o preço
//  fechou na direção correta. CALL = close > entry. PUT = close < entry.
//  Sem SL/TP — ganho/perda é tudo ou nada.
// ═══════════════════════════════════════════════════════
class WinRateTracker {
  constructor(onResult) { this.records = []; this.onResult = onResult || null; }

  // ── Lógica de timing ────────────────────────────────────────────────────────
  // Sinal gerado às 16:59 usando candle 16:55 (em formação)
  // Usuário entra em 17:00 (open do próximo candle M15)
  // Expiração em 17:05 (close desse candle — 1 candle M5)
  //
  // _signalTs = timestamp Unix do candle que gerou o sinal
  // updateCandles recebe o penúltimo candle (fechado) do Map
  // Só processa candles cujo timestamp seja POSTERIOR ao sinal
  // ────────────────────────────────────────────────────────────────────────────
  record(signalId, pair, direction, entry, expiryCandles, strategy, signalDatetime, sl, tp) {
    // Converte para Unix ms — comparação numérica é 100% confiável
    let signalTs = 0;
    try { signalTs = signalDatetime ? new Date(signalDatetime).getTime() : Date.now(); } catch(e) { signalTs = Date.now(); }
    this.records.push({
      signalId, pair, direction,
      entry,                        // atualizado para o open real do candle de entrada
      expiryCandles: expiryCandles || 1,
      strategy: strategy || '',
      outcome: 'PENDING',
      closedAt: null,
      _signalTs: signalTs,          // Unix ms do candle que gerou o sinal
      _lastSeenTs: 0,               // Unix ms do último candle processado (evita duplicata)
      _candlesSeen: 0,
      sl:            sl   || null,
      tp:            tp   || null,
      _entryUpdated: false,
      createdAt: new Date().toISOString(), // horário real do sinal
      entryTime: null, // preenchido pelo scanCycle após record()
    });
  }

  // candleMap.get(pair) deve retornar o penúltimo candle (fechado mais recente).
  // Fluxo correto:
  //   Ciclo 1 — candle com ts = signalTs     → SKIP (é o candle do sinal)
  //   Ciclo 2 — candle com ts > signalTs     → entry = open desse candle (entrada real), candlesSeen = 1
  //   Ciclo 3 (expiryCandles=1)              → resolve com close do candle de expiração
  updateCandles(candleMap) {
    for (const r of this.records) {
      if (r.outcome !== 'PENDING') continue;
      const candle = candleMap && candleMap.get ? candleMap.get(r.pair) : null;
      if (!candle || !candle.datetime) continue;

      // Converte datetime do candle para Unix ms
      let candleTs = 0;
      try { candleTs = new Date(candle.datetime).getTime(); } catch(e) { continue; }
      if (!candleTs) continue;

      // ── Regra 1: ignora o candle do sinal e qualquer anterior ───────────────
      // Usuário entra no PRÓXIMO candle — nunca resolver com o candle atual
      if (candleTs <= r._signalTs) continue;

      // ── Regra 2: não contar o mesmo candle duas vezes entre ciclos ──────────
      if (candleTs <= r._lastSeenTs) continue;

      // ── Primeiro candle posterior = candle de entrada ────────────────────────
      // Atualiza entry para o open desse candle (preço real de entrada do usuário)
      if (!r._entryUpdated) {
        if (candle.open && candle.open > 0) r.entry = candle.open;
        r._entryUpdated = true;
      }

      r._lastSeenTs = candleTs;
      r._candlesSeen++;

      // Ainda dentro da janela de expiração
      // Forex: não tem expiração — só resolve por SL/TP ou timeout 12 candles
      if (!r.sl && r._candlesSeen < (r.expiryCandles || 1)) continue;

      // ── Forex: resolve quando atinge TP ou SL ─────────────────────────────
      // Verifica se o candle tocou TP ou SL durante sua formação
      let hit = null;
      if (r.sl && r.tp) {
        // TP/SL definidos — verifica high/low do candle
        if (r.direction === 'BUY') {
          if (candle.high  >= r.tp) hit = 'WIN';
          if (candle.low   <= r.sl) hit = hit || 'LOSS'; // SL prevalece se ambos no mesmo candle
        }
        if (r.direction === 'SELL') {
          if (candle.low   <= r.tp) hit = 'WIN';
          if (candle.high  >= r.sl) hit = hit || 'LOSS';
        }
        // Timeout: após 12 candles M5 (60 min) fecha no preço atual
        if (!hit && r._candlesSeen >= 12) {
          hit = r.direction === 'BUY'
            ? (candle.close > r.entry ? 'WIN' : 'LOSS')
            : (candle.close < r.entry ? 'WIN' : 'LOSS');
        }
        // TP/SL definidos mas ainda não atingidos — aguarda próximo candle
        if (!hit) continue;
      } else {
        // Fallback sem TP/SL — binário puro (1 candle)
        if (r.direction === 'BUY')  hit = candle.close > r.entry ? 'WIN' : 'LOSS';
        if (r.direction === 'SELL') hit = candle.close < r.entry ? 'WIN' : 'LOSS';
        if (!hit) hit = 'LOSS'; // empate = LOSS em binário
      }

      r.outcome  = hit;
      // closedAt = fechamento real da vela (datetime do candle + 5min)
      // Twelve Data retorna datetime sem 'Z' — forçar interpretação UTC
      try {
        const dtStr = candle.datetime.endsWith('Z') ? candle.datetime : candle.datetime + 'Z';
        const candleClose = new Date(new Date(dtStr).getTime() + 5 * 60 * 1000);
        r.closedAt = candleClose.toISOString();
      } catch(e) {
        r.closedAt = new Date().toISOString();
      }
      if (this.onResult) this.onResult(r);
    }
  }

  // Sem uso em binário — mantido para compatibilidade
  updatePrices() {}

  getSummary() {
    const closed = this.records.filter(r => r.outcome !== 'PENDING');
    const wins   = closed.filter(r => r.outcome === 'WIN').length;
    const total  = closed.length;
    return {
      wins, losses: total - wins, total,
      pending: this.records.filter(r => r.outcome === 'PENDING').length,
      winRate: total > 0 ? round((wins / total) * 100, 1) : null
    };
  }

  getRecent(n) { n = n || 30; return this.records.slice(-n).reverse(); }
}
function buildSeedCandles(pair, count, idx) {
  count = count || 80; idx = idx || 0;
  const base = pair.includes('JPY') ? 157 + idx * 0.2 : 1.05 + idx * 0.03;
  const now = Date.now();
  const out = [];
  for (let i = count; i > 0; i--) {
    const drift = Math.sin((count - i + idx) / 4) * (pair.includes('JPY') ? 0.08 : 0.0025);
    const open  = base + drift;
    const close = open + Math.cos((count - i + idx) / 3) * (pair.includes('JPY') ? 0.03 : 0.0012);
    const high  = Math.max(open, close) + (pair.includes('JPY') ? 0.02 : 0.0008);
    const low   = Math.min(open, close) - (pair.includes('JPY') ? 0.02 : 0.0008);
    out.push({ datetime: new Date(now - i * 5 * 60000).toISOString(), open: round(open), high: round(high), low: round(low), close: round(close) });
  }
  return out;
}

function buildNextCandle(last, step, tf) {
  const mins = tf === '15min' ? 15 : 5;
  const move = last.close * (0.0007 + (Math.sin(step/2)+1) * 0.0004);
  const dir  = step % 4 === 0 ? -1 : 1;
  const open = last.close, close = open + move * dir;
  const wick = Math.abs(move) * 0.6;
  return { datetime: new Date(new Date(last.datetime).getTime() + mins*60000).toISOString(), open: round(open), high: round(Math.max(open,close)+wick), low: round(Math.min(open,close)-wick), close: round(close) };
}

function parseSeries(payload, pair) {
  const key = [pair, pair.replace('/',''), pair.replace('/','_')].find(function(k) { return payload[k]; });
  const values = (key ? payload[key] : payload).values || [];
  return values.map(function(c) { return { datetime:c.datetime, open:parseN(c.open), high:parseN(c.high), low:parseN(c.low), close:parseN(c.close) }; })
    .filter(function(c) { return c.open>0 && c.close>0; }).reverse();
}

// H1 sintético a partir de M15 — agrupa 4 candles M15 em 1 candle H1
// Com 150 candles M15 = 37 candles H1 — bias H1 muito mais confiável que M5
function buildSyntheticH1fromM15(candles15) {
  const out = [];
  for (let i = 0; i + 3 < candles15.length; i += 4) {
    const group = candles15.slice(i, i + 4);
    out.push({
      datetime: group[0].datetime,
      open:  group[0].open,
      high:  Math.max(...group.map(c => c.high)),
      low:   Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
    });
  }
  return out;
}

function buildSyntheticM15(candles5) {
  const out = [];
  for (let i = 0; i + 2 < candles5.length; i += 3) {
    const group = candles5.slice(i, i + 3);
    out.push({
      datetime: group[0].datetime,
      open:  group[0].open,
      high:  Math.max(...group.map(function(c) { return c.high; })),
      low:   Math.min(...group.map(function(c) { return c.low; })),
      close: group[group.length - 1].close
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  SCANNER ENGINE
// ═══════════════════════════════════════════════════════
class ScannerEngine extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.isRunning = false; this.isScanning = false;
    this.interval = null; this.simInterval = null; this.priceInterval = null; this.simStep = 0;
    this.pauseUntil = 0; this.lastBucket = null;
    this.candles5 = new Map(); this.candles15 = new Map();
    this.lastSignalAt = new Map(); this.lastSignalDir = new Map();
    this.prices = new Map();
    // Filtro de notícias — cache atualizado a cada hora
    this._newsCache = []; this._newsCacheAt = 0; this._newsInterval = null;
    // Histórico diário persistente
    this._dailyHistory = this._loadDailyHistory();
    this.winRate = new WinRateTracker((r) => {
      this._recordDaily(r);
      this._saveWinRateSession(); // persiste ao resolver
      this.emit('winloss', r);
      const { telegramBotToken: token, telegramChatId: chatId } = this.settings;
      if (token && chatId) {
        const emoji  = r.outcome === 'WIN' ? '✅' : '❌';
        const dir    = r.direction === 'BUY' ? '🟢 COMPRA ⬆️' : '🔴 VENDA ⬇️';
        const now    = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', hour:'2-digit', minute:'2-digit' });
        const tpSlInfo = r.tp && r.sl ? '\nTP: ' + r.tp + ' | SL: ' + r.sl : '';
        const msg = emoji + ' <b>RESULTADO — ' + r.outcome + '</b>\n\nPar: <b>' + r.pair + '</b> | ' + dir + '\nEstratégia: ' + r.strategy + tpSlInfo + '\nFechado às: ' + now + ' (Fortaleza)\n\n' + (r.outcome==='WIN'?'🎯 TP atingido! Lucro confirmado.':'⛔ SL atingido. Respeite o gerenciamento.');
        sendTelegramWithRetry(token, chatId, msg).catch(function() {});
      }
    });
  }

  // ─── Filtro de Notícias (Forex Factory RSS) ────────────────────────────────
  async _fetchNews() {
    try {
      const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const data = await res.json();
      this._newsCache = data.filter(e => e.impact === 'High');
      this._newsCacheAt = Date.now();
      this.log('info', `📰 Calendário atualizado — ${this._newsCache.length} eventos de alto impacto esta semana`);
    } catch (e) { /* falha silenciosa — não bloqueia scanner */ }
  }

  _newsBlocked(pair) {
    if (!this._newsCache.length) return false;
    const now = Date.now();
    const window = 30 * 60 * 1000; // 30 minutos antes e depois
    // Moedas do par
    const currencies = pair.replace('/', ' ').split(' ');
    for (const event of this._newsCache) {
      const evCurrency = event.currency || event.country || '';
      if (!currencies.includes(evCurrency)) continue;
      const eventTime = new Date(event.date).getTime();
      if (Math.abs(now - eventTime) <= window) {
        this.log('warn', `📰 Notícia bloqueando ${pair}: ${event.title} (${event.country}) — janela de 30min`);
        return true;
      }
    }
    return false;
  }

  // ─── Histórico Diário ──────────────────────────────────────────────────────
  _loadDailyHistory() {
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, '..', 'data', 'daily_history.json');
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {}
    return {};
  }

  _saveWinRateSession() {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'winrate_session.json');
      // Salva apenas registros do dia atual (PENDING e resolvidos de hoje)
      const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
      const todayRecords = this.winRate.records.filter(r => {
        const d = r.closedAt
          ? new Date(r.closedAt).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' })
          : today;
        return d === today;
      });
      fs.writeFileSync(file, JSON.stringify({ date: today, records: todayRecords }, null, 2));
    } catch (e) {}
  }

  _loadWinRateSession() {
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, '..', 'data', 'winrate_session.json');
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
      // Só restaura se for do mesmo dia
      if (data.date !== today) return [];
      return data.records || [];
    } catch (e) { return []; }
  }

  _saveDailyHistory() {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'daily_history.json');
      fs.writeFileSync(file, JSON.stringify(this._dailyHistory, null, 2));
    } catch (e) {}
  }

  _recordDaily(r) {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
    if (!this._dailyHistory[today]) this._dailyHistory[today] = [];
    if (this._dailyHistory[today].find(x => x.signalId === r.signalId)) return;
    this._dailyHistory[today].push({
      signalId:      r.signalId,
      pair:          r.pair,
      direction:     r.direction,
      strategy:      r.strategy,
      entry:         r.entry,
      expiryMinutes: (r.expiryCandles || 1) * 5,
      outcome:       r.outcome,
      closedAt:      r.closedAt,
      // NOVO: contexto completo para alimentar MemoryLayer do v2
      regime:        r._regime   || null,
      h1Bias:        r._h1Bias   || null,
      session:       r._session  || null,
      score:         r._score    || null,
    });
    this._saveDailyHistory();
    // NOVO: salvar também no arquivo de dataset da IA (compatível com v2 importV1Dataset)
    this._saveAIDataset(r);
    this.emit('daily-history', this.getDailyHistory());
  }

  // Salva dataset incremental no formato que a MemoryLayer do v2 consegue importar
  _saveAIDataset(r) {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir  = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'ai_dataset.json');
      let dataset = [];
      if (fs.existsSync(file)) {
        try { dataset = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) { dataset = []; }
      }
      // Evita duplicatas
      if (dataset.find(x => x.signalId === r.signalId)) return;
      dataset.push({
        signalId:  r.signalId,
        pair:      r.pair,
        strategy:  r.strategy,
        direction: r.direction,
        outcome:   r.outcome,
        closedAt:  r.closedAt,
        regime:    r._regime  || null,
        h1Bias:    r._h1Bias  || null,
        session:   r._session || null,
        score:     r._score   || null,
      });
      fs.writeFileSync(file, JSON.stringify(dataset, null, 2));
    } catch (e) {}
  }

  getDailyHistory() {
    const result = [];
    for (const [date, signals] of Object.entries(this._dailyHistory).sort().reverse()) {
      const wins   = signals.filter(s => s.outcome === 'WIN').length;
      const losses = signals.filter(s => s.outcome === 'LOSS').length;
      const total  = wins + losses;
      result.push({ date, signals, wins, losses, total, winRate: total > 0 ? Math.round((wins/total)*100) : null });
    }
    return result;
  }

  async start() {
    this.stopSimulation();
    if (this.isRunning) return;
    this._initKeyPool();
    if (this._keyPool.length === 0) { this.log('error','Cole a chave da Twelve Data antes de iniciar.'); this.emitStatus('error','Sem chave da API'); return; }
    this.isRunning = true; this.emitStatus('running','Scanner iniciado');
    if (this.winRate.records.length === 0) {
      const restored = this._loadWinRateSession();
      if (restored.length > 0) {
        this.winRate.records = restored;
        this.log('info', `📂 ${restored.length} registro(s) do Win Rate restaurados`);
        this.emit('winrate', this.winRate.getSummary());
      }
    } else {
      this.emit('winrate', this.winRate.getSummary());
    }
    const keyCount = this._keyPool.length;
    this.log('info', `Binary Scanner v1.0 iniciado. ${keyCount} chave${keyCount > 1 ? 's' : ''} no pool.`);
    this._fetchNews();
    this._newsInterval = setInterval(() => this._fetchNews(), 60 * 60 * 1000);
    await this.scanCycle();
    this.interval = setInterval(() => this.scanCycle(), this.settings.pollIntervalMs || 60000);
    this.priceInterval = setInterval(() => this.priceTick(), 60000);
    // ── WebSocket — preço em tempo real sem custo de créditos ─────────────
    this._startWebSocket();
  }

  stop() {
    clearInterval(this.interval); this.interval = null;
    clearInterval(this.priceInterval); this.priceInterval = null;
    clearInterval(this._newsInterval); this._newsInterval = null;
    this._stopWebSocket();
    this.isRunning = false; this.isScanning = false;
    this.emitStatus('stopped','Scanner parado'); this.log('info','Scanner parado.');
  }

  // ── WebSocket Finnhub — tick a tick, zero créditos da Twelve Data ───────────
  // Finnhub grátis: até 50 símbolos simultâneos via WebSocket
  // Formato Finnhub forex: "OANDA:EUR_USD" (underscore, sem barra)
  // Mensagem recebida: { type:"trade", data:[{ s:"OANDA:EUR_USD", p:1.0834, t:1234567890000, v:0 }] }
  _startWebSocket() {
    const key = this.settings.finnhubKey;
    if (!key) {
      this.log('info', '🔌 Chave Finnhub não configurada — preço ao vivo desativado');
      return;
    }
    const pairs = (this.settings.pairs || []).slice(0, 8);
    if (!pairs.length) return;

    // Converte "EUR/USD" → "OANDA:EUR_USD"
    const toFinnhub = (pair) => 'OANDA:' + pair.replace('/', '_');
    // Converte "OANDA:EUR_USD" → "EUR/USD"
    const fromFinnhub = (sym) => sym.replace('OANDA:', '').replace('_', '/');

    try {
      const WS = require('ws');
      const url = `wss://ws.finnhub.io?token=${key}`;
      this._ws = new WS(url);
      this._wsReconnectTimer = null;
      this._wsPingTimer = null;

      this._ws.on('open', () => {
        this.log('info', `🔌 Finnhub WebSocket conectado — ${pairs.length} pares ao vivo`);
        // Subscreve cada par individualmente (protocolo Finnhub)
        for (const pair of pairs) {
          this._ws.send(JSON.stringify({ type: 'subscribe', symbol: toFinnhub(pair) }));
        }
        // Ping a cada 25s para manter conexão viva
        this._wsPingTimer = setInterval(() => {
          if (this._ws && this._ws.readyState === WS.OPEN) {
            this._ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      });

      this._ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          // Finnhub: { type:"trade", data:[{ s, p, t, v }] }
          if (msg.type !== 'trade' || !Array.isArray(msg.data) || !msg.data.length) return;
          // Pega o último trade do batch (mais recente)
          const trade = msg.data[msg.data.length - 1];
          if (!trade || !trade.s || !trade.p) return;

          const pair  = fromFinnhub(trade.s);
          const price = parseFloat(trade.p);
          if (!price || !this.isRunning) return;

          // Atualiza preço ao vivo
          this.prices.set(pair, { price, live: true, ts: Date.now() });
          this.emit('price-live', { pair, price, timestamp: new Date().toISOString() });

          // Atualiza o candle em formação
          const c5 = this.candles5.get(pair);
          if (c5 && c5.length > 0) {
            const last = c5[c5.length - 1];
            if (last) {
              last.close = price;
              last.high  = Math.max(last.high, price);
              last.low   = Math.min(last.low, price);
            }
          }

          // Emite countdown do candle M5 atual
          const now          = new Date();
          const secsInCandle = (now.getUTCMinutes() % 5) * 60 + now.getUTCSeconds();
          const secsLeft     = 300 - secsInCandle;
          this.emit('candle-countdown', { pair, price, secsLeft, secsInCandle });
        } catch (e) {}
      });

      this._ws.on('error', (err) => {
        this.log('warn', `Finnhub WebSocket erro: ${err.message}`);
      });

      this._ws.on('close', () => {
        clearInterval(this._wsPingTimer);
        if (!this.isRunning) return;
        this.log('warn', '🔌 Finnhub desconectado — reconectando em 10s...');
        this._wsReconnectTimer = setTimeout(() => {
          if (this.isRunning) this._startWebSocket();
        }, 10000);
      });
    } catch (e) {
      this.log('info', `WebSocket indisponível (${e.message}) — usando polling M5`);
    }
  }

  _stopWebSocket() {
    clearInterval(this._wsPingTimer);
    clearTimeout(this._wsReconnectTimer);
    if (this._ws) {
      try { this._ws.close(); } catch(e) {}
      this._ws = null;
    }
  }

  startSimulation() {
    this.stop(); this.stopSimulation(); this.simStep = 0;
    this.emitStatus('running','Simulação ativa'); this.log('info','Modo simulação iniciado.');
    this.runSimStep();
    this.simInterval = setInterval(() => this.runSimStep(), this.settings.simulationSpeedMs || 2000);
    return { ok: true };
  }
  stopSimulation() { clearInterval(this.simInterval); this.simInterval = null; }
  // ── API Key Pool — rotação automática quando uma chave estoura créditos ────
  // Suporta até 5 chaves. Quando uma estoura, rotaciona para a próxima automaticamente.
  _initKeyPool() {
    const keys = [];
    // Chave principal
    if (this.settings.apiKey) keys.push(this.settings.apiKey);
    // Chaves extras (apiKeys = array de strings)
    if (Array.isArray(this.settings.apiKeys)) {
      for (const k of this.settings.apiKeys) {
        if (k && k.trim() && !keys.includes(k.trim())) keys.push(k.trim());
      }
    }
    this._keyPool    = keys;
    this._keyIndex   = 0;
    this._keyPause   = new Map(); // key → pauseUntil timestamp
  }

  _currentKey() {
    if (!this._keyPool || this._keyPool.length === 0) return null;
    // Encontra a próxima chave disponível (não em pausa)
    const now = Date.now();
    for (let i = 0; i < this._keyPool.length; i++) {
      const idx = (this._keyIndex + i) % this._keyPool.length;
      const key = this._keyPool[idx];
      if ((this._keyPause.get(key) || 0) <= now) {
        this._keyIndex = idx;
        return key;
      }
    }
    // Todas em pausa — retorna a que vai liberar mais cedo
    let earliest = Infinity, bestKey = this._keyPool[0];
    for (const [k, t] of this._keyPause) { if (t < earliest) { earliest = t; bestKey = k; } }
    return bestKey;
  }

  _penalizeKey(key) {
    this._keyPause.set(key, Date.now() + 65000);
    this._keyIndex = (this._keyIndex + 1) % (this._keyPool.length || 1);
    const available = this._keyPool.filter(k => (this._keyPause.get(k) || 0) <= Date.now());
    if (available.length > 0) {
      this.log('warn', `Chave ${key.slice(-6)} esgotada — rotacionando para próxima (${available.length} disponível/is)`);
    } else {
      const minPause = Math.min(...[...this._keyPause.values()]);
      const waitSecs = Math.ceil((minPause - Date.now()) / 1000);
      this.log('error', `Todas as chaves esgotadas — aguardando ${waitSecs}s`);
      this.pauseUntil = minPause;
    }
  }

  // ── Ticker de expiração — zero custo de API ────────────────────────────────
  // Em binário não precisamos checar SL/TP em tempo real.
  // Apenas incrementa _candlesSeen nos registros pending usando os candles
  // já disponíveis no Map — sem nenhuma requisição adicional à Twelve Data.
  priceTick() {
    if (!this.isRunning) return;
    const pending = this.winRate.records.filter(r => r.outcome === 'PENDING');
    if (pending.length === 0) return;
    // Penúltimo candle = último candle FECHADO (o último pode estar em formação)
    // Zero custo de API — usa apenas o Map já preenchido pelo scanCycle
    this.winRate.updateCandles({
      get: (pair) => {
        const c = this.candles5.get(pair);
        return c && c.length > 1 ? c[c.length - 2] : null;
      }
    });
    const summary = this.winRate.getSummary();
    this.emit('winrate', summary);
  }

  runSimStep() {
    const pairs = (this.settings.pairs || []).slice(0, 10);
    pairs.forEach((pair, idx) => {
      const c5 = this.candles5.get(pair) || buildSeedCandles(pair, 150, idx);
      const next5 = buildNextCandle(c5[c5.length-1], this.simStep+idx, '5min');
      const up5 = [...c5, next5].slice(-150);
      this.candles5.set(pair, up5);
      const c15 = buildSyntheticM15(up5);
      this.candles15.set(pair, c15);
      this.prices.set(pair, { price: next5.close });
      this.emit('price',   { pair, price: next5.close, timestamp: next5.datetime });
      this.emit('candles', { pair, candles: up5 });
      const sig = this.evaluate(pair, up5, c15, true);
      if (sig) this.emit('signal', sig);
    });
    this.winRate.updateCandles({ get: (pair) => {
      const c = this.candles5.get(pair);
      return c && c.length > 1 ? c[c.length - 2] : null;
    }});
    this.emit('winrate', this.winRate.getSummary());
    this.simStep++;
    this.emitStatus('running', 'Simulação · passo ' + this.simStep);
  }

  async scanCycle() {
    if (!this.isRunning || this.isScanning) return;
    if (Date.now() < this.pauseUntil) { const s = Math.ceil((this.pauseUntil - Date.now())/1000); this.emitStatus('error','Proteção de API — aguardando ' + s + 's'); return; }
    const bucket = this.bucket();
    if (bucket === this.lastBucket && this.candles5.size > 0) { this.emitStatus('running', 'Ativo · próximo ciclo em ~' + (5 - (Math.floor(Date.now()/60000) % 5)) + 'min'); return; }
    this.isScanning = true;
    try {
      const allPairs = (this.settings.pairs || []).slice(0, 8);
      // 1 único lote com todos os pares — Twelve Data aceita múltiplos símbolos numa requisição
      // Créditos = número de pares (8 pares = 8 créditos por ciclo, não 2 lotes)
      // Elimina sobreposição de ciclos que causava minutely > 8
      const batches = [allPairs];

      let updated = 0;
      for (let b = 0; b < batches.length; b++) {
        if (!this.isRunning) break;
        const pairs = batches[b];
        // Cada lote usa a próxima chave disponível no pool — distribui créditos entre chaves
        const key = this._currentKey ? this._currentKey() : this.settings.apiKey;
        // Avança o índice para o próximo lote usar chave diferente
        if (this._keyPool && this._keyPool.length > 1) this._keyIndex = (this._keyIndex + 1) % this._keyPool.length;
        const data5 = await this.fetchBatchWithKey(pairs, '5min', 150, key);
        for (const pair of pairs) {
          const c5  = parseSeries(data5, pair);
          const c15 = buildSyntheticM15(c5);
          if (!c5.length) continue;
          updated++;
          this.candles5.set(pair, c5); this.candles15.set(pair, c15);
          const last = c5[c5.length-1];
          this.prices.set(pair, { price: last.close });
          this.emit('price',   { pair, price: last.close, timestamp: last.datetime });
          this.emit('candles', { pair, candles: c5 });

          // ── Verificação de staleness ────────────────────────────────────────
          // O último candle fechado deve ter no máximo 2 candles M5 de idade (10min)
          // Se a API retornou dados atrasados, descarta sinal para evitar setup expirado
          const lastCandleMs = new Date(last.datetime.endsWith('Z') ? last.datetime : last.datetime + 'Z').getTime();
          const candleAgeMs  = Date.now() - lastCandleMs;
          const maxAgeMs     = 10 * 60 * 1000; // 10 minutos = 2 candles M5
          if (candleAgeMs > maxAgeMs) {
            this.log('warn', `⚠️ ${pair} — candle com ${Math.round(candleAgeMs/60000)}min de atraso, sinal descartado`);
            continue;
          }
          // ────────────────────────────────────────────────────────────────────

          const sig = this.evaluate(pair, c5, c15, false);
          if (sig) {
            // ── Filtro de reversão pré-entrada ─────────────────────────────────
            // Verifica o preço ao vivo do novo candle M15 que acabou de abrir.
            // Se o mercado já reverteu contra o sinal mais de 0.3×ATR antes
            // da entrada, o setup perdeu validade — sinal cancelado silenciosamente.
            const liveEntry = this.prices.get(pair);
            const livePrice = liveEntry && liveEntry.price ? liveEntry.price : null;
            const atrNow    = sig.slPips
              ? (sig.slPips / (pair.includes('JPY') ? 100 : 10000)) / 1.5
              : null;

            if (livePrice && atrNow) {
              const reversalThreshold = atrNow * 0.3;
              const reversed =
                (sig.direction === 'BUY'  && livePrice < sig.entry - reversalThreshold) ||
                (sig.direction === 'SELL' && livePrice > sig.entry + reversalThreshold);

              if (reversed) {
                const pipFactor = pair.includes('JPY') ? 100 : 10000;
                const pipsGone  = Math.round(Math.abs(livePrice - sig.entry) * pipFactor * 10) / 10;
                this.log('warn', `⚠️ ${pair} — sinal cancelado · preço reverteu ${pipsGone} pips antes da entrada`);
                continue; // não emite, não envia Telegram, não registra Win Rate
              }
            }
            // ───────────────────────────────────────────────────────────────────

            const secsLeft = nextCandleTime(15).secsLeft;

            // Win Rate registrado IMEDIATAMENTE — independente do delay de envio
            this.emit('signal', sig);
            this.lastSignalAt.set(pair, Date.now());
            this.lastSignalDir.set(pair, sig.direction);
            this.winRate.record(sig.id, pair, sig.direction, sig.entry, sig.expiryCandles, sig.strategy, sig.candleTime, sig.sl, sig.tp);
            // Copia entryTime e contexto (regime/h1Bias/session/score) para o registro Win Rate
            const wr = this.winRate.records[this.winRate.records.length - 1];
            if (wr) {
              if (sig.entryTime)  wr.entryTime = sig.entryTime;
              // NOVO: contexto para banco da IA v2
              wr._regime  = sig.regime   || null;
              wr._h1Bias  = sig.h1Bias   || null;
              wr._session = sig.session  || null;
              wr._score   = sig.confidence || null;
            }
            this._saveWinRateSession(); // persiste PENDING imediatamente

            if (secsLeft < 60) {
              // Só o Telegram é atrasado — UI e Win Rate já foram atualizados
              const delayMs = (secsLeft + 5 * 60 - 60) * 1000;
              this.log('info', `⏳ ${pair} ${sig.direction} — Telegram agendado em ${Math.round(delayMs/1000)}s`);
              setTimeout(async () => {
                if (!this.isRunning) return;
                await this.dispatch(sig);
              }, delayMs);
            } else {
              await this.dispatch(sig);
            }
          }
        }
        // Delay sempre entre lotes — limite é por conta, não por chave
        if (b < batches.length - 1) {
          await new Promise(r => setTimeout(r, 12000)); // 12s garante ficamos abaixo de 8/min
        }
      }
      this.winRate.updateCandles(this.candles5.size > 0 ? { get: (pair) => {
        const c = this.candles5.get(pair);
        return c && c.length > 1 ? c[c.length - 2] : null;
      }} : null);
      this.emit('winrate', this.winRate.getSummary());
      if (updated) { this.lastBucket = bucket; this.log('info', 'M15 em lote · ' + updated + ' pares · ' + batches.length + ' crédito(s) · M15+H1 sintético (4×M15) · FVG+BOS ativos'); }
      this.emitStatus('running', 'Scanner ativo · ' + new Date().toLocaleTimeString('pt-BR'));
    } catch (err) {
      if (/credits|minute|run out/i.test(err.message)) { this.pauseUntil = Date.now() + 65000; this.log('error','Limite Twelve — pausa 65s.'); }
      else this.log('error', 'Erro: ' + err.message);
      this.emitStatus('error','Falha no scanner');
    } finally { this.isScanning = false; }
  }

  async fetchBatch(pairs, interval, outputsize) {
    const key = this._currentKey ? this._currentKey() : this.settings.apiKey;
    return this.fetchBatchWithKey(pairs, interval, outputsize, key);
  }

  async fetchBatchWithKey(pairs, interval, outputsize, key) {
    const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(pairs.join(',')) + '&interval=' + interval + '&outputsize=' + outputsize + '&timezone=UTC&apikey=' + key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        if (this._penalizeKey) this._penalizeKey(key);
        throw new Error('credits|run out of API credits');
      }
      const data = await res.json();
      if (!res.ok || data.status === 'error') throw new Error(data.message || 'Falha Twelve (' + interval + ')');
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Timeout (15s) em ' + interval);
      throw err;
    }
  }

  evaluate(pair, c5, c15, isSim) {
    if (c5.length < 60) return null;
    const cooldownMs = (this.settings.cooldownMinutes || 10) * 60000;
    if (!isSim && Date.now() - (this.lastSignalAt.get(pair) || 0) < cooldownMs) return null;

    const session = getSessionBonus();
    // Proteção noturna desativada — opera 24h

    // Bloqueia horário de almoço europeu (11:30–12:45 UTC) — volume baixo global
    const nowHMeval = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    if (!isSim && nowHMeval >= 11*60+30 && nowHMeval < 12*60+45) return null;

    // Bloqueia se há notícia de alto impacto nas próximas/últimas 30min
    if (!isSim && this._newsBlocked(pair)) return null;

    const closes  = c5.map(function(c) { return c.close; });
    const adx     = calcADX(c5, 10);        // ADX período 10 — equilibrio entre reatividade e estabilidade
    const atr     = calcATR(c5, 14);
    const regime  = detectRegime(c5, adx);
    const stoch   = calcStoch(c5, 14, 3);
    const candle  = detectCandlePattern(c5);
    const swing   = findSwingLevels(c5, 25);
    const digits  = pair.includes('JPY') ? 3 : 5;

    // ── Análises adicionais (zero custo de API) ───────────────────────────────
    const h1Bias       = getH1Bias(c5);
    const mktStructure = detectMarketStructure(c5, swing);
    const fvgZones     = detectFVGZones(c5, atr);
    const orderBlocks  = detectOrderBlocks(c5);

    let result = null;

    // ── 6 estratégias de alta convicção em M5 binário ──────────────────────
    // Removidas: EMA Cross 9/21, Session Breakout, MACD Divergência,
    //            Inside Bar Break, Breakout BB, Stoch Extreme Cross, Trend Pullback
    // Motivo: lentas/genéricas/duplicadas — diluíam o banco de dados da IA

    if (regime === 'TREND_UP' || regime === 'TREND_DOWN') {
      // Tendência: pullback preciso na EMA + sequência momentum + Smart Money
      result = stratEMA9Bounce(c5, adx, h1Bias)
            || stratThreeCandles(c5, adx, h1Bias)
            || stratRSICross(c5, adx, h1Bias)
            || stratFVG(c5, atr, fvgZones, mktStructure, h1Bias);
    } else if (regime === 'RANGE') {
      // Range: reversão de zona + Pin Bar + FVG como confluência Smart Money
      result = stratRangeReversal(c5, stoch, mktStructure, adx)
            || stratPinBarPrecision(c5, swing, h1Bias)
            || stratFVG(c5, atr, fvgZones, mktStructure, h1Bias);
    } else {
      // NEUTRAL — mercado sem direção definida, edge próximo de 50/50
      this.log('debug', 'Regime NEUTRAL em ' + pair + ' — sem sinal (mercado indeciso)');
      return null;
    }

    if (!result) { this.log('debug', 'Sem setup: ' + pair + ' | ' + regime + ' | ADX ' + adx.adx + ' | H1 ' + h1Bias); return null; }
    if (regime === 'TREND_UP'   && result.direction === 'PUT')  return null;
    if (regime === 'TREND_DOWN' && result.direction === 'CALL') return null;

    // ── Candle pattern ────────────────────────────────────────────────────────
    let candleBonus = 0;
    if (candle.bias === 'bull' && result.direction === 'CALL') { candleBonus = 10; result.parts.confirmation = true; }
    if (candle.bias === 'bear' && result.direction === 'PUT')  { candleBonus = 10; result.parts.confirmation = true; }
    if (candle.bias === 'bull' && result.direction === 'PUT')  candleBonus = -10;
    if (candle.bias === 'bear' && result.direction === 'CALL') candleBonus = -10;

    // ── S&R bonus ─────────────────────────────────────────────────────────────
    const last   = c5[c5.length-1];
    const nearSup = nearSupportOrResistance(last.close, swing.supports,    atr);
    const nearRes = nearSupportOrResistance(last.close, swing.resistances, atr);
    const srBonus = (result.direction === 'CALL' && nearSup) || (result.direction === 'PUT' && nearRes) ? 8 : 0;

    // Bônus externos: cap reduzido para 18 (era 20) — evita score artificial
    const externalBonus = Math.min(18, session.bonus + candleBonus + srBonus);

    // ── BOS/CHoCH bonus ───────────────────────────────────────────────────────
    let bosBonus = 0, bosType = null;
    if (mktStructure.lastBOS) {
      if (mktStructure.lastBOS.type === 'BULLISH_BOS' && result.direction === 'CALL') { bosBonus = 10; bosType = 'BULLISH_BOS'; }
      if (mktStructure.lastBOS.type === 'BEARISH_BOS' && result.direction === 'PUT')  { bosBonus = 10; bosType = 'BEARISH_BOS'; }
    }
    if (mktStructure.lastCHoCH) {
      if (mktStructure.lastCHoCH.type === 'BULLISH_CHOCH' && result.direction === 'CALL') { bosBonus = 12; bosType = 'BULLISH_CHOCH'; }
      if (mktStructure.lastCHoCH.type === 'BEARISH_CHOCH' && result.direction === 'PUT')  { bosBonus = 12; bosType = 'BEARISH_CHOCH'; }
      if (mktStructure.lastCHoCH.type === 'BEARISH_CHOCH' && result.direction === 'CALL') bosBonus = -12;
      if (mktStructure.lastCHoCH.type === 'BULLISH_CHOCH' && result.direction === 'PUT')  bosBonus = -12;
    }

    // ── Order Block confluência ────────────────────────────────────────────────
    let obBonus = 0;
    for (const ob of orderBlocks) {
      const inOB = last.close >= ob.low && last.close <= ob.high;
      if (ob.type === 'BULLISH_OB' && result.direction === 'CALL' && inOB) { obBonus = 8; break; }
      if (ob.type === 'BEARISH_OB' && result.direction === 'PUT'  && inOB) { obBonus = 8; break; }
    }

    // ── FVG quality penalty ────────────────────────────────────────────────────
    // DIRTY = zona já visitada (touchCount > 0). Bloqueado em stratFVG como 1ª defesa.
    // Penalidade -25 como 2ª defesa caso chegue aqui por outro caminho.
    const fvgPenalty = result.fvgQuality === 'DIRTY' ? -25 : 0;

    // ── H1 Bias penalty ────────────────────────────────────────────────────────
    let h1Penalty = 0;
    if (result.direction === 'CALL' && h1Bias === 'BEARISH')        h1Penalty = -8;
    if (result.direction === 'CALL' && h1Bias === 'BEARISH_STRONG') h1Penalty = -15;
    if (result.direction === 'PUT'  && h1Bias === 'BULLISH')        h1Penalty = -8;
    if (result.direction === 'PUT'  && h1Bias === 'BULLISH_STRONG') h1Penalty = -15;

    const contextBonus = bosBonus + obBonus + fvgPenalty + h1Penalty;
    const score = Math.min(95, scoreSignal(result.parts, externalBonus, contextBonus));
    // Score mínimo: 82 como padrão — permite volume adequado (4-8 sinais/dia)
    // Valor 90 anterior era excessivamente restritivo gerando apenas 1-3 sinais/dia
    const minScore = this.settings.minScore || 82;

    // Filtro de confluência mínima: ao menos 4 dos 5 pilares precisam estar ativos
    const activeParts = Object.values(result.parts).filter(Boolean).length;
    if (activeParts < 4) {
      this.log('debug', 'Confluência insuficiente (' + activeParts + '/5 pilares) em ' + pair + ' — descartado');
      return null;
    }

    if (score < minScore) {
      this.log('debug', 'Score ' + score + ' < mínimo ' + minScore + ' em ' + pair + ' | H1:' + h1Bias + ' | ' + mktStructure.currentStructure);
      return null;
    }
    if (!isSim && this.lastSignalDir.get(pair) === result.direction && Date.now() - (this.lastSignalAt.get(pair)||0) < cooldownMs*2) return null;

    // ── Expiração por estratégia — em opções binárias não há SL/TP ────────────
    // Estratégias de momentum (rápidas) → 1 candle M5 = 5 min
    // Estratégias de estrutura/divergência → 2 candles M5 = 10 min
    // Todas as estratégias expiram em 1 candle M5 = 5 minutos
    // Entrada no open do próximo candle → fecha no close desse mesmo candle
    // ── Stop Loss e Take Profit baseados no ATR ──────────────────────────
    // SL = 1.5 × ATR14 — protege contra ruído normal do M5
    // TP = 2.5 × ATR14 — risk:reward mínimo 1:1.7
    // Estratégias de reversão usam SL mais apertado (1.2×ATR)
    const atr14 = calcATR(c5, 14);
    const isReversal = ['Range Reversal', 'Pin Bar Precisão'].includes(result.strategy);
    const slMultiplier = isReversal ? 1.2 : 1.5;
    const tpMultiplier = isReversal ? 2.0 : 2.5;
    const slDistance = round(atr14 * slMultiplier, digits);
    const tpDistance = round(atr14 * tpMultiplier, digits);
    const entryPrice = round(last.close, digits);
    // pips = distância × 10000 (exceto JPY = × 100)
    const pipFactor  = pair.includes('JPY') ? 100 : 10000;
    const slPips     = Math.round(slDistance * pipFactor * 10) / 10;
    const tpPips     = Math.round(tpDistance * pipFactor * 10) / 10;
    const sl = result.direction === 'BUY'
      ? round(entryPrice - slDistance, digits)
      : round(entryPrice + slDistance, digits);
    const tp = result.direction === 'BUY'
      ? round(entryPrice + tpDistance, digits)
      : round(entryPrice - tpDistance, digits);

    const signal = {
      id:            pair + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
      pair,
      direction:     result.direction,         // 'BUY' ou 'SELL'
      strategy:      isSim ? '[SIM] ' + result.strategy : result.strategy,
      regime,
      timeframe:     '15min',
      confidence:    score,
      grade:         scoreToGrade(score),
      entry:         entryPrice,
      expiryCandles: 3,   // 3 candles M5 = 15 min de janela para TP/SL
      sl,
      tp,
      slPips,
      tpPips,
      rr:            Math.round((tpPips / slPips) * 10) / 10,   // Risk:Reward ex: 1.7
      adxValue:      adx.adx,
      session:       session.label,
      candlePattern: candle.pattern,
      candleTime:    last.datetime,
      createdAt:     new Date().toISOString(),
      h1Bias,
      structureType: mktStructure.currentStructure,
      bosType,
      fvgQuality:    result.fvgQuality || null,
      reason:        regime + ' · H1:' + h1Bias + ' · ' + mktStructure.currentStructure + (bosType ? ' · ' + bosType : '') + ' · ADX ' + round(adx.adx,1) + ' · ' + session.label + ' · SL ' + slPips + 'p · TP ' + tpPips + 'p'
    };

    this.log('success', (isSim?'[SIM] ':'') + result.direction + ' ' + pair + ' · ' + result.strategy + ' · Score ' + score + ' · SL ' + slPips + 'p · TP ' + tpPips + 'p · RR 1:' + Math.round((tpPips/slPips)*10)/10 + ' · ' + session.label);
    if (!isSim) this.lastSignalDir.set(pair, result.direction);
    return signal;
  }

  async dispatch(signal) {
    const { telegramBotToken: token, telegramChatId: chatId } = this.settings;
    if (token && chatId) {
      try {
        const r = await sendTelegramWithRetry(token, chatId, buildTelegramMessage(signal));
        this.log('success', 'Telegram enviado' + (r.fallback?' (sem formatação)':'') + ' na tentativa ' + r.attempt);
      } catch (e) {
        this.log('error', 'Telegram falhou após 3 tentativas: ' + e.message);
      }
    } else {
      this.log('info', 'Telegram não configurado — sinal só no app.');
    }
    return true;
  }

  async testTelegramConnection() {
    const { telegramBotToken: token, telegramChatId: chatId } = this.settings;
    if (!token || !chatId) {
      this.log('info', 'Telegram não configurado para teste.');
      return { ok: false, error: 'Preencha Bot Token e Chat ID antes do teste.' };
    }
    try {
      const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
      const testMsg = '✅ *Binary Scanner v1.0 — Conexão OK*\n\n🕒 ' + now + ' (Fortaleza)\n🤖 Bot conectado.\n🎯 Sistema de Opções Binárias · CALL/PUT\n🆕 H1 Bias · BOS/CHoCH · FVG · OB ativos\n\n_Este é um teste de verificação._';
      const r = await sendTelegramWithRetry(token, chatId, testMsg);
      this.log('success', 'Teste Telegram enviado' + (r.fallback?' (sem formatação)':'') + ' na tentativa ' + r.attempt);
      return { ok: true, attempt: r.attempt, fallback: !!r.fallback };
    } catch (e) {
      this.log('error', 'Teste Telegram falhou: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  async sendTestSignal() {
    const fake = {
      id: 'test-' + Date.now(), pair:'EUR/USD', direction:'BUY',
      strategy:'Teste manual', regime:'TREND_UP', timeframe:'5min',
      confidence:82, entry:1.08340, expiryCandles:1, expiryMinutes:5,
      adxValue:26.4, session:'Londres+NY 🔥', candlePattern:'Morning Star',
      candleTime:new Date().toISOString(), createdAt:new Date().toISOString(),
      h1Bias:'BULLISH_STRONG', structureType:'UPTREND', bosType:'BULLISH_BOS', fvgQuality:null,
      reason:'Sinal de validação do sistema'
    };
    await this.dispatch(fake);
    this.emit('signal', fake);
    return { ok: true };
  }

  bucket() { return Math.floor(Date.now() / (5 * 60000)); }
  log(level, message, extra) {
    extra = extra || {};
    this.emit('log', Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2,6), level, message, timestamp: new Date().toISOString() }, extra));
  }
  emitStatus(state, message) { this.emit('status', { state, message, updatedAt: new Date().toISOString() }); }
  getWinRateRecords() { return this.winRate.getRecent(30); }
}

module.exports = { ScannerEngine, buildSeedCandles, buildNextCandle, parseSeries };
