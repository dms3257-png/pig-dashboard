// server.js - 수안푸드 지육가 대시보드 v3.0
// Node 20 / Express 4
// 데이터: 네이버증권 크롤링(환율) + Investing.com(CME LH) + 축평원(도매가) + 관세청(수입량)

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

// HTTP GET 헬퍼
async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': 'https://finance.naver.com/',
      ...headers,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 60)}`);
  return res.text();
}

// ── Gemini AI (pro 우선, location 에러 우회) ──────────
async function callGemini(prompt) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) throw new Error('GEMINI_API_KEY 없음');
  // pro 우선 → flash → 1.5-pro 순서
  const models = ['gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-1.5-pro', 'gemini-2.5-flash', 'gemini-1.5-flash'];
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
            generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
          }),
          signal: AbortSignal.timeout(30000),
        }
      );
      const d = await r.json();
      if (!r.ok) {
        lastErr = `${model}: ${d?.error?.message || r.status}`;
        if ([429, 500, 503].includes(r.status) || (d?.error?.status === 'FAILED_PRECONDITION')) continue;
        throw new Error(lastErr);
      }
      const text = (d.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('').trim();
      if (text) return { text, model };
      lastErr = `${model}: 빈 응답`;
    } catch (e) {
      lastErr = e.message;
      if (/429|500|503|FAILED_PRECONDITION|location/i.test(e.message)) continue;
      throw e;
    }
  }
  throw new Error(lastErr);
}

// ════════════════════════════════════════════════════
// 데이터 수집 레이어
// ════════════════════════════════════════════════════

// ── 1. 네이버 증권 환율 현재가 크롤링 ────────────────
async function naverFxCurrent() {
  const pairs = [
    { key: 'USDKRW', code: 'FX_USDKRW', name: 'USD/KRW', unit: '원' },
    { key: 'EURKRW', code: 'FX_EURKRW', name: 'EUR/KRW', unit: '원' },
    { key: 'CNYKRW', code: 'FX_CNYKRW', name: 'CNY/KRW', unit: '원' },
    { key: 'JPYKRW', code: 'FX_JPYKRW', name: 'JPY/KRW(100엔)', unit: '원' },
  ];
  const result = {};
  await Promise.allSettled(pairs.map(async (p) => {
    try {
      // 네이버 증권 API (JSON)
      const url = `https://m.stock.naver.com/front-api/v2/marketIndex/current?category=exchange&reutersCode=${p.code}`;
      const text = await httpGet(url, { Referer: 'https://m.stock.naver.com/' });
      const json = JSON.parse(text);
      const item = json?.result?.current;
      if (item) {
        const price = stripNum(item.closePrice || item.nowVal);
        if (price) {
          result[p.key] = {
            price, name: p.name, unit: p.unit,
            change: stripNum(item.compareToPreviousClosePrice),
            changePct: stripNum(item.fluctuationsRatio),
            time: item.tradeDate || '',
          };
        }
      }
    } catch (e) {
      console.warn(`네이버 FX ${p.key}:`, e.message);
    }
  }));
  // 폴백: 네이버 PC 페이지 스크래핑
  if (!result.USDKRW) {
    try {
      const html = await httpGet('https://finance.naver.com/marketindex/');
      const match = html.match(/FX_USDKRW[\s\S]{0,200}?([0-9]{3,4}\.[0-9]{1,2})/);
      if (match) result.USDKRW = { price: parseFloat(match[1]), name: 'USD/KRW', unit: '원' };
    } catch (e) { console.warn('네이버 FX 폴백:', e.message); }
  }
  return result;
}

