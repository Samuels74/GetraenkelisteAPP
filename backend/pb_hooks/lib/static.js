/// <reference path="../../../.pb/dev-data/types.d.ts" />

// Response headers for the SPA files served from PocketBase's public dir.

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

/**
 * The public dir PocketBase serves: the --publicDir flag of the running
 * process, otherwise PocketBase's default (pb_public next to the executable).
 */
function publicDir() {
  const args = $os.args;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.indexOf("--publicDir=") === 0) {
      return arg.slice("--publicDir=".length);
    }
    if (arg === "--publicDir" && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return $filepath.join($filepath.dir(args[0]), "pb_public");
}

function isFile(path) {
  try {
    return !$os.stat(path).isDir();
  } catch (_) {
    return false;
  }
}

/**
 * Headers to set for a request path, or null for paths that are not served
 * from the public dir (/api/*, the dashboard /_/*).
 *
 * - /assets/* that exist (Vite's content-hashed build output): cached forever
 * - everything else (index.html, SPA fallback responses for app routes and
 *   missing files, manifest.webmanifest, icons, ...): "no-cache", i.e. always
 *   revalidated (cheap thanks to Last-Modified -> 304)
 *
 * @param {string} urlPath
 * @returns {{ cacheControl: string, contentType: string } | null}
 */
function headersFor(urlPath) {
  if (urlPath === "/api" || urlPath.indexOf("/api/") === 0 || urlPath === "/_" || urlPath.indexOf("/_/") === 0) {
    return null;
  }

  const exists = urlPath !== "/" && isFile($filepath.join(publicDir(), $filepath.fromSlash(urlPath)));

  return {
    cacheControl: exists && urlPath.indexOf("/assets/") === 0 ? IMMUTABLE : NO_CACHE,
    // Go's MIME table doesn't know .webmanifest (would be text/plain)
    contentType: exists && /\.webmanifest$/.test(urlPath) ? "application/manifest+json" : "",
  };
}

module.exports = { headersFor, publicDir };
