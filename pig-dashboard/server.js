// server.js - 수안푸드 지육가 대시보드 v1.0
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

// 캐시 비활성화
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '-1');
  next();
});

const PORT = process.env.PORT || 3001;

// ── 인메모리 캐시 ────────────────────────────────────
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

// ── Yahoo Finance 공통 히스토리 ───────────────────────
async function fetchYahooHistory(symbol, startYmd) {
  const startTs = Math.floor(new Date(startYmd + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${endTs}&interval=1d&includePrePost=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
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
      open:  Number(open.toFixed(4)),
      high:  Number(high.toFixed(4)),
      low:   Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
    });
  }
  return dedupeByTime(rows).filter(r => ymdFromUnix(r.time) >= startYmd);
}

// ── 히스토리 캐시 ─────────────────────────────────────
const histCache = {
  LH:   { data: [], fetchedAt: 0 },  // CME Lean Hog (cents/lb)
  ZC:   { data: [], fetchedAt: 0 },  // 옥수수
  ZS:   { data: [], fetchedAt: 0 },  // 대두
  KAMIS:{ data: [], fetchedAt: 0 },  // 한국 도매가
};
const HIST_TTL = 6 * 3600 * 1000; // 6시간
const START_YMD = '2024-04-01';    // 1년치

async function getHistory(sym) {
  const c = histCache[sym];
  if (c.data.length && Date.now() - c.fetchedAt < HIST_TTL) return c.data;

  // Yahoo Finance 심볼 매핑
  const yahooMap = {
    LH: 'LH=F',   // Lean Hog Futures
    ZC: 'ZC=F',   // Corn Futures
    ZS: 'ZS=F',   // Soybean Futures
  };

  if (yahooMap[sym]) {
    try {
      const rows = await fetchYahooHistory(yahooMap[sym], START_YMD);
      if (rows.length > 0) {
        c.data = rows;
        c.fetchedAt = Date.now();
        console.log(`✅ ${sym} history: ${rows.length}rows`);
        return rows;
      }
    } catch (e) {
      console.warn(`⚠️ ${sym} Yahoo fetch failed:`, e.message);
    }
  }

  // KAMIS 한국 지육 도매가 (공공데이터포털)
  if (sym === 'KAMIS') {
    try {
      const rows = await fetchKamisHistory();
      if (rows.length > 0) {
        c.data = rows;
        c.fetchedAt = Date.now();
        return rows;
      }
    } catch (e) {
      console.warn('⚠️ KAMIS history failed:', e.message);
    }
  }

  // 폴백: 기존 데이터 반환 or 시드
  return c.data.length ? c.data : generateSeedData(sym);
}