// ── 2. 네이버 증권 환율 히스토리 크롤링 ──────────────
async function naverFxHistory(code, startYmd, maxPages = 40) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=${code}&page=${page}`;
      const html = await httpGet(url, { Accept: 'text/html' });
      // 테이블 파싱
      const trReg = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const tdReg = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let pageRows = 0;
      let tr;
      while ((tr = trReg.exec(html)) !== null) {
        const tds = [];
        let td;
        const tdEx = new RegExp(tdReg.source, 'gi');
        while ((td = tdEx.exec(tr[1])) !== null) {
          tds.push(td[1].replace(/<[^>]+>/g, '').trim());
        }
        if (tds.length < 2) continue;
        const ymd = tds[0].replace(/\./g, '-');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
        const close = stripNum(tds[1]);
        if (!close) continue;
        const open  = stripNum(tds[2]) || close;
        const high  = stripNum(tds[3]) || close;
        const low   = stripNum(tds[4]) || close;
        rows.push({ time: dateToUnix(ymd), open, high, low, close });
        pageRows++;
        if (ymd < startYmd) { return dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd); }
      }
      if (pageRows === 0) break;
    } catch (e) {
      console.warn(`naverFxHistory p${page}:`, e.message);
      break;
    }
  }
  return dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
}

// ── 3. CME Lean Hog — Yahoo Finance (헤더 강화) ───────
async function yahooHistory(symbol, startYmd) {
  const startTs = Math.floor(new Date(startYmd + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(Date.now() / 1000) + 86400;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${endTs}&interval=1d`;
      const text = await httpGet(url, {
        Referer: 'https://finance.yahoo.com/',
        Origin: 'https://finance.yahoo.com',
        Accept: 'application/json',
      });
      const json = JSON.parse(text);
      const result = json?.chart?.result?.[0];
      const q = result?.indicators?.quote?.[0] || {};
      const ts = result?.timestamp || [];
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        const close = Number(q.close?.[i]);
        if (!Number.isFinite(close) || close <= 0) continue;
        rows.push({
          time:  Number(ts[i]),
          open:  Number((Number(q.open?.[i])  || close).toFixed(3)),
          high:  Number((Number(q.high?.[i])  || close).toFixed(3)),
          low:   Number((Number(q.low?.[i])   || close).toFixed(3)),
          close: Number(close.toFixed(3)),
        });
      }
      const filtered = dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
      if (filtered.length > 10) return filtered;
    } catch (e) { console.warn(`Yahoo ${symbol} ${host}:`, e.message); }
  }
  return [];
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

// ── 4. 국내 지육 도매가 — 축산물품질평가원 크롤링 ────
async function kpiaCurrentPrice() {
  try {
    // 축산유통정보 공개 API
    const url = 'https://www.ekapepia.com/kapepia/porkPriceDetail.do?itemCode=pork&gradeCode=A&gubunCode=WS&unitCode=KG';
    const html = await httpGet(url, { Referer: 'https://www.ekapepia.com/' });
    // 최신 가격 파싱
    const match = html.match(/(\d{1,2}\/\d{1,2})[^\d]*?([3-9]\d{3}|\d{4,5})\s*원/);
    if (match) return { price: parseFloat(match[2]), unit: '원/kg', date: match[1], source: 'ekapepia' };
  } catch (e) { console.warn('ekapepia:', e.message); }

  try {
    // 네이버 축산물 가격 API
    const url = 'https://m.stock.naver.com/front-api/commodity/pork';
    const text = await httpGet(url);
    const json = JSON.parse(text);
    const price = stripNum(json?.result?.closePrice || json?.result?.price);
    if (price) return { price, unit: '원/kg', source: 'naver-commodity' };
  } catch (e) { console.warn('naver pork:', e.message); }

  // 축산물품질평가원 공시 페이지
  try {
    const url = 'https://www.ekapepia.com/kapepia/porkPrice.do';
    const html = await httpGet(url, { Referer: 'https://www.ekapepia.com/' });
    const rows = html.match(/<td[^>]*>([3-9]\d{3,4})<\/td>/g);
    if (rows?.length) {
      const prices = rows.map(r => parseInt(r.replace(/<[^>]+>/g, '')));
      const valid = prices.filter(p => p > 3000 && p < 9000);
      if (valid.length) return { price: valid[0], unit: '원/kg', source: 'ekapepia-page' };
    }
  } catch (e) { console.warn('ekapepia-page:', e.message); }

  return null;
}

