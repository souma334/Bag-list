/* ==========================================
   FocusGuard - Service Worker
   通知をタブがバックグラウンドでも確実に表示するための最小構成
   ========================================== */

self.addEventListener('install', (event) => {
    // 待機せずすぐに有効化する
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// 通知をクリックしたらFocusGuardのタブにフォーカスを戻す
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow('./');
            }
        })
    );
});