// ── KAMIS 한국 지육 도매가 히스토리 ──────────────────
async function fetchKamisHistory() {
  // KAMIS 공공 API - 돼지(돼지고기) 도매가격 일별 이력
  const endDate   = new Date().toISOString().slice(0, 10);
  const startDate = START_YMD;
  const url = `https://www.kamis.or.kr/service/price/xml.do?action=periodProductList&p_cert_key=f3ec27ac-b85a-4fd8-8beb-49ac17e56e0c&p_cert_id=dev&p_returntype=json&p_itemcategorycode=500&p_itemcode=502&p_kindcode=00&p_graderank=1&p_countycode=1101&p_convert_kg_yn=N&p_startday=${startDate}&p_endday=${endDate}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await res.json();
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
    LH:    { base: 88,   vol: 6,   unit: 'cents/lb' },
    ZC:    { base: 460,  vol: 30,  unit: 'cents/bu'  },
    ZS:    { base: 1050, vol: 60,  unit: 'cents/bu'  },
    KAMIS: { base: 4800, vol: 400, unit: '원/kg'     },
  };
  const s = seeds[sym] || { base: 100, vol: 10 };
  const rows = [];
  const start = new Date(START_YMD + 'T00:00:00Z');
  let price = s.base;
  for (let d = 0; d < 365; d++) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + d);
    const ymd = date.toISOString().slice(0, 10);
    if ([0, 6].includes(date.getUTCDay())) continue; // 주말 제외
    price += (Math.random() - 0.5) * s.vol * 0.1;
    price = Math.max(s.base * 0.7, Math.min(s.base * 1.3, price));
    rows.push({
      time: dateToUnix(ymd),
      open: Number(price.toFixed(2)),
      high: Number((price * 1.005).toFixed(2)),
      low:  Number((price * 0.995).toFixed(2)),
      close: Number(price.toFixed(2)),
    });
  }
  return rows;
}

// ── 기간 필터 ─────────────────────────────────────────
function filterByPeriod(rows, period) {
  const now = Date.now();
  let cutTs;
  if (period === 'weekly')  cutTs = Math.floor((now - 7  * 86400000) / 1000);
  else if (period === 'monthly') cutTs = Math.floor((now - 30 * 86400000) / 1000);
  else                      cutTs = Math.floor((now - 365 * 86400000) / 1000);
  return rows.filter(r => r.time >= cutTs);
}

function getRangeLabel(rows, period) {
  if (!rows.length) return '';
  const first = ymdFromUnix(rows[0].time);
  const last  = ymdFromUnix(rows[rows.length - 1].time);
  const fmt   = ymd => ymd.slice(5).replace('-', '/');
  const periodLabel = period === 'weekly' ? '주간' : period === 'monthly' ? '월간' : '연간';
  return `${first} ~ ${last} · ${periodLabel}`;
}

// ── 현재 시세 가져오기 ────────────────────────────────
async function getCurrentPrices() {
  const hit = aCache.get('current');
  if (hit && Date.now() - hit.ts < 10 * 60000) return hit.data;

  const results = {};
  const symbols = [
    { key: 'LH',   yahoo: 'LH=F',  name: 'CME Lean Hog',  unit: 'cents/lb' },
    { key: 'ZC',   yahoo: 'ZC=F',  name: '옥수수 선물',    unit: 'cents/bu' },
    { key: 'ZS',   yahoo: 'ZS=F',  name: '대두 선물',      unit: 'cents/bu' },
    { key: 'USDKRW', yahoo: 'USDKRW=X', name: 'USD/KRW', unit: '원' },
    { key: 'EURKRW', yahoo: 'EURKRW=X', name: 'EUR/KRW', unit: '원' },
  ];

  await Promise.allSettled(symbols.map(async (s) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.yahoo)}?interval=1d&range=5d`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice || meta.previousClose;
      if (price) {
        results[s.key] = {
          price: Number(price.toFixed(s.key.includes('KRW') ? 2 : 4)),
          name: s.name, unit: s.unit
        };
      }
    } catch (e) {
      console.warn(`⚠️ current ${s.key}:`, e.message);
    }
  }));

  // KAMIS 현재가
  try {
    const url = `https://www.kamis.or.kr/service/price/xml.do?action=dailyPriceByCategoryList&p_cert_key=f3ec27ac-b85a-4fd8-8beb-49ac17e56e0c&p_cert_id=dev&p_returntype=json&p_itemcategorycode=500&p_itemcode=502&p_kindcode=00&p_graderank=1&p_countycode=1101&p_convert_kg_yn=N`;
    const res  = await fetch(url);
    const json = await res.json();
    const item = json?.data?.item?.[0];
    if (item) {
      results['KAMIS'] = {
        price: parseFloat((item.dpr1 || '0').replace(/,/g, '')),
        name: '국내 지육 도매가', unit: '원/kg', date: item.regday
      };
    }
  } catch (e) {
    console.warn('⚠️ KAMIS current:', e.message);
  }

  aCache.set('current', { data: results, ts: Date.now() });
  return results;
}

