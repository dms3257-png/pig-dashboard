// sw.js - v8.0.0  PWA 설치 지원 + 오프라인 fallback
const SW_VERSION = 'sw-v8';
const CACHE_NAME = 'fx-shell-v8';

// 설치 시 오프라인 페이지 캐시
self.addEventListener('install', (event) => {
  console.log('[SW] install', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 핵심 파일 캐시 (오프라인 fallback용)
      return cache.addAll([
        '/fx',
        '/manifest.json',
        '/icons/icon-192x192.png',
        '/icons/icon-512x512.png'
      ]).catch(err => {
        console.warn('[SW] cache prefetch 일부 실패 (무시):', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate', SW_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] 구버전 캐시 삭제:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API 요청 → 항상 네트워크
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
    );
    return;
  }

  // HTML 페이지 navigation → 네트워크 우선, 오프라인 시 캐시
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      }).then(response => {
        // 성공 시 캐시 업데이트
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        return response;
      }).catch(() => {
        // 오프라인 → 캐시에서 서빙
        return caches.match(req).then(cached => {
          if (cached) return cached;
          return caches.match('/fx');
        });
      })
    );
    return;
  }

  // 정적 파일 → 캐시 우선
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});
