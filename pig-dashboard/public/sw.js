// sw.js - 수안푸드 지육가 대시보드 PWA v1.0
const SW_VERSION  = 'sw-v1';
const CACHE_NAME  = 'suanfood-shell-v1';

// 오프라인 시 캐시할 핵심 파일
const SHELL_FILES = [
  '/pig',
  '/manifest.webmanifest',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// ── 설치 ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] install', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_FILES).catch((err) => {
        console.warn('[SW] 캐시 프리패치 일부 실패 (무시):', err);
      });
    })
  );
  self.skipWaiting();
});

// ── 활성화 ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] activate', SW_VERSION);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => {
            console.log('[SW] 구버전 캐시 삭제:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch 처리 ────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1) API 요청 → 항상 네트워크 (캐시 금지)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() => {
        return new Response(
          JSON.stringify({ ok: false, error: '오프라인 상태입니다' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // 2) HTML 페이지 네비게이션 → 네트워크 우선, 실패 시 캐시
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      })
        .then((response) => {
          // 성공 시 캐시 업데이트
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          // 오프라인 → 캐시에서 서빙
          return caches.match(request).then(
            (cached) => cached || caches.match('/pig')
          );
        })
    );
    return;
  }

  // 3) 아이콘 / 정적 파일 → 캐시 우선
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // 4) 그 외 → 네트워크 우선
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