// ── 매입 타이밍 규칙 기반 분석 ───────────────────────
function analyzeTimingRules(current) {
  const signals = { positive: 0, negative: 0 };
  const tips = [];

  const usdKrw = current?.USDKRW?.price;
  const eurKrw = current?.EURKRW?.price;
  const lh      = current?.LH?.price;
  const kamis   = current?.KAMIS?.price;

  if (usdKrw) {
    if (usdKrw < 1320) { signals.positive += 2; tips.push(`✅ USD/KRW ${usdKrw}원 — 원화 강세, 수입 비용 유리`); }
    else if (usdKrw > 1400) { signals.negative += 2; tips.push(`⚠️ USD/KRW ${usdKrw}원 — 고환율, 수입 비용 증가`); }
    else tips.push(`🔵 USD/KRW ${usdKrw}원 — 보통 수준`);
  }
  if (eurKrw) {
    if (eurKrw < 1440) { signals.positive += 2; tips.push(`✅ EUR/KRW ${eurKrw}원 — EU 지육 수입 비용 유리`); }
    else if (eurKrw > 1540) { signals.negative += 1; tips.push(`⚠️ EUR/KRW ${eurKrw}원 — EU 수입 비용 상승`); }
  }
  if (lh) {
    if (lh < 80) { signals.positive += 2; tips.push(`✅ CME Lean Hog ${lh}¢/lb — 저가권, 매입 검토 적기`); }
    else if (lh > 100) { signals.negative += 2; tips.push(`⚠️ CME Lean Hog ${lh}¢/lb — 고가권 주의`); }
    else tips.push(`🔵 CME Lean Hog ${lh}¢/lb — 보통 수준`);
  }
  if (kamis) {
    if (kamis > 5200) { signals.positive += 1; tips.push(`✅ 국내 도매가 ${kamis}원/kg — 높은 시세, 수입 경쟁력 有`); }
    else if (kamis < 4400) { signals.negative += 1; tips.push(`⚠️ 국내 도매가 ${kamis}원/kg — 낮은 시세, 수익성 점검`); }
  }

  const month = new Date().getMonth() + 1;
  if ([11, 12, 1, 2].includes(month)) {
    signals.positive += 1;
    tips.push(`✅ ${month}월 — 설·연말 성수기 진입 전, 2~3개월 후 수요 증가 예상`);
  } else if ([6, 7, 8].includes(month)) {
    signals.positive += 1;
    tips.push(`✅ ${month}월 — 여름 바베큐 시즌, 국제 돈육 수요 상승 구간`);
  }

  const target = new Date();
  target.setMonth(target.getMonth() + 2);
  const targetLabel = `${target.getFullYear()}년 ${target.getMonth() + 1}월`;

  let verdict;
  if (signals.positive > signals.negative + 1) {
    verdict = '🟢 매입 적기 — 2~3개월 후 선매입 권장';
    tips.push(`\n📌 종합: 조건 우호적. ${targetLabel} 전 선매입 검토 권장.`);
  } else if (signals.negative > signals.positive + 1) {
    verdict = '🔴 대기 권장 — 환율/시세 개선 후 매입';
    tips.push(`\n📌 종합: 현재 조건 불리. ${targetLabel} 이후 재검토 권장.`);
  } else {
    verdict = '🟡 중립 — 분할 매입 전략 추천';
    tips.push(`\n📌 종합: 뚜렷한 방향성 없음. 2~3개월에 걸쳐 분할 매입 권장.`);
  }
  return { verdict, tips, signals };
}

// ── AI 분석 프롬프트 빌더 ─────────────────────────────
function buildPigPrompt(period, histData, current) {
  const periodLabel = period === 'weekly' ? '주간' : period === 'monthly' ? '월간' : '연간';
  const lhRows   = (histData.LH   || []).slice(-20);
  const zcRows   = (histData.ZC   || []).slice(-10);
  const zsRows   = (histData.ZS   || []).slice(-10);
  const kamisRows = (histData.KAMIS || []).slice(-10);

  const fmt = rows => rows.map(r => `${ymdFromUnix(r.time)}: ${r.close}`).join(', ') || '데이터 없음';

  return `당신은 수안푸드(한국 돼지고기 지육 수입 전문업체)의 구매 전략 분석가입니다.
분석 기간: ${periodLabel} (${current?.fetchedAt ? new Date(current.fetchedAt).toLocaleDateString('ko-KR') : '최신'} 기준)

【현재 시세】
- CME Lean Hog 선물: ${current?.LH?.price || 'N/A'} cents/lb
- 옥수수 선물: ${current?.ZC?.price || 'N/A'} cents/bu
- 대두 선물: ${current?.ZS?.price || 'N/A'} cents/bu
- 한국 지육 도매가: ${current?.KAMIS?.price || 'N/A'} 원/kg
- USD/KRW: ${current?.USDKRW?.price || 'N/A'}원
- EUR/KRW: ${current?.EURKRW?.price || 'N/A'}원

【${periodLabel} 가격 이력】
CME Lean Hog: ${fmt(lhRows)}
옥수수 선물: ${fmt(zcRows)}
대두 선물: ${fmt(zsRows)}
한국 도매가: ${fmt(kamisRows)}

【수안푸드 상황】
- 주요 수입국: 유럽(EU), 미국, 캐나다
- 환율 낮을수록(원화 강세) 수입 비용 유리
- 목표: 2~3개월 후 최적 매입 타이밍 파악

다음을 분석해주세요 (한국어 Markdown, 600~900자):
### 1. ${periodLabel} 지육가 동향
### 2. 사료 원료가 영향 분석
### 3. 환율과 결합한 수입 비용 분석
### 4. 2~3개월 후 매입 타이밍 권장
`;
}

// ── API 라우터 ────────────────────────────────────────

// 버전
app.get('/api/version', (_, res) => res.json({ buildId: BUILD_ID, version: '1.0.0' }));

