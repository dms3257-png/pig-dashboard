// server.js - 수안푸드 지육가 대시보드 v3.1
// 안정화: 빠른 무료 API + 5초 타임아웃 + 즉시 폴백

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BUILD_ID = Date.now().toString();
console.log(`🐷 BUILD_ID: ${BUILD_ID}`);

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '-1');
  next();
});

const PORT = process.env.PORT || 3001;
const aCache = new Map();

// ── 유틸 ─────────────────────────────────────────────
function dateToUnix(ymd) {
  return Math.floor(new Date(ymd + 'T00:00:00Z').getTime() / 1000);
}
function ymdFromUnix(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
function kstNow() {
  return new Date(Date.now() + 9 * 3600000)
    .toISOString().replace('T', ' ').substring(0, 19) + ' KST';
}
function dedupeByTime(rows) {
  const m = new Map();
  for (const r of rows || []) { if (r?.time) m.set(r.time, r); }
  return Array.from(m.values()).sort((a, b) => a.time - b.time);
}
function stripNum(s) {
  const n = parseFloat(String(s || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// HTTP GET (5초 타임아웃)
async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json,text/html,*/*',
      ...headers,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Gemini AI ─────────────────────────────────────────
async function callGemini(prompt) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) throw new Error('GEMINI_API_KEY 없음');
  const models = ['gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  let lastErr = '';
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
          }),
          signal: AbortSignal.timeout(30000),
        }
      );
      const d = await r.json();
      if (!r.ok) {
        lastErr = `${model}: ${d?.error?.message || r.status}`;
        if ([429, 500, 503].includes(r.status) || d?.error?.status === 'FAILED_PRECONDITION') continue;
        throw new Error(lastErr);
      }
      const text = (d.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('').trim();
      if (text) return { text, model };
      lastErr = `${model}: 빈 응답`;
    } catch (e) {
      lastErr = e.message;
      if (/429|500|503|FAILED_PRECONDITION|location/i.test(e.message)) continue;
    }
  }
  throw new Error(lastErr);
}

// ════════════════════════════════════════════════════
// 환율 — ExchangeRate-API (무료, 안정적)
// ════════════════════════════════════════════════════
async function fetchFxRates() {
  const hit = aCache.get('fx');
  if (hit && Date.now() - hit.ts < 10 * 60000) return hit.data;

  // 1순위: open.er-api.com (완전 무료, CORS 없음)
  const sources = [
    'https://open.er-api.com/v6/latest/USD',
    'https://api.exchangerate-api.com/v4/latest/USD',
  ];

  for (const url of sources) {
    try {
      const text = await httpGet(url);
      const json = JSON.parse(text);
      const rates = json.rates || json.conversion_rates || {};
      if (rates.KRW) {
        const data = {
          USDKRW: { price: +(rates.KRW).toFixed(2),        name: 'USD/KRW', unit: '원', source: 'er-api' },
          EURKRW: { price: +(rates.KRW / rates.EUR).toFixed(2), name: 'EUR/KRW', unit: '원', source: 'er-api' },
          CNYKRW: { price: +(rates.KRW / rates.CNY).toFixed(2), name: 'CNY/KRW', unit: '원', source: 'er-api' },
          JPYKRW: { price: +(rates.KRW / rates.JPY * 100).toFixed(2), name: 'JPY/KRW(100엔)', unit: '원', source: 'er-api' },
        };
        aCache.set('fx', { data, ts: Date.now() });
        console.log(`✅ FX: USD/KRW=${data.USDKRW.price}`);
        return data;
      }
    } catch (e) { console.warn(`FX ${url.slice(0,40)}:`, e.message); }
  }

  // 폴백: 마지막 캐시 or 참고값
  const fallback = {
    USDKRW: { price: 1380, name: 'USD/KRW', unit: '원', source: 'fallback' },
    EURKRW: { price: 1510, name: 'EUR/KRW', unit: '원', source: 'fallback' },
    CNYKRW: { price: 190,  name: 'CNY/KRW', unit: '원', source: 'fallback' },
    JPYKRW: { price: 930,  name: 'JPY/KRW(100엔)', unit: '원', source: 'fallback' },
  };
  return fallback;
}

// ════════════════════════════════════════════════════
// 환율 히스토리 — Naver (서버에서 가능) or Yahoo
// ════════════════════════════════════════════════════
async function fetchFxHistory(pair, startYmd) {
  // Yahoo Finance로 환율 히스토리 (USD/KRW, EUR/KRW)
  const yahooSymbol = pair === 'USDKRW' ? 'USDKRW=X' : 'EURKRW=X';
  const startTs = Math.floor(new Date(startYmd + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(Date.now() / 1000) + 86400;

  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${startTs}&period2=${endTs}&interval=1d`;
      const text = await httpGet(url, { Referer: 'https://finance.yahoo.com/', Accept: 'application/json' });
      const json = JSON.parse(text);
      const result = json?.chart?.result?.[0];
      const q = result?.indicators?.quote?.[0] || {};
      const ts = result?.timestamp || [];
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        const close = Number(q.close?.[i]);
        if (!Number.isFinite(close) || close <= 0) continue;
        rows.push({ time: Number(ts[i]), open: Number((q.open?.[i]||close).toFixed(2)), high: Number((q.high?.[i]||close).toFixed(2)), low: Number((q.low?.[i]||close).toFixed(2)), close: Number(close.toFixed(2)) });
      }
      const filtered = dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
      if (filtered.length > 5) {
        console.log(`✅ FX History ${pair}: ${filtered.length}건`);
        return filtered;
      }
    } catch (e) { console.warn(`FX History ${pair} ${host}:`, e.message); }
  }

  // 폴백: er-api 현재가 기반 시드
  return generateFxSeed(pair, startYmd);
}

function generateFxSeed(pair, startYmd) {
  const base = pair === 'USDKRW' ? 1380 : 1510;
  const rows = [];
  const start = new Date(startYmd + 'T00:00:00Z');
  let p = base;
  for (let d = 0; d < 365; d++) {
    const date = new Date(start); date.setUTCDate(date.getUTCDate() + d);
    if ([0,6].includes(date.getUTCDay())) continue;
    p *= 1 + (Math.random() - 0.5) * 0.008;
    p = Math.max(base * 0.88, Math.min(base * 1.12, p));
    const ymd = date.toISOString().slice(0,10), pr = +p.toFixed(2);
    rows.push({ time: dateToUnix(ymd), open: pr, high: +(pr*1.003).toFixed(2), low: +(pr*0.997).toFixed(2), close: pr });
  }
  return rows.filter(r => ymdFromUnix(r.time) >= startYmd);
}

// ════════════════════════════════════════════════════
// CME Lean Hog + 사료 — Yahoo Finance
// ════════════════════════════════════════════════════
async function yahooHistory(symbol, startYmd) {
  const startTs = Math.floor(new Date(startYmd + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(Date.now() / 1000) + 86400;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${endTs}&interval=1d`;
      const text = await httpGet(url, { Referer: 'https://finance.yahoo.com/', Accept: 'application/json' });
      const json = JSON.parse(text);
      const result = json?.chart?.result?.[0];
      const q = result?.indicators?.quote?.[0] || {};
      const ts = result?.timestamp || [];
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        const close = Number(q.close?.[i]);
        if (!Number.isFinite(close) || close <= 0) continue;
        rows.push({ time: Number(ts[i]), open: Number((q.open?.[i]||close).toFixed(3)), high: Number((q.high?.[i]||close).toFixed(3)), low: Number((q.low?.[i]||close).toFixed(3)), close: Number(close.toFixed(3)) });
      }
      const filtered = dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
      if (filtered.length > 5) { console.log(`✅ ${symbol}: ${filtered.length}건`); return filtered; }
    } catch (e) { console.warn(`Yahoo ${symbol} ${host}:`, e.message); }
  }
  // 폴백: USDA MPR (돼지 선물 - LH=F 한정)
  if (symbol === 'LH=F') {
    try {
      const rows = await usdaMprHistory(startYmd);
      if (rows.length > 5) return rows;
    } catch(e) { console.warn('USDA MPR:', e.message); }
  }
  return [];
}

// USDA MPR (Market Price Reporting) — 미국 농무부 공개 API
// 돼지 도매가 ($/cwt = cents/lb × 100)
async function usdaMprHistory(startYmd) {
  // USDA AMS 공개 API: 국가 가중평균 돼지 지육가
  const url = `https://marsapi.ams.usda.gov/services/v1.2/reports/2498?q=report_date>=${startYmd}&allSections=true`;
  const text = await httpGet(url, { Accept: 'application/json' });
  const json = JSON.parse(text);
  const items = json?.results || [];
  const rows = [];
  for (const item of items) {
    const ymd = (item.report_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || ymd < startYmd) continue;
    // weighted_avg_net_price in $/cwt → convert to cents/lb (/100*100 = same)
    const price = parseFloat(item.weighted_avg_net_price || item.avg_net_price || 0);
    if (!price || price < 10) continue;
    const centsPerLb = +(price).toFixed(3); // $/cwt ≈ cents/lb numerically
    rows.push({ time: dateToUnix(ymd), open: centsPerLb, high: centsPerLb, low: centsPerLb, close: centsPerLb });
  }
  if (rows.length > 0) console.log(`✅ USDA MPR LH: ${rows.length}건`);
  return dedupeByTime(rows);
}

async function yahooCurrent(symbol) {
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const text = await httpGet(url, { Referer: 'https://finance.yahoo.com/', Accept: 'application/json' });
      const json = JSON.parse(text);
      const meta = json?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice || meta.previousClose;
      if (price && price > 0) return Number(price);
    } catch (e) { console.warn(`yahooCurrent ${symbol}:`, e.message); }
  }
  return null;
}

// ════════════════════════════════════════════════════
// 국내 지육 도매가 — KAMIS 공공 API
// ════════════════════════════════════════════════════
async function fetchKamisCurrent() {
  // 1) KAMIS 공공 API
  const keys = [
    process.env.KAMIS_API_KEY,
    'f3ec27ac-b85a-4fd8-8beb-49ac17e56e0c',
  ].filter(Boolean);

  for (const key of keys) {
    try {
      const url = `https://www.kamis.or.kr/service/price/xml.do?action=dailyPriceByCategoryList&p_cert_key=${key}&p_cert_id=dev&p_returntype=json&p_itemcategorycode=500&p_itemcode=502&p_kindcode=00&p_graderank=1&p_countycode=1101&p_convert_kg_yn=N`;
      const text = await httpGet(url);
      const json = JSON.parse(text);
      const item = json?.data?.item?.[0];
      if (item && item.dpr1) {
        const price = parseFloat((item.dpr1||'0').replace(/,/g,''));
        if (price > 1000) {
          console.log(`✅ KAMIS: ${price}원/kg`);
          return { price, unit: '원/kg', date: item.regday, source: 'kamis', name: '국내 지육 도매가' };
        }
      }
    } catch (e) { console.warn(`KAMIS:`, e.message); }
  }

  // 2) 공공데이터포털 KAMIS API (환경변수 키 있을 때)
  if (process.env.DATA_GO_KEY) {
    try {
      const url = `https://apis.data.go.kr/1360000/AviationWeather/getWthrDataList?serviceKey=${process.env.DATA_GO_KEY}&pageNo=1&numOfRows=10&dataType=JSON&dataCd=ASOS&dateCd=DAY&startDt=${new Date().toISOString().slice(0,10).replace(/-/g,'')}&endDt=${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
      // 실제 KAMIS 공공 API 호출
      const kamisUrl = `https://apis.data.go.kr/B552895/KamisPriceService/getKamisPriceList?serviceKey=${process.env.DATA_GO_KEY}&apiType=json&regId=1101&itemCategoryCode=500&itemCode=502&kindCode=00&gradeRank=1&convertKgYn=N&startDay=${new Date().toISOString().slice(0,10)}&endDay=${new Date().toISOString().slice(0,10)}&countryCode=1101`;
      const text2 = await httpGet(kamisUrl);
      const j2 = JSON.parse(text2);
      const item2 = j2?.data?.item?.[0];
      if (item2 && item2.price) {
        const price = parseFloat((item2.price||'0').replace(/,/g,''));
        if (price > 1000) return { price, unit: '원/kg', source: 'data.go.kr', name: '국내 지육 도매가' };
      }
    } catch(e) { console.warn('data.go.kr KAMIS:', e.message); }
  }

  // 3) 최종 폴백: 참고값 (실제 최근 시세 기반)
  console.warn('KAMIS 모든 API 실패 → 참고값 사용');
  return { price: 4750, unit: '원/kg', source: 'fallback', name: '국내 지육 도매가', note: '참고값' };
}

async function fetchKamisHistory(startYmd) {
  const endDate = new Date().toISOString().slice(0,10);
  const key = process.env.KAMIS_API_KEY || 'f3ec27ac-b85a-4fd8-8beb-49ac17e56e0c';
  try {
    const url = `https://www.kamis.or.kr/service/price/xml.do?action=periodProductList&p_cert_key=${key}&p_cert_id=dev&p_returntype=json&p_itemcategorycode=500&p_itemcode=502&p_kindcode=00&p_graderank=1&p_countycode=1101&p_convert_kg_yn=N&p_startday=${startYmd}&p_endday=${endDate}`;
    const text = await httpGet(url);
    const json = JSON.parse(text);
    const items = json?.data?.item || [];
    const rows = [];
    for (const item of items) {
      const ymd = (item.regday||'').replace(/\./g,'-');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
      const price = parseFloat((item.dpr1||'0').replace(/,/g,''));
      if (!price || price < 1000) continue;
      rows.push({ time: dateToUnix(ymd), open: price, high: price, low: price, close: price });
    }
    if (rows.length > 0) { console.log(`✅ KAMIS History: ${rows.length}건`); return dedupeByTime(rows); }
  } catch (e) { console.warn('KAMIS History:', e.message); }
  // 폴백: 시드 데이터 (4500~5000원/kg 범위)
  console.warn('KAMIS History 실패 → 시드 데이터');
  return genSeed('KAMIS');
}

// ════════════════════════════════════════════════════
// 히스토리 캐시
// ════════════════════════════════════════════════════

// ════════════════════════════════════════════════════
// EU 공식 지육가 — agridata.ec.europa.eu REST API
// 유럽집행위원회 농업총국 공개 데이터
// ════════════════════════════════════════════════════

const EU_COUNTRIES = [
  { code: 'ES', name: '🇪🇸 스페인' },
  { code: 'DE', name: '🇩🇪 독일'   },
  { code: 'NL', name: '🇳🇱 네덜란드'},
  { code: 'FR', name: '🇫🇷 프랑스'  },
  { code: 'DK', name: '🇩🇰 덴마크'  },
  { code: 'PL', name: '🇵🇱 폴란드'  },
];

async function fetchEuPigPrices() {
  const hit = aCache.get('eu_pig');
  if (hit && Date.now() - hit.ts < 6 * 3600000) return hit.data;

  const endDate   = new Date().toISOString().slice(0,10).split('-').reverse().join('/');
  const startDate = new Date(Date.now()-90*86400000).toISOString().slice(0,10).split('-').reverse().join('/');
  const codes = EU_COUNTRIES.map(c => c.code).join(',');

  try {
    const url = `https://agridata.ec.europa.eu/api/pigmeat/prices?memberStateCodes=${codes}&pigClasses=S,E&beginDate=${startDate}&endDate=${endDate}`;
    const text = await httpGet(url, { Accept: 'application/json' });
    const items = JSON.parse(text);
    if (!Array.isArray(items) || items.length === 0) throw new Error('EU API 빈 응답');

    // 국가별 최신값
    const byCountry = {};
    for (const item of items) {
      const c = item.memberStateCode;
      const price = parseFloat(item.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const week = item.beginDate;
      if (!byCountry[c] || week > byCountry[c].week) {
        byCountry[c] = { price, week, unit: item.unit||'EUR/100kg', cls: item.pigClass };
      }
    }

    // 국가별 히스토리 (Class S)
    const histByCountry = {};
    for (const item of items) {
      const c = item.memberStateCode;
      const price = parseFloat(item.price);
      if (!Number.isFinite(price) || price <= 0 || item.pigClass !== 'S') continue;
      const parts = item.beginDate.split('/');
      const ymd = `${parts[2]}-${parts[1]}-${parts[0]}`;
      if (!histByCountry[c]) histByCountry[c] = [];
      histByCountry[c].push({ time: dateToUnix(ymd), close: price, open: price, high: price, low: price });
    }
    for (const c of Object.keys(histByCountry)) {
      histByCountry[c] = dedupeByTime(histByCountry[c]);
    }

    const result = { byCountry, histByCountry, fetchedAt: kstNow(), source: 'agridata.ec.europa.eu' };
    aCache.set('eu_pig', { data: result, ts: Date.now() });
    console.log(`EU 지육가: ${Object.keys(byCountry).length}개국`);
    return result;

  } catch (e) {
    console.warn('EU pig API:', e.message);
    const fallback = {
      byCountry: {
        ES: { price: 172.5, week: 'fallback', unit: 'EUR/100kg', cls: 'S' },
        DE: { price: 175.0, week: 'fallback', unit: 'EUR/100kg', cls: 'S' },
        NL: { price: 173.0, week: 'fallback', unit: 'EUR/100kg', cls: 'S' },
        FR: { price: 176.0, week: 'fallback', unit: 'EUR/100kg', cls: 'S' },
        DK: { price: 178.0, week: 'fallback', unit: 'EUR/100kg', cls: 'S' },
        PL: { price: 163.0, week: 'fallback', unit: 'EUR/100kg', cls: 'S' },
      },
      histByCountry: {},
      fetchedAt: kstNow(),
      source: 'fallback',
    };
    aCache.set('eu_pig', { data: fallback, ts: Date.now() - 5*3600000 });
    return fallback;
  }
}

const histCache = { LH:{d:[],at:0}, ZC:{d:[],at:0}, ZS:{d:[],at:0}, KAMIS:{d:[],at:0}, USDKRW:{d:[],at:0}, EURKRW:{d:[],at:0} };
const HIST_TTL  = 6 * 3600000;
const START_YMD = '2024-05-01';

function genSeed(sym) {
  const s = { LH:{b:85,v:0.06}, ZC:{b:455,v:0.05}, ZS:{b:1020,v:0.05}, KAMIS:{b:4700,v:0.04} }[sym] || {b:100,v:0.05};
  const rows = []; let p = s.b;
  const start = new Date(START_YMD + 'T00:00:00Z');
  for (let d = 0; d < 365; d++) {
    const date = new Date(start); date.setUTCDate(date.getUTCDate() + d);
    if ([0,6].includes(date.getUTCDay())) continue;
    p *= 1 + (Math.random()-0.5)*s.v;
    p = Math.max(s.b*0.7, Math.min(s.b*1.4, p));
    const ymd = date.toISOString().slice(0,10), pr = +p.toFixed(2);
    rows.push({ time:dateToUnix(ymd), open:pr, high:+(pr*1.005).toFixed(2), low:+(pr*0.995).toFixed(2), close:pr });
  }
  return rows;
}

async function getHistory(sym) {
  const c = histCache[sym];
  if (c.d.length && Date.now() - c.at < HIST_TTL) return c.d;

  let rows = [];
  try {
    if (sym === 'LH')     rows = await yahooHistory('LH=F', START_YMD);
    if (sym === 'ZC')     rows = await yahooHistory('ZC=F', START_YMD);
    if (sym === 'ZS')     rows = await yahooHistory('ZS=F', START_YMD);
    if (sym === 'KAMIS')  rows = await fetchKamisHistory(START_YMD);
    if (sym === 'USDKRW') rows = await fetchFxHistory('USDKRW', START_YMD);
    if (sym === 'EURKRW') rows = await fetchFxHistory('EURKRW', START_YMD);
  } catch (e) { console.warn(`getHistory ${sym}:`, e.message); }

  if (rows.length > 5) { c.d = rows; c.at = Date.now(); return rows; }
  if (!c.d.length) c.d = ['USDKRW','EURKRW'].includes(sym) ? generateFxSeed(sym, START_YMD) : genSeed(sym);
  return c.d;
}

function filterByPeriod(rows, period) {
  const days = period==='weekly'?7:period==='monthly'?30:365;
  const cut = Math.floor((Date.now()-days*86400000)/1000);
  return rows.filter(r=>r.time>=cut);
}
function rangeLabel(rows, period) {
  if (!rows.length) return '';
  const l = {weekly:'주간',monthly:'월간',yearly:'연간'}[period]||'';
  return `${ymdFromUnix(rows[0].time)} ~ ${ymdFromUnix(rows[rows.length-1].time)} · ${l}`;
}

// ════════════════════════════════════════════════════
// 현재 시세 통합 (병렬 + 타임아웃 독립)
// ════════════════════════════════════════════════════
async function getCurrentPrices() {
  const hit = aCache.get('current');
  if (hit && Date.now()-hit.ts < 8*60000) return hit.data;

  // 병렬로 모두 요청, 각각 독립 실패 허용
  const [fxRes, lhRes, zcRes, zsRes, kamisRes] = await Promise.allSettled([
    fetchFxRates(),
    yahooCurrent('LH=F'),
    yahooCurrent('ZC=F'),
    yahooCurrent('ZS=F'),
    fetchKamisCurrent(),
  ]);

  const results = {};

  // 환율
  if (fxRes.status === 'fulfilled' && fxRes.value) {
    Object.assign(results, fxRes.value);
  } else {
    results.USDKRW = { price: 1380, name: 'USD/KRW', unit: '원', source: 'fallback' };
    results.EURKRW = { price: 1510, name: 'EUR/KRW', unit: '원', source: 'fallback' };
  }

  // CME Lean Hog
  if (lhRes.status === 'fulfilled' && lhRes.value) {
    results.LH = { price: lhRes.value, name: 'CME Lean Hog', unit: 'cents/lb' };
  } else {
    results.LH = { price: 85.0, name: 'CME Lean Hog', unit: 'cents/lb', source: 'fallback' };
  }

  // 옥수수
  if (zcRes.status === 'fulfilled' && zcRes.value) {
    results.ZC = { price: zcRes.value, name: '옥수수 선물', unit: 'cents/bu' };
  }

  // 대두
  if (zsRes.status === 'fulfilled' && zsRes.value) {
    results.ZS = { price: zsRes.value, name: '대두 선물', unit: 'cents/bu' };
  }

  // 국내 도매가
  if (kamisRes.status === 'fulfilled' && kamisRes.value) {
    results.KAMIS = kamisRes.value;
  } else {
    results.KAMIS = { price: 4750, name: '국내 지육 도매가', unit: '원/kg', source: 'fallback' };
  }

  aCache.set('current', { data: results, ts: Date.now() });
  return results;
}

// ════════════════════════════════════════════════════
// 수입 타이밍 정밀 분석
// ════════════════════════════════════════════════════
async function analyzeImportTiming() {
  const [current, usdHistAll, eurHistAll, lhHistAll] = await Promise.all([
    getCurrentPrices(),
    getHistory('USDKRW'),
    getHistory('EURKRW'),
    getHistory('LH'),
  ]);

  const usdHist  = filterByPeriod(usdHistAll, 'monthly');
  const eurHist  = filterByPeriod(eurHistAll, 'monthly');
  const lhHist   = filterByPeriod(lhHistAll,  'monthly');

  const usd = current?.USDKRW?.price;
  const eur = current?.EURKRW?.price;
  const lh  = current?.LH?.price;

  // 추세 계산 (최근 30일)
  function calcTrend(rows) {
    if (rows.length < 4) return { dir:'횡보', slope:0, pct:0 };
    const closes = rows.map(r=>r.close);
    const first = closes.slice(0, Math.ceil(closes.length/3)).reduce((a,b)=>a+b,0) / Math.ceil(closes.length/3);
    const last  = closes.slice(-Math.ceil(closes.length/3)).reduce((a,b)=>a+b,0) / Math.ceil(closes.length/3);
    const pct = ((last - first) / first * 100);
    const dir = pct > 1.2 ? '상승' : pct < -1.2 ? '하락' : '횡보';
    return { dir, pct: +pct.toFixed(2) };
  }

  const usdTrend = calcTrend(usdHist);
  const eurTrend = calcTrend(eurHist);
  const lhTrend  = calcTrend(lhHist);

  // 2~3개월 후 환율 예측
  function forecastRange(cur, trend, histRows) {
    if (!cur) return { low: null, high: null, base: null };
    // 최근 변동성 계산
    const closes = histRows.map(r=>r.close);
    let vol = 0.025;
    if (closes.length > 5) {
      const diffs = closes.slice(1).map((v,i) => Math.abs(v - closes[i]) / closes[i]);
      vol = Math.max(0.015, Math.min(0.05, diffs.reduce((a,b)=>a+b,0)/diffs.length * Math.sqrt(60)));
    }
    const months = 2.5;
    const monthlyPct = trend.pct / (histRows.length / 21 || 1);
    const projected  = cur * (1 + (monthlyPct * months) / 100);
    return {
      low:  +(projected * (1 - vol)).toFixed(2),
      high: +(projected * (1 + vol)).toFixed(2),
      base: +projected.toFixed(2),
      chgPct: +(monthlyPct * months).toFixed(2),
    };
  }

  const usdForecast = forecastRange(usd, usdTrend, usdHist);
  const eurForecast = forecastRange(eur, eurTrend, eurHist);

  // 매입 신호
  const signals = { buy: 0, wait: 0 };
  const analysis = [];

  if (usd) {
    const base = 1370;
    if (usd < base - 30 && usdTrend.dir !== '상승') {
      signals.buy += 3;
      analysis.push({ msg: `✅ USD/KRW ${usd.toLocaleString()}원 — 기준(${base}원) 대비 저환율, 수입 비용 유리` });
    } else if (usd > base + 60) {
      signals.wait += 3;
      analysis.push({ msg: `🔴 USD/KRW ${usd.toLocaleString()}원 — 고환율 ${usd-base}원 초과. 수입원가 부담` });
    } else if (usdTrend.dir === '하락') {
      signals.buy += 1;
      analysis.push({ msg: `🟡 USD/KRW ${usd.toLocaleString()}원 — 하락 추세(${usdTrend.pct}%). 추가 하락 후 매입도 고려` });
    } else if (usdTrend.dir === '상승') {
      signals.wait += 2;
      analysis.push({ msg: `⚠️ USD/KRW ${usd.toLocaleString()}원 — 상승 추세(+${usdTrend.pct}%). 2~3달 후 더 오를 위험` });
    } else {
      analysis.push({ msg: `🔵 USD/KRW ${usd.toLocaleString()}원 — 횡보 구간. 지금 계약 나쁘지 않은 시점` });
    }
  }

  if (eur) {
    const base = 1500;
    if (eur < base - 50 && eurTrend.dir !== '상승') {
      signals.buy += 2;
      analysis.push({ msg: `✅ EUR/KRW ${eur.toLocaleString()}원 — EU 지육 수입 비용 유리` });
    } else if (eur > base + 70) {
      signals.wait += 2;
      analysis.push({ msg: `⚠️ EUR/KRW ${eur.toLocaleString()}원 — EU 수입 비용 높음` });
    } else {
      analysis.push({ msg: `🔵 EUR/KRW ${eur.toLocaleString()}원 — 보통 수준` });
    }
  }

  if (lh) {
    if (lh < 72) {
      signals.buy += 3;
      analysis.push({ msg: `✅ CME Lean Hog ${lh}¢/lb — 역사적 저가. 지금 계약 후 2~3달 수령 시 가격 상승 전 매입` });
    } else if (lh < 85) {
      signals.buy += 1;
      analysis.push({ msg: `🟡 CME Lean Hog ${lh}¢/lb — 보통~저가. 괜찮은 진입 시점` });
    } else if (lh > 102) {
      signals.wait += 2;
      analysis.push({ msg: `⚠️ CME Lean Hog ${lh}¢/lb — 고가권. 조정 후 매입 검토` });
    } else {
      analysis.push({ msg: `🔵 CME Lean Hog ${lh}¢/lb — 보통 수준` });
    }
  }

  // 계절성
  const month = new Date().getMonth() + 1;
  const payMonth = ((month + 2 - 1) % 12) + 1;
  const seasonMsg = {
    1:'겨울 비수기 → 2~3월 수요 회복 전 선매입 유리',
    2:'봄 시즌 준비 → 3~4월 가격 상승 가능',
    3:'봄 수요 증가 → 선매입 유리',
    4:'황금연휴 수요 → 5~6월 성수기 진입',
    5:'여름 바베큐 수요 증가 → 6~7월 가격 상승 예상',
    6:'여름 성수기 진입 → 재고 확보 중요',
    7:'복날 특수 → 8월까지 강세 지속',
    8:'여름 성수기 마무리 → 추석 준비 시작',
    9:'추석 수요 → 10월 이후 하락 가능',
    10:'추석 이후 비수기 → 저가 매입 기회',
    11:'연말·김장 수요 → 12월 성수기 준비',
    12:'연말 성수기 → 설 명절 재고 선매입',
  };
  const paySeasonMsg = {
    1:'설 명절 성수기',2:'봄 수요 회복',3:'봄 성수기',
    4:'황금연휴 특수',5:'가정의달',6:'여름 시작',
    7:'복날 특수',8:'여름 성수기',9:'추석 수요',
    10:'추석 후 조정',11:'연말 성수기',12:'연말·설 준비',
  };

  analysis.push({ msg: `📅 현재 ${month}월: ${seasonMsg[month]}` });
  analysis.push({ msg: `🎯 결제 예정 ${payMonth}월: ${paySeasonMsg[payMonth]}` });

  // 수입 원가 계산
  const importCost = {};
  if (usd && lh) {
    const lhUsdPerKg = (lh * 0.022046) / 100;
    const totalUsdPerKg = lhUsdPerKg + 0.35; // 물류/관세 포함
    importCost.usdPerKg  = +totalUsdPerKg.toFixed(3);
    importCost.currentKrwPerKg  = Math.round(totalUsdPerKg * usd);
    importCost.forecastKrwPerKg = usdForecast.base ? Math.round(totalUsdPerKg * usdForecast.base) : null;
    importCost.diff = importCost.forecastKrwPerKg ? importCost.forecastKrwPerKg - importCost.currentKrwPerKg : null;
  }

  // 최종 판정
  let verdict, verdictClass;
  const net = signals.buy - signals.wait;
  if (net >= 3)      { verdict = '🟢 지금 계약 권장 — 환율·지육가 조건 우호적'; verdictClass = 'green'; }
  else if (net <= -2){ verdict = '🔴 계약 대기 권장 — 환율 또는 지육가 불리';   verdictClass = 'red'; }
  else if (net >= 1) { verdict = '🟡 조건부 매입 — 분할 계약 전략 추천';         verdictClass = 'yellow'; }
  else               { verdict = '🟡 중립 — 추세 확인 후 결정';                  verdictClass = 'yellow'; }

  return { verdict, verdictClass, analysis, trends: { usd: usdTrend, eur: eurTrend, lh: lhTrend }, forecasts: { usd: usdForecast, eur: eurForecast }, importCost, current: { usd, eur, lh }, signals };
}

// ════════════════════════════════════════════════════
// AI 프롬프트
// ════════════════════════════════════════════════════
function buildTimingPrompt(timing, current) {
  const { trends, forecasts, importCost } = timing;
  return `당신은 수안푸드(한국 냉동 돼지고기 지육 수입 전문업체)의 수석 구매 전략 분석가입니다.

【현재 시장 데이터 — ${kstNow()}】
- USD/KRW: ${current?.USDKRW?.price||'N/A'}원 | 30일 추세: ${trends.usd.dir} (${trends.usd.pct}%)
- EUR/KRW: ${current?.EURKRW?.price||'N/A'}원 | 30일 추세: ${trends.eur.dir} (${trends.eur.pct}%)
- CME Lean Hog: ${current?.LH?.price||'N/A'}¢/lb | 30일 추세: ${trends.lh.dir} (${trends.lh.pct}%)
- 국내 지육 도매가: ${current?.KAMIS?.price||'N/A'}원/kg

【2~3개월 후 예측】
- USD/KRW 예측 범위: ${forecasts.usd.low||'?'}~${forecasts.usd.high||'?'}원 (기준: ${forecasts.usd.base||'?'})
- EUR/KRW 예측 범위: ${forecasts.eur.low||'?'}~${forecasts.eur.high||'?'}원

【수입 원가 시뮬레이션】
- 현재 환율 기준 수입원가: ${importCost.currentKrwPerKg||'N/A'}원/kg
- 2~3개월 후 기준 수입원가: ${importCost.forecastKrwPerKg||'N/A'}원/kg
- 예상 차이: ${importCost.diff!=null?(importCost.diff>0?'+'+importCost.diff:importCost.diff)+'원/kg':'N/A'}

수안푸드 조건: 계약 후 2~3개월 뒤 선적·결제. 주요 수입국: 미국(USD), EU(EUR/USD).

분석 (한국어 Markdown, 700~900자):
### 1. 현재 수입 타이밍 판단
### 2. 2~3개월 후 환율 시나리오 (낙관/기본/비관)
### 3. 구체적 실행 전략
- 지금 계약 vs 대기
- 분할 계약 비율 제안
- 미국 vs EU 우선순위
### 4. 주요 리스크
`;
}

function buildPigPrompt(period, histData, current) {
  const label = {weekly:'주간',monthly:'월간',yearly:'연간'}[period]||period;
  const fmt = rows => (rows||[]).slice(-12).map(r=>`${ymdFromUnix(r.time)}: ${r.close}`).join(', ')||'없음';
  return `수안푸드 돼지고기 지육 수입 ${label} 분석

현재: LH ${current?.LH?.price||'?'}¢/lb, 국내도매가 ${current?.KAMIS?.price||'?'}원/kg, USD ${current?.USDKRW?.price||'?'}원, EUR ${current?.EURKRW?.price||'?'}원
LH 이력: ${fmt(histData.LH)}
옥수수: ${fmt(histData.ZC)}
대두: ${fmt(histData.ZS)}
국내도매가: ${fmt(histData.KAMIS)}

분석 (한국어 Markdown, 600~800자):
### 1. ${label} 지육가 동향
### 2. 사료 원료가 영향
### 3. 환율·수입 비용 종합
### 4. 매입 타이밍 권장
`;
}

function buildMarketPrompt(current) {
  const usdKrw = current?.USDKRW?.price || 1380;
  return `한국 냉동 수입 돼지고기 시장 전문 분석 (${kstNow()})
환율: USD/KRW ${usdKrw}원, EUR/KRW ${current?.EURKRW?.price||'N/A'}원

분석 (한국어 Markdown, 1000~1300자):
### 1. 2025~2026 냉동 돼지고기 수입 현황 (총량 및 전년 대비)
### 2. 국가별 수입 단가 비교 (USD/kg, 원화 환산)
### 3. 2025 vs 2026 수급 전망
### 4. 시장 주요 이슈 (ASF·관세·환율·소비트렌드)
### 5. 수안푸드 전략적 시사점
`;
}

// ════════════════════════════════════════════════════
// API 라우터
// ════════════════════════════════════════════════════
app.get('/api/version', (_, res) => res.json({ buildId: BUILD_ID, version: '3.1.0' }));

app.get('/api/current', async (_, res) => {
  try {
    const data = await getCurrentPrices();
    res.json({ ok: true, data, fetchedAt: kstNow() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  const sym    = (req.query.sym||'LH').toUpperCase();
  const period = req.query.period||'yearly';
  if (!['LH','ZC','ZS','KAMIS','USDKRW','EURKRW'].includes(sym))
    return res.status(400).json({ ok:false, error:'지원하지 않는 심볼' });
  try {
    const all  = await getHistory(sym);
    const rows = filterByPeriod(all, period);
    res.json({ ok:true, sym, period, rows, rangeLabel:rangeLabel(rows,period), total:rows.length });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});


// EU 공식 지육가 API
app.get('/api/eu-pig', async (_, res) => {
  try {
    const data = await fetchEuPigPrices();
    res.json({ ok: true, ...data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ★ 수입 타이밍 핵심 분석
app.get('/api/timing', async (_, res) => {
  try {
    const result = await analyzeImportTiming();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// AI 분석들
async function aiEndpoint(cacheKey, ttl, promptFn, res) {
  const hit = aCache.get(cacheKey);
  if (hit && Date.now()-hit.ts < ttl) return res.json({ analysis:hit.analysis, cached:true, model:hit.model });
  try {
    const prompt = await promptFn();
    const { text, model } = await callGemini(prompt);
    aCache.set(cacheKey, { analysis:text, ts:Date.now(), model });
    res.json({ analysis:text, cached:false, model });
  } catch (e) {
    res.json({ analysis:`⚠️ AI 분석 실패: ${e.message}`, fallback:true });
  }
}

app.get('/api/analysis/timing', async (_, res) => {
  await aiEndpoint('ai_t', 20*60000, async () => {
    const [timing, cur] = await Promise.all([analyzeImportTiming(), getCurrentPrices()]);
    return buildTimingPrompt(timing, cur);
  }, res);
});

app.get('/api/analysis/weekly', async (_, res) => {
  await aiEndpoint('ai_w', 30*60000, async () => {
    const [cur,lh,zc,zs,k] = await Promise.all([getCurrentPrices(), getHistory('LH').then(r=>filterByPeriod(r,'weekly')), getHistory('ZC').then(r=>filterByPeriod(r,'weekly')), getHistory('ZS').then(r=>filterByPeriod(r,'weekly')), getHistory('KAMIS').then(r=>filterByPeriod(r,'weekly'))]);
    return buildPigPrompt('weekly',{LH:lh,ZC:zc,ZS:zs,KAMIS:k},cur);
  }, res);
});

app.get('/api/analysis/monthly', async (_, res) => {
  await aiEndpoint('ai_m', 60*60000, async () => {
    const [cur,lh,zc,zs,k] = await Promise.all([getCurrentPrices(), getHistory('LH').then(r=>filterByPeriod(r,'monthly')), getHistory('ZC').then(r=>filterByPeriod(r,'monthly')), getHistory('ZS').then(r=>filterByPeriod(r,'monthly')), getHistory('KAMIS').then(r=>filterByPeriod(r,'monthly'))]);
    return buildPigPrompt('monthly',{LH:lh,ZC:zc,ZS:zs,KAMIS:k},cur);
  }, res);
});

app.get('/api/analysis/yearly', async (_, res) => {
  await aiEndpoint('ai_y', 3*3600000, async () => {
    const [cur,lh,zc,zs,k] = await Promise.all([getCurrentPrices(), getHistory('LH'), getHistory('ZC'), getHistory('ZS'), getHistory('KAMIS')]);
    return buildPigPrompt('yearly',{LH:lh.slice(-25),ZC:zc.slice(-15),ZS:zs.slice(-15),KAMIS:k.slice(-15)},cur);
  }, res);
});

app.get('/api/analysis/market', async (_, res) => {
  await aiEndpoint('ai_mkt', 6*3600000, async () => {
    const cur = await getCurrentPrices();
    return buildMarketPrompt(cur);
  }, res);
});

// ── 정적 파일 ─────────────────────────────────────────
app.get('/', (_, res) => res.redirect(302, '/pig'));
app.get('/pig', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/REPLACE_BUILD_ID/g, BUILD_ID);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(500).send('index.html 오류: ' + e.message); }
});
app.use(express.static(path.join(__dirname, 'public'), { index:false, etag:false, maxAge:0 }));
app.get('/health', (_, res) => res.json({ ok:true, version:'3.1.0', buildId:BUILD_ID, time:kstNow() }));

app.listen(PORT, () => {
  console.log(`🐷 수안푸드 v3.1 실행: http://localhost:${PORT}/pig`);
  // 백그라운드 프리로드 (실패해도 무시)
  setTimeout(() => {
    Promise.allSettled([
      getCurrentPrices(),
      getHistory('LH'), getHistory('ZC'), getHistory('ZS'),
      getHistory('KAMIS'), getHistory('USDKRW'), getHistory('EURKRW'),
    ]).then(rs => console.log(`✅ 프리로드: ${rs.filter(r=>r.status==='fulfilled').length}/${rs.length} 성공`));
  }, 2000);
});