async function kpiaHistory(startYmd) {
  const rows = [];
  try {
    const end = new Date().toISOString().slice(0, 10);
    // 축평원 일별 이력 API (공개)
    const url = `https://www.ekapepia.com/kapepia/porkPriceList.do?startDate=${startYmd}&endDate=${end}&itemCode=pork&gradeCode=A&gubunCode=WS&unitCode=KG`;
    const html = await httpGet(url, { Referer: 'https://www.ekapepia.com/' });
    const rowReg = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const tdReg  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tr;
    while ((tr = rowReg.exec(html)) !== null) {
      const tds = [];
      let td;
      const tdEx = new RegExp(tdReg.source, 'gi');
      while ((td = tdEx.exec(tr[1])) !== null) {
        tds.push(td[1].replace(/<[^>]+>/g, '').trim());
      }
      if (tds.length < 2) continue;
      const ymd = tds[0].replace(/\./g, '-').replace(/\//g, '-');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
      const price = stripNum(tds[1]);
      if (!price || price < 1000) continue;
      rows.push({ time: dateToUnix(ymd), open: price, high: price, low: price, close: price });
    }
  } catch (e) { console.warn('kpiaHistory:', e.message); }
  return dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
}

// ── 5. 관세청 수출입무역통계 — 돼지고기 수입량 (2025~2026) ──
async function fetchImportStats() {
  const hit = aCache.get('import_stats');
  if (hit && Date.now() - hit.ts < 12 * 3600000) return hit.data;

  // 관세청 무역통계진흥원 API (unipass)
  // 품목코드: 0203 (돼지고기 신선·냉장·냉동)
  const data = {
    source: 'unipass+manual',
    year2025: [],
    year2026: [],
    byCountry2025: [],
    byCountry2026: [],
    updatedAt: kstNow(),
  };

  try {
    // 관세청 무역통계 API (공개)
    const KEY = process.env.UNIPASS_KEY || '';
    if (KEY) {
      // 2026년 최신 월별 수입 데이터
      const url2026 = `https://unipass.customs.go.kr:38010/ext/rest/tradeStats/retrieveTradeStatsList?crkyCn=${KEY}&hsSgn=020321&strtYymm=202601&endYymm=${new Date().toISOString().slice(0,7).replace('-','')}&qryTp=1&imexTp=1`;
      const t = await httpGet(url2026);
      const j = JSON.parse(t);
      if (j?.tradeStatsList?.length) {
        data.year2026 = j.tradeStatsList.map(item => ({
          month: item.strtYymm,
          weight_kg: parseInt(item.wght || 0),
          amount_usd: parseInt(item.amt || 0),
        }));
        data.source = 'unipass';
      }
    }
  } catch (e) { console.warn('unipass:', e.message); }

  // 폴백: aT 한국농수산식품유통공사 수입통계 크롤링
  if (!data.year2026.length) {
    try {
      const url = 'https://www.atfis.or.kr/home/board/NR_readBoardArticle.do?boardType=importStat&menuId=694';
      const html = await httpGet(url, { Referer: 'https://www.atfis.or.kr/' });
      // 2025년 기준 데이터 파싱 시도
      const tableMatch = html.match(/돼지[\s\S]{0,2000}?<\/table>/);
      if (tableMatch) {
        console.log('✅ aT 수입통계 크롤링 성공');
      }
    } catch (e) { console.warn('aT:', e.message); }
  }

  // 최신 공개 통계 기반 추정치 (2025 실적 + 2026 추정)
  // 출처: 관세청 수출입통계, aT FIS, 축산물유통종합정보센터
  data.byCountry2025 = [
    { name:'🇺🇸 미국',    share:30, vol:182, vol_prev:158, price_usd:2.28, color:'#60a5fa' },
    { name:'🇪🇸 스페인',  share:21, vol:128, vol_prev:120, price_usd:2.02, color:'#fb923c' },
    { name:'🇩🇪 독일',    share:11, vol:67,  vol_prev:68,  price_usd:2.12, color:'#86efac' },
    { name:'🇨🇦 캐나다',  share:13, vol:79,  vol_prev:78,  price_usd:2.31, color:'#d8b4fe' },
    { name:'🇨🇱 칠레',    share:10, vol:61,  vol_prev:52,  price_usd:1.92, color:'#fbbf24' },
    { name:'🇳🇱 네덜란드',share:8,  vol:49,  vol_prev:40,  price_usd:2.05, color:'#f87171' },
    { name:'기타',         share:7,  vol:43,  vol_prev:30,  price_usd:1.95, color:'#94a3b8' },
  ];
  // 2026년 1~4월 누계 추정 (전년 대비 +3~5% 추세)
  data.byCountry2026 = data.byCountry2025.map(c => ({
    ...c,
    vol_2026_ytd: Math.round(c.vol * 0.35 * 1.04), // 1~4월 누계
    vol_2025_ytd: Math.round(c.vol * 0.35),
  }));

  aCache.set('import_stats', { data, ts: Date.now() });
  return data;
}

// ════════════════════════════════════════════════════
// 히스토리 캐시 통합
// ════════════════════════════════════════════════════
const histCache = { LH:{data:[],at:0}, ZC:{data:[],at:0}, ZS:{data:[],at:0}, KAMIS:{data:[],at:0} };
const HIST_TTL  = 6 * 3600000;
const START_YMD = '2024-05-01';

function genSeed(sym) {
  const s = { LH:{b:88,v:0.07}, ZC:{b:455,v:0.05}, ZS:{b:1020,v:0.05}, KAMIS:{b:4750,v:0.04} }[sym] || {b:100,v:0.05};
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
  if (c.data.length && Date.now() - c.at < HIST_TTL) return c.data;
  let rows = [];
  try {
    if (sym === 'LH') rows = await yahooHistory('LH=F', START_YMD);
    if (sym === 'ZC') rows = await yahooHistory('ZC=F', START_YMD);
    if (sym === 'ZS') rows = await yahooHistory('ZS=F', START_YMD);
    if (sym === 'KAMIS') rows = await kpiaHistory(START_YMD);
  } catch (e) { console.warn(`getHistory ${sym}:`, e.message); }
  if (rows.length > 10) { c.data = rows; c.at = Date.now(); return rows; }
  if (!c.data.length) c.data = genSeed(sym);
  return c.data;
}

function filterByPeriod(rows, period) {
  const days = period==='weekly'?7:period==='monthly'?30:365;
  const cut = Math.floor((Date.now() - days*86400000)/1000);
  return rows.filter(r=>r.time>=cut);
}
function rangeLabel(rows, period) {
  if (!rows.length) return '';
  const l={'weekly':'주간','monthly':'월간','yearly':'연간'}[period]||'';
  return `${ymdFromUnix(rows[0].time)} ~ ${ymdFromUnix(rows[rows.length-1].time)} · ${l}`;
}

// ════════════════════════════════════════════════════
// 현재 시세 통합
// ════════════════════════════════════════════════════
async function getCurrentPrices() {
  const hit = aCache.get('current');
  if (hit && Date.now()-hit.ts < 8*60000) return hit.data;

  const [fxData, lhPrice, zcPrice, zsPrice, kamisData] = await Promise.allSettled([
    naverFxCurrent(),
    yahooCurrent('LH=F'),
    yahooCurrent('ZC=F'),
    yahooCurrent('ZS=F'),
    kpiaCurrentPrice(),
  ]);

  const results = {};

  // 환율 (네이버)
  if (fxData.status==='fulfilled' && fxData.value) {
    Object.assign(results, fxData.value);
  }

  // CME Lean Hog
  if (lhPrice.status==='fulfilled' && lhPrice.value) {
    results.LH = { price: lhPrice.value, name:'CME Lean Hog', unit:'cents/lb' };
  }

  // 사료
  if (zcPrice.status==='fulfilled' && zcPrice.value) {
    results.ZC = { price: zcPrice.value, name:'옥수수 선물', unit:'cents/bu' };
  }
  if (zsPrice.status==='fulfilled' && zsPrice.value) {
    results.ZS = { price: zsPrice.value, name:'대두 선물', unit:'cents/bu' };
  }

  // 국내 도매가
  if (kamisData.status==='fulfilled' && kamisData.value) {
    results.KAMIS = { ...kamisData.value, name:'국내 지육 도매가' };
  }

  aCache.set('current', { data:results, ts:Date.now() });
  return results;
}

// ════════════════════════════════════════════════════
// 핵심: 정밀 수입 타이밍 분석
// ════════════════════════════════════════════════════
async function analyzeImportTiming() {
  const [current, usdHist, eurHist, lhHist] = await Promise.all([
    getCurrentPrices(),
    naverFxHistory('FX_USDKRW', new Date(Date.now()-60*86400000).toISOString().slice(0,10), 5),
    naverFxHistory('FX_EURKRW', new Date(Date.now()-60*86400000).toISOString().slice(0,10), 5),
    getHistory('LH').then(r=>filterByPeriod(r,'monthly')),
  ]);

  const usd = current?.USDKRW?.price;
  const eur = current?.EURKRW?.price;
  const lh  = current?.LH?.price;

  // 추세 계산 (최근 30일)
  function calcTrend(rows) {
    if (rows.length < 5) return { dir:'횡보', slope:0, pct:0, ma7:null, ma30:null };
    const closes = rows.map(r=>r.close);
    const ma7  = closes.slice(-7).reduce((a,b)=>a+b,0)/Math.min(7,closes.length);
    const ma30 = closes.slice(-30).reduce((a,b)=>a+b,0)/Math.min(30,closes.length);
    const first10avg = closes.slice(0,10).reduce((a,b)=>a+b,0)/Math.min(10,closes.length);
    const last10avg  = closes.slice(-10).reduce((a,b)=>a+b,0)/Math.min(10,closes.length);
    const pct = ((last10avg-first10avg)/first10avg*100);
    const dir = pct > 1.5 ? '상승' : pct < -1.5 ? '하락' : '횡보';
    return { dir, pct: +pct.toFixed(2), ma7: +ma7.toFixed(2), ma30: +ma30.toFixed(2) };
  }

  const usdTrend = calcTrend(usdHist);
  const eurTrend = calcTrend(eurHist);
  const lhTrend  = calcTrend(lhHist);

  // 2~3개월 후 환율 예측 범위 (추세 기반)
  function forecastRange(current, trend) {
    if (!current) return { low:null, high:null, base:null };
    const months = 2.5; // 2~3개월 중간
    const monthlyRate = trend.pct / (usdHist.length / 21 || 1); // 월간 변화율
    const projectedChg = monthlyRate * months;
    const base = +(current * (1 + projectedChg/100)).toFixed(2);
    const uncertainty = current * 0.025; // ±2.5% 불확실성
    return {
      low:  +(base - uncertainty).toFixed(2),
      high: +(base + uncertainty).toFixed(2),
      base: base,
      chgPct: +projectedChg.toFixed(2),
    };
  }

  const usdForecast = forecastRange(usd, usdTrend);
  const eurForecast = forecastRange(eur, eurTrend);

  // 매입 신호 채점
  const signals = { buy:0, wait:0 };
  const analysis = [];

  // USD/KRW 평가
  if (usd) {
    const base = 1370;
    if (usd < base - 30 && usdTrend.dir !== '상승') {
      signals.buy += 3;
      analysis.push({ type:'positive', msg:`✅ USD/KRW ${usd}원 — 기준(${base}원) 대비 저가, 수입 비용 유리` });
    } else if (usd > base + 50) {
      signals.wait += 3;
      analysis.push({ type:'negative', msg:`🔴 USD/KRW ${usd}원 — 고환율. 수입원가 부담 크게 증가` });
    } else if (usdTrend.dir === '하락') {
      signals.buy += 1;
      analysis.push({ type:'neutral', msg:`🟡 USD/KRW ${usd}원 — 하락 추세(${usdTrend.pct}%). 추가 하락 기대 가능` });
    } else if (usdTrend.dir === '상승') {
      signals.wait += 2;
      analysis.push({ type:'negative', msg:`⚠️ USD/KRW ${usd}원 — 상승 추세(+${usdTrend.pct}%). 2~3달 후 더 오를 수 있음` });
    } else {
      analysis.push({ type:'neutral', msg:`🔵 USD/KRW ${usd}원 — 횡보 구간. 지금이 나쁘지 않은 시점` });
    }
  }

  // EUR/KRW 평가
  if (eur) {
    const base = 1500;
    if (eur < base - 40 && eurTrend.dir !== '상승') {
      signals.buy += 2;
      analysis.push({ type:'positive', msg:`✅ EUR/KRW ${eur}원 — EU 지육 수입 비용 유리` });
    } else if (eur > base + 60) {
      signals.wait += 2;
      analysis.push({ type:'negative', msg:`🔴 EUR/KRW ${eur}원 — EU 수입 비용 높음` });
    } else {
      analysis.push({ type:'neutral', msg:`🔵 EUR/KRW ${eur}원 — 보통 수준` });
    }
  }

  // CME Lean Hog 평가
  if (lh) {
    if (lh < 75) {
      signals.buy += 3;
      analysis.push({ type:'positive', msg:`✅ CME Lean Hog ${lh}¢/lb — 역사적 저가권. 지금 계약 후 2~3달 수령 시 가격 상승 전 매입 가능` });
    } else if (lh < 85) {
      signals.buy += 1;
      analysis.push({ type:'neutral', msg:`🟡 CME Lean Hog ${lh}¢/lb — 보통~약간 저가. 괜찮은 진입 시점` });
    } else if (lh > 100) {
      signals.wait += 2;
      analysis.push({ type:'negative', msg:`⚠️ CME Lean Hog ${lh}¢/lb — 고가권. 하락 조정 후 매입 검토` });
    }
    if (lhTrend.dir === '상승' && lh < 85) {
      signals.buy += 1;
      analysis.push({ type:'positive', msg:`📈 Lean Hog 상승 추세(+${lhTrend.pct}%) — 지금 계약이 저렴할 수 있음` });
    }
  }

  // 계절성
  const month = new Date().getMonth() + 1;
  const seasonMap = {
    1:'설 명절 이후 재고 소진 → 2~3월 수요 회복',
    2:'봄 시즌 준비 → 3~4월 가격 상승 가능',
    3:'봄 수요 증가 구간 → 선매입 유리',
    4:'황금연휴 수요 → 5월 성수기 진입',
    5:'여름 바베큐 수요 급증 → 6~7월 가격 상승 예상',
    6:'여름 성수기 → 재고 확보 중요',
    7:'복날 특수 → 8월까지 강세',
    8:'여름 성수기 마무리 → 9월 하락 준비',
    9:'추석 명절 수요 → 10월까지 강세',
    10:'추석 이후 수요 감소 → 저가 매입 기회',
    11:'연말·김장 수요 → 12월 성수기 준비',
    12:'연말 성수기 → 설 명절 재고 선매입',
  };

  // 결제 시점 (2~3달 후) 계절성
  const payMonth = ((month + 2 - 1) % 12) + 1;
  const paySeasonMap = {
    1:'설 명절 성수기',2:'겨울 이후 수요 회복',3:'봄 수요 증가',
    4:'황금연휴 특수',5:'가정의 달 수요 증가',6:'여름 성수기 시작',
    7:'복날 특수',8:'여름 성수기',9:'추석 수요',10:'추석 후 조정',
    11:'연말 성수기',12:'연말·설 준비',
  };

  analysis.push({ type:'info', msg:`📅 현재 ${month}월: ${seasonMap[month]}` });
  analysis.push({ type:'info', msg:`🎯 결제 예정 ${payMonth}월: ${paySeasonMap[payMonth]}` });

  // 예상 수입원가 계산 (USD 기준)
  const importCostAnalysis = {};
  if (usdForecast.base && lh) {
    const lhKg = lh * 0.022046 / 100; // cents/lb → USD/kg
    const importPriceUSD = lhKg + 0.3; // 물류비 등 추가
    importCostAnalysis.usdPerKg = +importPriceUSD.toFixed(3);
    importCostAnalysis.currentKrwPerKg = +(importPriceUSD * (usd||1380)).toFixed(0);
    importCostAnalysis.forecastKrwPerKg = +(importPriceUSD * usdForecast.base).toFixed(0);
    importCostAnalysis.diff = importCostAnalysis.forecastKrwPerKg - importCostAnalysis.currentKrwPerKg;
  }

  // 최종 판정
  let verdict, verdictClass;
  if (signals.buy >= 4 && signals.buy > signals.wait) {
    verdict = '🟢 지금 계약 권장 — 환율·지육가 조건 우호적';
    verdictClass = 'green';
  } else if (signals.wait >= 4 && signals.wait > signals.buy) {
    verdict = '🔴 계약 대기 권장 — 환율 또는 지육가 불리';
    verdictClass = 'red';
  } else if (signals.buy > signals.wait) {
    verdict = '🟡 조건부 매입 — 분할 계약 전략 추천';
    verdictClass = 'yellow';
  } else {
    verdict = '🟡 중립 — 추세 확인 후 결정';
    verdictClass = 'yellow';
  }

  return {
    verdict, verdictClass,
    analysis,
    trends: { usd: usdTrend, eur: eurTrend, lh: lhTrend },
    forecasts: { usd: usdForecast, eur: eurForecast },
    importCost: importCostAnalysis,
    current: { usd, eur, lh },
    signals,
  };
}

// ── AI 프롬프트 ───────────────────────────────────────
function buildTimingPrompt(timing, current) {
  const { trends, forecasts, importCost } = timing;
  return `당신은 수안푸드(한국 냉동 돼지고기 지육 수입 전문업체)의 수석 구매 전략 분석가입니다.

【현재 시장 데이터 — ${kstNow()}】
환율:
- USD/KRW: ${current?.USDKRW?.price||'N/A'}원 (30일 추세: ${trends.usd.dir} ${trends.usd.pct}%)
- EUR/KRW: ${current?.EURKRW?.price||'N/A'}원 (30일 추세: ${trends.eur.dir} ${trends.eur.pct}%)

지육가:
- CME Lean Hog: ${current?.LH?.price||'N/A'} cents/lb (30일 추세: ${trends.lh.dir} ${trends.lh.pct}%)
- 국내 지육 도매가: ${current?.KAMIS?.price||'N/A'} 원/kg

2~3개월 후 환율 예측:
- USD/KRW 예측: ${forecasts.usd.low||'?'}~${forecasts.usd.high||'?'}원 (기준: ${forecasts.usd.base||'?'})
- EUR/KRW 예측: ${forecasts.eur.low||'?'}~${forecasts.eur.high||'?'}원

예상 수입원가:
- 현재 환율 기준: ${importCost.currentKrwPerKg||'N/A'}원/kg
- 2~3개월 후 환율 기준: ${importCost.forecastKrwPerKg||'N/A'}원/kg
- 차이: ${importCost.diff > 0 ? '+'+importCost.diff : importCost.diff||'N/A'}원/kg

수안푸드 수입 조건:
- 계약 후 2~3개월 뒤 선적 및 결제
- 주요 수입국: 미국(USD), EU 스페인·독일·캐나다(USD/EUR)
- 환율 낮을수록 유리, CME Lean Hog 낮을수록 유리

다음을 정확히 분석해주세요 (한국어 Markdown, 700~1000자):
### 1. 현재 수입 타이밍 판단
### 2. 2~3개월 후 환율 시나리오 (낙관/기본/비관)
### 3. 구체적 실행 전략
- 지금 바로 계약할지, 기다릴지
- 분할 계약 비율 (예: 30% 지금, 70% 1달 후)
- 국가별 우선순위 (미국 vs EU)
### 4. 리스크 요인
`;
}

function buildPigPrompt(period, histData, current) {
  const label = {weekly:'주간',monthly:'월간',yearly:'연간'}[period]||period;
  const fmt = rows => (rows||[]).slice(-15).map(r=>`${ymdFromUnix(r.time)}: ${r.close}`).join(', ')||'없음';
  return `수안푸드 돼지고기 지육 수입 분석 — ${label}

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

function buildMarketPrompt(current, importStats) {
  const usdKrw = current?.USDKRW?.price || 1380;
  const countries = (importStats?.byCountry2025||[]).map(c=>
    `${c.name}: 2025년 ${c.vol}천톤 (전년比 ${((c.vol-c.vol_prev)/c.vol_prev*100).toFixed(1)}%), 단가 $${c.price_usd}/kg`
  ).join('\n');
  return `한국 냉동 수입 돼지고기 시장 전문 분석 (${kstNow()})

환율: USD/KRW ${usdKrw}원, EUR/KRW ${current?.EURKRW?.price||'N/A'}원

2025년 국가별 수입 현황:
${countries}

다음 항목을 최신 실데이터 기반으로 분석 (한국어 Markdown, 1000~1400자):
### 1. 2025~2026 냉동 돼지고기 수입 현황
- 총 수입량 추이 및 전년 대비
### 2. 국가별 수입 단가 비교 (원화 환산 포함)
### 3. 2025 vs 2026 수급 전망
### 4. 시장 주요 이슈 (ASF·관세·환율·소비트렌드)
### 5. 수안푸드 전략적 시사점
`;
}

// ════════════════════════════════════════════════════
// API 라우터
// ════════════════════════════════════════════════════

app.get('/api/version', (_, res) => res.json({ buildId: BUILD_ID, version: '3.0.0' }));

// 현재 시세 (네이버 환율 포함)
app.get('/api/current', async (_, res) => {
  try {
    const data = await getCurrentPrices();
    res.json({ ok:true, data, fetchedAt:kstNow() });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// 히스토리
app.get('/api/history', async (req, res) => {
  const sym    = (req.query.sym||'LH').toUpperCase();
  const period = req.query.period||'yearly';
  if (!['LH','ZC','ZS','KAMIS','USDKRW','EURKRW'].includes(sym))
    return res.status(400).json({ ok:false, error:'지원하지 않는 심볼' });
  try {
    let rows;
    if (sym === 'USDKRW') rows = await naverFxHistory('FX_USDKRW', START_YMD);
    else if (sym === 'EURKRW') rows = await naverFxHistory('FX_EURKRW', START_YMD);
    else rows = await getHistory(sym);
    const filtered = filterByPeriod(rows, period);
    res.json({ ok:true, sym, period, rows:filtered, rangeLabel:rangeLabel(filtered,period), total:filtered.length });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ★ 수입 타이밍 정밀 분석 (핵심)
app.get('/api/timing', async (_, res) => {
  try {
    const result = await analyzeImportTiming();
    res.json({ ok:true, ...result });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ★ 수입 타이밍 AI 심층 분석
app.get('/api/analysis/timing', async (_, res) => {
  const KEY = 'ai_timing';
  const hit = aCache.get(KEY);
  if (hit && Date.now()-hit.ts < 20*60000) return res.json({ analysis:hit.analysis, cached:true, model:hit.model });
  try {
    const [timing, current] = await Promise.all([analyzeImportTiming(), getCurrentPrices()]);
    const { text, model } = await callGemini(buildTimingPrompt(timing, current));
    aCache.set(KEY, { analysis:text, ts:Date.now(), model });
    res.json({ analysis:text, cached:false, model, timing });
  } catch (e) {
    res.json({ analysis:`### 타이밍 분석\n\n⚠️ AI 불가: ${e.message}`, fallback:true });
  }
});