// 현재 시세
app.get('/api/current', async (_, res) => {
  try {
    const data = await getCurrentPrices();
    res.json({ ok: true, data, fetchedAt: kstNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 히스토리 (주간/월간/연간)
app.get('/api/history', async (req, res) => {
  const sym    = (req.query.sym || 'LH').toUpperCase();
  const period = req.query.period || 'yearly'; // weekly | monthly | yearly
  const validSyms = ['LH', 'ZC', 'ZS', 'KAMIS'];
  if (!validSyms.includes(sym)) return res.status(400).json({ ok: false, error: '지원하지 않는 심볼' });
  try {
    const all    = await getHistory(sym);
    const rows   = filterByPeriod(all, period);
    const rangeLabel = getRangeLabel(rows, period);
    res.json({ ok: true, sym, period, rows, rangeLabel, total: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 주간 AI 분석
app.get('/api/analysis/weekly', async (_, res) => {
  const KEY = 'ai_weekly';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 30 * 60000)
    return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const [current, lhRows, zcRows, zsRows, kamisRows] = await Promise.all([
      getCurrentPrices(),
      getHistory('LH').then(r => filterByPeriod(r, 'weekly')),
      getHistory('ZC').then(r => filterByPeriod(r, 'weekly')),
      getHistory('ZS').then(r => filterByPeriod(r, 'weekly')),
      getHistory('KAMIS').then(r => filterByPeriod(r, 'weekly')),
    ]);
    const prompt = buildPigPrompt('weekly', { LH: lhRows, ZC: zcRows, ZS: zsRows, KAMIS: kamisRows }, current);
    const { text, model } = await callGemini(prompt);
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    const fallback = `### 주간 지육가 분석\n\n⚠️ AI 분석 일시 불가: ${e.message}\n\n현재 데이터를 직접 확인하시기 바랍니다.`;
    res.json({ analysis: fallback, cached: false, fallback: true });
  }
});

// 월간 AI 분석
app.get('/api/analysis/monthly', async (_, res) => {
  const KEY = 'ai_monthly';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 60 * 60000)
    return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const [current, lhRows, zcRows, zsRows, kamisRows] = await Promise.all([
      getCurrentPrices(),
      getHistory('LH').then(r => filterByPeriod(r, 'monthly')),
      getHistory('ZC').then(r => filterByPeriod(r, 'monthly')),
      getHistory('ZS').then(r => filterByPeriod(r, 'monthly')),
      getHistory('KAMIS').then(r => filterByPeriod(r, 'monthly')),
    ]);
    const prompt = buildPigPrompt('monthly', { LH: lhRows, ZC: zcRows, ZS: zsRows, KAMIS: kamisRows }, current);
    const { text, model } = await callGemini(prompt);
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    const fallback = `### 월간 지육가 분석\n\n⚠️ AI 분석 일시 불가: ${e.message}`;
    res.json({ analysis: fallback, cached: false, fallback: true });
  }
});

// 연간 AI 분석
app.get('/api/analysis/yearly', async (_, res) => {
  const KEY = 'ai_yearly';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 3 * 60 * 60000)
    return res.json({ analysis: hit.analysis, cached: true, model: hit.model });
  try {
    const [current, lhRows, zcRows, zsRows, kamisRows] = await Promise.all([
      getCurrentPrices(),
      getHistory('LH'),
      getHistory('ZC'),
      getHistory('ZS'),
      getHistory('KAMIS'),
    ]);
    const prompt = buildPigPrompt('yearly', { LH: lhRows.slice(-30), ZC: zcRows.slice(-15), ZS: zsRows.slice(-15), KAMIS: kamisRows.slice(-15) }, current);
    const { text, model } = await callGemini(prompt);
    aCache.set(KEY, { analysis: text, ts: Date.now(), model });
    res.json({ analysis: text, cached: false, model });
  } catch (e) {
    const fallback = `### 연간 지육가 분석\n\n⚠️ AI 분석 일시 불가: ${e.message}`;
    res.json({ analysis: fallback, cached: false, fallback: true });
  }
});

// 매입 타이밍 분석
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

app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0', buildId: BUILD_ID }));

app.listen(PORT, () => {
  console.log(`🐷 수안푸드 지육가 대시보드 실행 중: http://localhost:${PORT}/pig`);
  // 시작 시 히스토리 프리로드
  Promise.allSettled(['LH','ZC','ZS','KAMIS'].map(s => getHistory(s)))
    .then(() => console.log('✅ 히스토리 프리로드 완료'));
});
