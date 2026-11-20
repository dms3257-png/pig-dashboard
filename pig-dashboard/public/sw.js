// sw.js - 수안푸드 지육가 대시보드 (홈 화면 설치용)
// 화면(/pig)·API 는 항상 서버에서 새로 받음 → 코드를 고쳐 올리면 새로고침만으로 반영
// 인터넷이 끊겼을 때만 마지막으로 본 화면을 보여줌 (시세 숫자는 새로 받지 못하므로 화면의 수집 시각을 확인)
const CACHE_NAME = 'pig-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(['/manifest.webmanifest', '/icons/icon-192x192.png', '/icons/icon-512x512.png']))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))   // 예전 앱(환율 앱 등) 캐시 삭제
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                              // AI 분석 요청(POST) 등은 그대로 서버로
  const url = new URL(req.url);

  // API → 항상 서버 (저장하지 않음)
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // 화면 → 서버 우선, 끊겼을 때만 마지막 화면
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => {
          if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put('/pig', copy)); }
          return res;
        })
        .catch(() => caches.match('/pig').then(c => c || new Response('<meta charset="utf-8"><body style="background:#0f172a;color:#e2e8f0;font-family:sans-serif;padding:24px">인터넷에 연결되어 있지 않습니다. 연결 후 다시 열어 주세요.</body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
    );
    return;
  }

  // 아이콘, 버전이 고정된 외부 라이브러리(Chart.js 등) → 저장해 두고 사용
  const isIcon = url.origin === self.location.origin && url.pathname.startsWith('/icons/');
  const isLib = /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|cdn\.sheetjs\.com/.test(url.host) && /@?\d+\.\d+\.\d+/.test(url.pathname);
  if (isIcon || isLib) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
  // 그 밖은 브라우저 기본 동작
});
