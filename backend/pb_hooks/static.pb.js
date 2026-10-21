/// <reference path="../../.pb/dev-data/types.d.ts" />

// The SPA from PocketBase's public dir (--publicDir) – docs/ARCHITECTURE.md §7
// "Caching":
//   /assets/*  -> Cache-Control: public, max-age=31536000, immutable
//   all other static files and SPA fallback responses -> Cache-Control: no-cache
//   /api, /api/*, /_, /_/* that no API or dashboard route handles -> JSON 404
//     (PocketBase's error response, as for the other methods) – never the SPA
// See lib/static.js.
//
// This file registers the static route GET /{path...} itself – the prebuilt
// PocketBase adds its default static route only if that route does not exist
// yet (examples/base/main.go in the PocketBase sources) – so the headers are
// set by a middleware of this route alone. The files are still served by
// PocketBase's native handler ($apis.static: index.html fallback for the SPA
// routes, Content-Type, Last-Modified / 304; PocketBase's --indexFallback
// flag no longer applies – the SPA always needs the fallback).
//
// Why not a global middleware (routerUse): it runs in a JS VM for every
// request – every API call and every realtime (SSE) stream – and keeps that
// VM for the whole request. Each open realtime connection pinned one VM
// (≈ 0.5 MiB), and beyond the pool of 15 VMs every further JS call created a
// one-off VM. Here only static requests touch JS.

routerAdd(
  "GET",
  "/{path...}",
  // evaluated once at startup: a native Go handler, no JS VM per request
  $apis.static($os.dirFS(require(`${__hooks}/lib/static.js`).publicDir()), true),
  (e) => {
    const staticFiles = require(`${__hooks}/lib/static.js`);
    const path = e.request.pathValue("path");
    if (staticFiles.isApiOrDashboardPath(path)) {
      throw new NotFoundError();
    }
    const headers = staticFiles.headersFor(path);
    if (headers) {
      e.response.header().set("Cache-Control", headers.cacheControl);
      if (headers.contentType) {
        e.response.header().set("Content-Type", headers.contentType);
      }
    }
    return e.next();
  },
);
