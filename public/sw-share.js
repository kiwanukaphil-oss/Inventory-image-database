// Web Share Target receiver — imported into the generated service worker
// (workbox.importScripts in vite.config.js). When the OS shares photos into the
// installed app, the browser POSTs them to /share-target; we stash them in a
// Cache and redirect into the Add flow, which picks them up on load
// (consumeSharedMedia in src/upload.js). Kept tiny and defensive so a failure
// here can never block the app from loading.
self.addEventListener("fetch", (event) => {
  let url;
  try { url = new URL(event.request.url); } catch { return; }
  if (event.request.method !== "POST" || url.pathname !== "/share-target") return;

  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const files = form.getAll("photos").filter((f) => f && f.size);
      const cache = await caches.open("shared-media");
      // Drop any prior share, then store the new files + an index manifest.
      const keys = await cache.keys();
      await Promise.all(keys.map((k) => cache.delete(k)));
      const names = [];
      for (let i = 0; i < files.length; i++) {
        const name = `shared-${i}-${(files[i].name || "photo.jpg").replace(/[^\w.\-]/g, "_")}`;
        await cache.put(`/shared-media/${name}`,
          new Response(files[i], { headers: { "content-type": files[i].type || "image/jpeg" } }));
        names.push(name);
      }
      await cache.put("/shared-media/index.json",
        new Response(JSON.stringify(names), { headers: { "content-type": "application/json" } }));
    } catch (_e) { /* fall through to the redirect regardless */ }
    return Response.redirect("/?share=1", 303);
  })());
});
