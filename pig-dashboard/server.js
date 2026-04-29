// server.js - 수안푸드 지육가 대시보드 v2.0
// Node 20 / Express 4

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

// ── Gemini AI ─────────────────────────────────────────
async function callGemini(prompt, models = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) throw new Error('GEMINI_API_KEY 환경변수 없음');
  let lastError = 'Gemini 호출 실패';
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        const msg = `${model} HTTP ${r.status}${detail ? ': ' + detail.slice(0, 160) : ''}`;
        if (r.status === 429 || r.status >= 500) { lastError = msg; continue; }
        throw new Error(msg);
      }
      const d = await r.json();
      const text = (d.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('').trim();
      if (text) return { text, model };
      lastError = `${model} 응답 비어있음`;
    } catch (err) {
      lastError = err.message || String(err);
      if (lastError.includes('429') || lastError.includes('500')) continue;
      throw err;
    }
  }
  throw new Error(lastError);
}

// ── Yahoo Finance 히스토리 (헤더 강화) ───────────────
async function fetchYahooHistory(symbol, startYmd) {
  const startTs = Math.floor(new Date(startYmd + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(Date.now() / 1000) + 86400;

  // Yahoo v8 API 시도
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${endTs}&interval=1d&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${endTs}&interval=1d&includePrePost=false`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://finance.yahoo.com/',
          'Origin': 'https://finance.yahoo.com',
        }
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const quote  = result?.indicators?.quote?.[0] || {};
      const timestamps = result?.timestamp || [];
      const rows = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = Number(quote.close?.[i]);
        if (!Number.isFinite(close) || close <= 0) continue;
        const open  = Number(quote.open?.[i])  || close;
        const high  = Number(quote.high?.[i])  || close;
        const low   = Number(quote.low?.[i])   || close;
        rows.push({
          time:  Number(timestamps[i]),
          open:  Number(open.toFixed(3)),
          high:  Number(high.toFixed(3)),
          low:   Number(low.toFixed(3)),
          close: Number(close.toFixed(3)),
        });
      }
      const filtered = dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
      if (filtered.length > 0) return filtered;
    } catch (e) {
      console.warn(`Yahoo ${symbol} URL 실패:`, e.message);
    }
  }
  return [];
}

// ── Yahoo 현재가 ──────────────────────────────────────
async function fetchYahooCurrent(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com/',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta || {};
  return meta.regularMarketPrice || meta.previousClose || null;
}

// ── 히스토리 캐시 ─────────────────────────────────────
const histCache = {
  LH:    { data: [], fetchedAt: 0 },
  ZC:    { data: [], fetchedAt: 0 },
  ZS:    { data: [], fetchedAt: 0 },
  KAMIS: { data: [], fetchedAt: 0 },
};
const HIST_TTL  = 6 * 3600 * 1000;
const START_YMD = '2024-04-29';

async function getHistory(sym) {
  const c = histCache[sym];
  if (c.data.length && Date.now() - c.fetchedAt < HIST_TTL) return c.data;

  const yahooMap = { LH: 'LH=F', ZC: 'ZC=F', ZS: 'ZS=F' };

  if (yahooMap[sym]) {
    try {
      const rows = await fetchYahooHistory(yahooMap[sym], START_YMD);
      if (rows.length > 0) {
        c.data = rows; c.fetchedAt = Date.now();
        console.log(`✅ ${sym} ${rows.length}건`);
        return rows;
      }
    } catch (e) { console.warn(`⚠️ ${sym}:`, e.message); }
  }

  if (sym === 'KAMIS') {
    try {
      const rows = await fetchKamisHistory();
      if (rows.length > 0) {
        c.data = rows; c.fetchedAt = Date.now();
        console.log(`✅ KAMIS ${rows.length}건`);
        return rows;
      }
    } catch (e) { console.warn('⚠️ KAMIS:', e.message); }
  }

  // 폴백 시드
  const seed = generateSeedData(sym);
  if (!c.data.length) c.data = seed;
  return c.data.length ? c.data : seed;
}

// ── KAMIS 한국 도매가 히스토리 ───────────────────────
async function fetchKamisHistory() {
  const endDate   = new Date().toISOString().slice(0, 10);
  const startDate = START_YMD;

  // KAMIS 공공 API (돼지고기 지육 도매가)
  const KEY = process.env.KAMIS_API_KEY || 'f3ec27ac-b85a-4fd8-8beb-49ac17e56e0c';
  const url = `https://www.kamis.or.kr/service/price/xml.do?action=periodProductList&p_cert_key=${KEY}&p_cert_id=dev&p_returntype=json&p_itemcategorycode=500&p_itemcode=502&p_kindcode=00&p_graderank=1&p_countycode=1101&p_convert_kg_yn=N&p_startday=${startDate}&p_endday=${endDate}`;

  const res  = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  const json = JSON.parse(text);
  const items = json?.data?.item || [];
  const rows = [];
  for (const item of items) {
    const ymd = (item.regday || '').replace(/\./g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    const price = parseFloat((item.dpr1 || '0').replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) continue;
    rows.push({ time: dateToUnix(ymd), open: price, high: price, low: price, close: price });
  }
  return dedupeByTime(rows);
}

// ── 시드 데이터 (폴백) ────────────────────────────────
function generateSeedData(sym) {
  const seeds = {
    LH:    { base: 88,   vol: 0.08 },
    ZC:    { base: 455,  vol: 0.06 },
    ZS:    { base: 1020, vol: 0.05 },
    KAMIS: { base: 4750, vol: 0.04 },
  };
  const s = seeds[sym] || { base: 100, vol: 0.05 };
  const rows = [];
  const start = new Date(START_YMD + 'T00:00:00Z');
  let price = s.base;
  for (let d = 0; d < 365; d++) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + d);
    if ([0, 6].includes(date.getUTCDay())) continue;
    price *= (1 + (Math.random() - 0.5) * s.vol);
    price = Math.max(s.base * 0.7, Math.min(s.base * 1.4, price));
    const ymd = date.toISOString().slice(0, 10);
    const p = Number(price.toFixed(2));
    rows.push({ time: dateToUnix(ymd), open: p, high: Number((p*1.005).toFixed(2)), low: Number((p*0.995).toFixed(2)), close: p });
  }
  return rows;
}

// ── 기간 필터 ─────────────────────────────────────────
function filterByPeriod(rows, period) {
  const now = Date.now();
  const days = period === 'weekly' ? 7 : period === 'monthly' ? 30 : 365;
  const cutTs = Math.floor((now - days * 86400000) / 1000);
  return rows.filter(r => r.time >= cutTs);
}
function getRangeLabel(rows, period) {
  if (!rows.length) return '';
  const first = ymdFromUnix(rows[0].time);
  const last  = ymdFromUnix(rows[rows.length - 1].time);
  const label = period === 'weekly' ? '주간' : period === 'monthly' ? '월간' : '연간';
  return `${first} ~ ${last} · ${label}`;
}

// ── 현재 시세 ─────────────────────────────────────────
async function getCurrentPrices() {
  const hit = aCache.get('current');
  if (hit && Date.now() - hit.ts < 10 * 60000) return hit.data;

  const results = {};
  const symbols = [
    { key: 'LH',      yahoo: 'LH=F',      name: 'CME Lean Hog', unit: 'cents/lb' },
    { key: 'ZC',      yahoo: 'ZC=F',       name: '옥수수 선물',   unit: 'cents/bu' },
    { key: 'ZS',      yahoo: 'ZS=F',       name: '대두 선물',     unit: 'cents/bu' },
    { key: 'USDKRW',  yahoo: 'USDKRW=X',  name: 'USD/KRW',      unit: '원' },
    { key: 'EURKRW',  yahoo: 'EURKRW=X',  name: 'EUR/KRW',      unit: '원' },
  ];

  await Promise.allSettled(symbols.map(async (s) => {
    try {
      const price = await fetchYahooCurrent(s.yahoo);
      if (price) results[s.key] = { price: Number(price.toFixed(2)), name: s.name, unit: s.unit };
    } catch (e) { console.warn(`current ${s.key}:`, e.message); }
  }));

  // KAMIS 현재가
  try {
    const KEY = process.env.KAMIS_API_KEY || 'f3ec27ac-b85a-4fd8-8beb-49ac17e56e0c';
    const url = `https://www.kamis.or.kr/service/price/xml.do?action=dailyPriceByCategoryList&p_cert_key=${KEY}&p_cert_id=dev&p_returntype=json&p_itemcategorycode=500&p_itemcode=502&p_kindcode=00&p_graderank=1&p_countycode=1101&p_convert_kg_yn=N`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    const item = json?.data?.item?.[0];
    if (item) {
      results['KAMIS'] = {
        price: parseFloat((item.dpr1 || '0').replace(/,/g, '')),
        name: '국내 지육 도매가', unit: '원/kg', date: item.regday
      };
    }
  } catch (e) { console.warn('KAMIS current:', e.message); }

  aCache.set('current', { data: results, ts: Date.now() });
  return results;
}

// ── 매입 타이밍 분석 ──────────────────────────────────
function analyzeTimingRules(current) {
  const signals = { positive: 0, negative: 0 };
  const tips = [];
  const usdKrw = current?.USDKRW?.price;
  const eurKrw = current?.EURKRW?.price;
  const lh      = current?.LH?.price;
  const kamis   = current?.KAMIS?.price;

  if (usdKrw) {
    if      (usdKrw < 1320) { signals.positive += 2; tips.push(`✅ USD/KRW ${usdKrw}원 — 원화 강세, 수입 비용 유리`); }
    else if (usdKrw > 1400) { signals.negative += 2; tips.push(`⚠️ USD/KRW ${usdKrw}원 — 고환율, 수입 비용 증가`); }
    else tips.push(`🔵 USD/KRW ${usdKrw}원 — 보통 수준`);
  }
  if (eurKrw) {
    if      (eurKrw < 1440) { signals.positive += 2; tips.push(`✅ EUR/KRW ${eurKrw}원 — EU 지육 수입 비용 유리`); }
    else if (eurKrw > 1540) { signals.negative += 1; tips.push(`⚠️ EUR/KRW ${eurKrw}원 — EU 수입 비용 상승`); }
  }
  if (lh) {
    if      (lh < 80)  { signals.positive += 2; tips.push(`✅ CME Lean Hog ${lh}¢/lb — 저가권, 매입 적기`); }
    else if (lh > 100) { signals.negative += 2; tips.push(`⚠️ CME Lean Hog ${lh}¢/lb — 고가권 주의`); }
    else tips.push(`🔵 CME Lean Hog ${lh}¢/lb — 보통 수준`);
  }
  if (kamis) {
    if      (kamis > 5200) { signals.positive += 1; tips.push(`✅ 국내 도매가 ${kamis}원/kg — 수입 경쟁력 有`); }
    else if (kamis < 4400) { signals.negative += 1; tips.push(`⚠️ 국내 도매가 ${kamis}원/kg — 수익성 점검`); }
  }
  const month = new Date().getMonth() + 1;
  if ([11,12,1,2].includes(month)) { signals.positive += 1; tips.push(`✅ ${month}월 — 설·연말 성수기, 2~3개월 후 수요 증가`); }
  else if ([6,7,8].includes(month)) { signals.positive += 1; tips.push(`✅ ${month}월 — 여름 바베큐 시즌 수요 상승`); }

  const target = new Date();
  target.setMonth(target.getMonth() + 2);
  const targetLabel = `${target.getFullYear()}년 ${target.getMonth()+1}월`;
  let verdict;
  if      (signals.positive > signals.negative + 1) { verdict = '🟢 매입 적기 — 2~3개월 후 선매입 권장'; tips.push(`\n📌 종합: ${targetLabel} 전 선매입 검토 권장`); }
  else if (signals.negative > signals.positive + 1) { verdict = '🔴 대기 권장 — 환율/시세 개선 후 매입'; tips.push(`\n📌 종합: ${targetLabel} 이후 재검토 권장`); }
  else { verdict = '🟡 중립 — 분할 매입 전략 추천'; tips.push(`\n📌 종합: 2~3개월 분할 매입 권장`); }
  return { verdict, tips, signals };
}

// ── AI 프롬프트 ───────────────────────────────────────
function buildPigPrompt(period, histData, current) {
  const label = period === 'weekly' ? '주간' : period === 'monthly' ? '월간' : '연간';
  const fmt = rows => (rows||[]).slice(-15).map(r => `${ymdFromUnix(r.time)}: ${r.close}`).join(', ') || '데이터 없음';
  return `당신은 수안푸드(한국 돼지고기 지육 수입 전문업체)의 구매 전략 분석가입니다.
분석 기간: ${label}

【현재 시세】
- CME Lean Hog: ${current?.LH?.price || 'N/A'} cents/lb
- 옥수수 선물: ${current?.ZC?.price || 'N/A'} cents/bu
- 대두 선물: ${current?.ZS?.price || 'N/A'} cents/bu
- 한국 지육 도매가: ${current?.KAMIS?.price || 'N/A'} 원/kg
- USD/KRW: ${current?.USDKRW?.price || 'N/A'}원
- EUR/KRW: ${current?.EURKRW?.price || 'N/A'}원

【${label} 가격 이력】
CME Lean Hog: ${fmt(histData.LH)}
옥수수: ${fmt(histData.ZC)}
대두: ${fmt(histData.ZS)}
한국 도매가: ${fmt(histData.KAMIS)}

수안푸드는 EU·미국·캐나다에서 냉동 돼지고기 지육을 수입합니다. 환율 낮을수록 유리.

다음을 분석하세요 (한국어 Markdown, 600~900자):
### 1. ${label} 지육가 동향
### 2. 사료 원료가 영향
### 3. 환율과 수입 비용 분석
### 4. 2~3개월 후 매입 타이밍 권장
`;
}

// ── 수입육 시장동향 AI 분석 프롬프트 ─────────────────
function buildImportMarketPrompt(current) {
  const today = new Date().toLocaleDateString('ko-KR');
  return `당신은 한국 냉동 수입 돼지고기 시장 전문 분석가입니다.
분석 기준일: ${today}

현재 환율: USD/KRW ${current?.USDKRW?.price||'N/A'}원, EUR/KRW ${current?.EURKRW?.price||'N/A'}원

다음 항목을 실제 최신 데이터 기반으로 상세히 분석해주세요 (한국어 Markdown, 1000~1500자):

### 1. 한국 냉동 돼지고기 수입 현황 (2024~2025)
- 주요 수입국별 수입량 (미국, EU(스페인·독일·네덜란드), 캐나다, 칠레, 멕시코 등)
- 전년 대비 증감률
- 전체 수입량 추이

### 2. 국가별 수입 단가 비교
- 국가별 평균 수입 단가 (USD/kg)
- 환율 적용 후 원화 환산 비용
- 가성비 순위

### 3. 전년 대비 수입 현황 및 수급 전망
- 2024년 vs 2025년 비교
- 향후 6개월 수급 전망
- 공급 과잉/부족 여부

### 4. 현재 수입육 시장 주요 이슈
- ASF(아프리카돼지열병) 영향
- 미국·EU 무역 관세 이슈
- 국내 소비 트렌드 변화
- 수입 규제/검역 이슈

### 5. 수안푸드 전략적 시사점
- 유리한 수입국 추천
- 리스크 요인
`;
}

// ── API 라우터 ────────────────────────────────────────

app.get('/api/version', (_, res) => res.json({ buildId: BUILD_ID, version: '2.0.0' }));

// 현재 시세
app.get('/api/current', async (_, res) => {
  try {
    const data = await getCurrentPrices();
    res.json({ ok: true, data, fetchedAt: kstNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 히스토리
app.get('/api/history', async (req, res) => {
  const sym    = (req.query.sym || 'LH').toUpperCase();
  const period = req.query.period || 'yearly';
  if (!['LH','ZC','ZS','KAMIS'].includes(sym))
    return res.status(400).json({ ok: false, error: '지원하지 않는 심볼' });
  try {
    const all  = await getHistory(sym);
    const rows = filterByPeriod(all, period);
    res.json({ ok: true, sym, period, rows, rangeLabel: getRangeLabel(rows, period), total: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 주간 AI
app.get('/api/analysis/weekly', async (_, res) => {
  const KEY = 'ai_weekly';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 30*60000) return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const [current, lh, zc, zs, kamis] = await Promise.all([
      getCurrentPrices(),
      getHistory('LH').then(r=>filterByPeriod(r,'weekly')),
      getHistory('ZC').then(r=>filterByPeriod(r,'weekly')),
      getHistory('ZS').then(r=>filterByPeriod(r,'weekly')),
      getHistory('KAMIS').then(r=>filterByPeriod(r,'weekly')),
    ]);
    const { text, model } = await callGemini(buildPigPrompt('weekly',{LH:lh,ZC:zc,ZS:zs,KAMIS:kamis},current));
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    res.json({ analysis: `### 주간 분석\n\n⚠️ AI 일시 불가: ${e.message}`, cached: false, fallback: true });
  }
});

// 월간 AI
app.get('/api/analysis/monthly', async (_, res) => {
  const KEY = 'ai_monthly';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 60*60000) return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const [current, lh, zc, zs, kamis] = await Promise.all([
      getCurrentPrices(),
      getHistory('LH').then(r=>filterByPeriod(r,'monthly')),
      getHistory('ZC').then(r=>filterByPeriod(r,'monthly')),
      getHistory('ZS').then(r=>filterByPeriod(r,'monthly')),
      getHistory('KAMIS').then(r=>filterByPeriod(r,'monthly')),
    ]);
    const { text, model } = await callGemini(buildPigPrompt('monthly',{LH:lh,ZC:zc,ZS:zs,KAMIS:kamis},current));
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    res.json({ analysis: `### 월간 분석\n\n⚠️ AI 일시 불가: ${e.message}`, cached: false, fallback: true });
  }
});

// 연간 AI
app.get('/api/analysis/yearly', async (_, res) => {
  const KEY = 'ai_yearly';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 3*60*60000) return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const [current, lh, zc, zs, kamis] = await Promise.all([
      getCurrentPrices(),
      getHistory('LH'),
      getHistory('ZC'),
      getHistory('ZS'),
      getHistory('KAMIS'),
    ]);
    const { text, model } = await callGemini(buildPigPrompt('yearly',{LH:lh.slice(-30),ZC:zc.slice(-15),ZS:zs.slice(-15),KAMIS:kamis.slice(-15)},current));
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    res.json({ analysis: `### 연간 분석\n\n⚠️ AI 일시 불가: ${e.message}`, cached: false, fallback: true });
  }
});

// 수입육 시장동향 AI
app.get('/api/analysis/market', async (_, res) => {
  const KEY = 'ai_market';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 6*60*60000) return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const current = await getCurrentPrices();
    const { text, model } = await callGemini(buildImportMarketPrompt(current));
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    res.json({ analysis: `### 수입육 시장동향\n\n⚠️ AI 일시 불가: ${e.message}`, cached: false, fallback: true });
  }
});

// 매입 타이밍
app.get('/api/timing', async (_, res) => {
  try {
    const current = await getCurrentPrices();
    const result  = analyzeTimingRules(current);
    res.json({ ok: true, ...result, current });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 정적 파일 & 페이지 라우팅 ────────────────────────
app.get('/', (_, res) => res.redirect(302, '/pig'));

app.get('/pig', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/REPLACE_BUILD_ID/g, BUILD_ID);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('index.html 로드 실패: ' + e.message);
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false, etag: false, maxAge: 0, lastModified: false,
}));

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0', buildId: BUILD_ID }));

app.listen(PORT, () => {
  console.log(`🐷 수안푸드 대시보드 v2.0 실행 중: http://localhost:${PORT}/pig`);
  Promise.allSettled(['LH','ZC','ZS','KAMIS'].map(s => getHistory(s)))
    .then(() => console.log('✅ 히스토리 프리로드 완료'));
});
