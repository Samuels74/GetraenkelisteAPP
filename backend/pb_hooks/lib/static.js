/// <reference path="../../../.pb/dev-data/types.d.ts" />

// Response headers for the SPA files served from PocketBase's public dir
// (the static route of static.pb.js).

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

let cachedPublicDir = null;

/**
 * The public dir PocketBase serves: the --publicDir flag of the running
 * process (the last one wins, like in PocketBase's flag parser), otherwise
 * PocketBase's default (pb_public next to the executable).
 */
function publicDir() {
  if (cachedPublicDir === null) {
    const args = $os.args;
    let dir = $filepath.join($filepath.dir(args[0]), "pb_public");
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.indexOf("--publicDir=") === 0) {
        dir = arg.slice("--publicDir=".length);
      } else if (arg === "--publicDir" && i + 1 < args.length) {
        dir = args[i + 1];
        i++;
      }
    }
    cachedPublicDir = dir;
  }
  return cachedPublicDir;
}

function isFile(path) {
  try {
    return !$os.stat(path).isDir();
  } catch (_) {
    return false;
  }
}

/**
 * Whether a path of the static route belongs to the API or the dashboard
 * (/api, /api/*, /_, /_/* – also when the slash arrives encoded, "/_%2Fx":
 * the route's path value is decoded). The static route only sees such a
 * path when no API or dashboard route handles it; it answers with
 * PocketBase's JSON 404 instead of the SPA – a client calling a wrong or
 * removed endpoint must get an error, not "200 + index.html".
 *
 * @param {string} path  the route's wildcard value, e.request.pathValue("path")
 * @returns {boolean}
 */
function isApiOrDashboardPath(path) {
  return path === "api" || path.indexOf("api/") === 0 || path === "_" || path.indexOf("_/") === 0;
}

/**
 * Headers to set for a request of the static route, or null for the paths
 * of the API and the dashboard (isApiOrDashboardPath – the route answers
 * them with a 404 and serves no file).
 *
 * - files below /assets/ (Vite's content-hashed build output): cached forever
 * - everything else (index.html, SPA fallback responses for app routes and
 *   missing files, manifest.webmanifest, icons, ...): "no-cache", i.e. always
 *   revalidated (cheap thanks to Last-Modified -> 304)
 *
 * The file is resolved exactly like PocketBase's static handler resolves it
 * (apis/base.go Static): the route's {path...} value with ONE leading slash
 * trimmed, cleaned, relative to the public dir. Whatever that handler cannot
 * open counts as missing (it serves the index.html fallback instead): a path
 * that leaves the public dir ("..", also URL-encoded) and a path that is
 * still absolute ("/%2F%2Fassets/x.js" has the value "//assets/x.js" – the
 * fallback must not be cached as immutable). So the headers never depend on
 * files elsewhere on the server.
 *
 * @param {string} path  the route's wildcard value, e.request.pathValue("path"):
 *                       the decoded request path without its leading "/"
 * @returns {{ cacheControl: string, contentType: string } | null}
 */
function headersFor(path) {
  if (isApiOrDashboardPath(path)) {
    return null;
  }

  const file = $filepath.toSlash($filepath.clean(path.indexOf("/") === 0 ? path.slice(1) : path));
  // PocketBase rejects "..", "../…" and "..\…"; os.DirFS rejects absolute paths
  const inside = file !== ".." && file.indexOf("../") !== 0 && file.indexOf("..\\") !== 0 && file.indexOf("/") !== 0;
  const exists = inside && isFile($filepath.join(publicDir(), $filepath.fromSlash(file)));

  return {
    cacheControl: exists && file.indexOf("assets/") === 0 ? IMMUTABLE : NO_CACHE,
    // Go's MIME table doesn't know .webmanifest (would be text/plain)
    contentType: exists && /\.webmanifest$/.test(file) ? "application/manifest+json" : "",
  };
}

module.exports = { headersFor, isApiOrDashboardPath, publicDir };