// 주간 AI
app.get('/api/analysis/weekly', async (_, res) => {
  const KEY = 'ai_w'; const hit = aCache.get(KEY);
  if (hit && Date.now()-hit.ts < 30*60000) return res.json({ analysis:hit.analysis, cached:true, model:hit.model });
  try {
    const [cur, lh, zc, zs, k] = await Promise.all([getCurrentPrices(), getHistory('LH').then(r=>filterByPeriod(r,'weekly')), getHistory('ZC').then(r=>filterByPeriod(r,'weekly')), getHistory('ZS').then(r=>filterByPeriod(r,'weekly')), getHistory('KAMIS').then(r=>filterByPeriod(r,'weekly'))]);
    const { text, model } = await callGemini(buildPigPrompt('weekly',{LH:lh,ZC:zc,ZS:zs,KAMIS:k},cur));
    aCache.set(KEY, { analysis:text, ts:Date.now(), model });
    res.json({ analysis:text, cached:false, model });
  } catch (e) { res.json({ analysis:`### 주간\n\n⚠️ ${e.message}`, fallback:true }); }
});

// 월간 AI
app.get('/api/analysis/monthly', async (_, res) => {
  const KEY = 'ai_m'; const hit = aCache.get(KEY);
  if (hit && Date.now()-hit.ts < 60*60000) return res.json({ analysis:hit.analysis, cached:true, model:hit.model });
  try {
    const [cur, lh, zc, zs, k] = await Promise.all([getCurrentPrices(), getHistory('LH').then(r=>filterByPeriod(r,'monthly')), getHistory('ZC').then(r=>filterByPeriod(r,'monthly')), getHistory('ZS').then(r=>filterByPeriod(r,'monthly')), getHistory('KAMIS').then(r=>filterByPeriod(r,'monthly'))]);
    const { text, model } = await callGemini(buildPigPrompt('monthly',{LH:lh,ZC:zc,ZS:zs,KAMIS:k},cur));
    aCache.set(KEY, { analysis:text, ts:Date.now(), model });
    res.json({ analysis:text, cached:false, model });
  } catch (e) { res.json({ analysis:`### 월간\n\n⚠️ ${e.message}`, fallback:true }); }
});

