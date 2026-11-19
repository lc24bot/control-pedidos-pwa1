/* Solo interfaz estática. Nunca se guardan respaldos ni datos de pedidos en Cache Storage. */
const CACHE_PREFIX = `control-pedidos:${self.registration.scope}:shell:`;
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
const urls = ASSETS.map(asset => new URL(asset, self.registration.scope).href);
self.addEventListener('install', event => {
  // Sin skipWaiting: una actualización no interrumpe formularios abiertos.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urls.map(url => new Request(url, {cache:'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for(const key of await caches.keys()){
      if(key.startsWith(CACHE_PREFIX) && key!==CACHE_NAME)await caches.delete(key);
      // Cachés antiguas: limpiar solo si todos sus recursos pertenecen a este alcance.
      if(/^control-pedidos-shell-v\d+$/.test(key)){
        const requests=await (await caches.open(key)).keys();
        if(requests.length && requests.every(request=>urls.includes(request.url)))await caches.delete(key);
      }
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  const canonical=new URL(url.pathname,url.origin).href;
  if(!urls.includes(canonical))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(canonical);
    return cached || fetch(event.request);
  })());
});
