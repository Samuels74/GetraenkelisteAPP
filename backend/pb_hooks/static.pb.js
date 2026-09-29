/// <reference path="../../.pb/dev-data/types.d.ts" />

// Cache headers for the SPA served by PocketBase (--publicDir):
//   /assets/*  -> Cache-Control: public, max-age=31536000, immutable
//   all other static files and SPA fallback responses -> Cache-Control: no-cache
// /api/* and the dashboard /_/* are left untouched. See lib/static.js.

routerUse((e) => {
  const staticFiles = require(`${__hooks}/lib/static.js`);
  const headers = staticFiles.headersFor(e.request.url.path);
  if (headers) {
    e.response.header().set("Cache-Control", headers.cacheControl);
    if (headers.contentType) {
      e.response.header().set("Content-Type", headers.contentType);
    }
  }
  return e.next();
});