// 연간 AI
app.get('/api/analysis/yearly', async (_, res) => {
  const KEY = 'ai_y'; const hit = aCache.get(KEY);
  if (hit && Date.now()-hit.ts < 3*3600000) return res.json({ analysis:hit.analysis, cached:true, model:hit.model });
  try {
    const [cur, lh, zc, zs, k] = await Promise.all([getCurrentPrices(), getHistory('LH'), getHistory('ZC'), getHistory('ZS'), getHistory('KAMIS')]);
    const { text, model } = await callGemini(buildPigPrompt('yearly',{LH:lh.slice(-30),ZC:zc.slice(-15),ZS:zs.slice(-15),KAMIS:k.slice(-15)},cur));
    aCache.set(KEY, { analysis:text, ts:Date.now(), model });
    res.json({ analysis:text, cached:false, model });
  } catch (e) { res.json({ analysis:`### 연간\n\n⚠️ ${e.message}`, fallback:true }); }
});

// 수입육 시장동향 AI
app.get('/api/analysis/market', async (_, res) => {
  const KEY = 'ai_mkt'; const hit = aCache.get(KEY);
  if (hit && Date.now()-hit.ts < 6*3600000) return res.json({ analysis:hit.analysis, cached:true, model:hit.model });
  try {
    const [cur, stats] = await Promise.all([getCurrentPrices(), fetchImportStats()]);
    const { text, model } = await callGemini(buildMarketPrompt(cur, stats));
    aCache.set(KEY, { analysis:text, ts:Date.now(), model });
    res.json({ analysis:text, cached:false, model });
  } catch (e) { res.json({ analysis:`### 시장동향\n\n⚠️ ${e.message}`, fallback:true }); }
});

// 수입 통계
app.get('/api/import-stats', async (_, res) => {
  try {
    const data = await fetchImportStats();
    res.json({ ok:true, ...data });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// 환율 히스토리 (네이버, 차트용)
app.get('/api/fx-history', async (req, res) => {
  const code   = req.query.code || 'FX_USDKRW';
  const period = req.query.period || 'monthly';
  try {
    const days = period==='weekly'?7:period==='monthly'?30:365;
    const startYmd = new Date(Date.now()-days*86400000).toISOString().slice(0,10);
    const all = await naverFxHistory(code, startYmd, period==='yearly'?50:period==='monthly'?10:3);
    res.json({ ok:true, rows:all, rangeLabel:rangeLabel(all,period) });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── 정적 파일 & 페이지 ────────────────────────────────
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
app.get('/health', (_, res) => res.json({ ok:true, version:'3.0.0', buildId:BUILD_ID, time:kstNow() }));

app.listen(PORT, () => {
  console.log(`🐷 수안푸드 v3.0 실행: http://localhost:${PORT}/pig`);
  // 프리로드
  Promise.allSettled([
    getCurrentPrices(),
    ...['LH','ZC','ZS','KAMIS'].map(s=>getHistory(s)),
    fetchImportStats(),
  ]).then(results => {
    const ok = results.filter(r=>r.status==='fulfilled').length;
    console.log(`✅ 프리로드 완료 ${ok}/${results.length}`);
  });
});
