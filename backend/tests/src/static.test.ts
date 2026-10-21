import { describe, expect, it } from "vitest";
import { PB_URL } from "./helpers";

// The test PocketBase serves the fixture files of support/public.
const IMMUTABLE = "public, max-age=31536000, immutable";

async function head(path: string, init: RequestInit = {}) {
  const res = await fetch(`${PB_URL}${path}`, { redirect: "manual", ...init });
  const body = await res.text();
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    contentType: res.headers.get("content-type") ?? "",
    body,
  };
}

describe("cache headers of the SPA", () => {
  it("revalidates index.html and SPA fallback responses", async () => {
    for (const path of ["/", "/buchen", "/personen/abc123", "/verwaltung/angebote"]) {
      const res = await head(path);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain("spa-fixture");
      expect(res.cacheControl, path).toBe("no-cache");
    }
  });

  it("revalidates non-hashed static files; serves the manifest with its MIME type", async () => {
    const manifest = await head("/manifest.webmanifest");
    expect(manifest).toMatchObject({ status: 200, cacheControl: "no-cache", contentType: "application/manifest+json" });

    const icon = await head("/icons/icon.svg");
    expect(icon).toMatchObject({ status: 200, cacheControl: "no-cache" });
  });

  it("caches the hashed build output under /assets forever", async () => {
    const asset = await head("/assets/index-Fx7Kq2Ab.js");
    expect(asset).toMatchObject({ status: 200, cacheControl: IMMUTABLE });
    expect(asset.contentType).toContain("javascript");
  });

  it("never caches the SPA fallback for missing files as immutable", async () => {
    for (const path of ["/assets/index-missing1.js", "/assets/", "/missing.webmanifest"]) {
      const res = await head(path);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain("spa-fixture");
      expect(res.cacheControl, path).toBe("no-cache");
      expect(res.contentType, path).toContain("text/html");
    }
  });

  it("sends the same headers for HEAD requests", async () => {
    expect(await head("/", { method: "HEAD" })).toMatchObject({ status: 200, cacheControl: "no-cache" });
    expect(await head("/buchungen", { method: "HEAD" })).toMatchObject({ status: 200, cacheControl: "no-cache" });
    expect(await head("/assets/index-Fx7Kq2Ab.js", { method: "HEAD" })).toMatchObject({ status: 200, cacheControl: IMMUTABLE });
  });

  it("never derives the header from files outside the public dir or outside /assets", async () => {
    // "/assets/../index.html": the file exists, but not below /assets (served as a redirect to "/")
    const escaped = await head("/assets/..%2Findex.html");
    expect(escaped.cacheControl).toBe("no-cache");
    // far outside the public dir: a file that exists on every Linux host must not show through
    const outside = await head(`/assets/${"..%2F".repeat(12)}etc%2Fpasswd`);
    expect(outside).toMatchObject({ status: 200, cacheControl: "no-cache" });
    expect(outside.body).toContain("spa-fixture");
  });

  it("trims leading slashes like PocketBase's static handler (exactly one)", async () => {
    // "/%2Fassets/…": the route's path value is "/assets/…" – PocketBase trims one slash and serves the asset
    const asset = await head("/%2Fassets/index-Fx7Kq2Ab.js");
    expect(asset).toMatchObject({ status: 200, cacheControl: IMMUTABLE });
    expect(asset.contentType).toContain("javascript");
    // "/%2F%2Fassets/…": the value "//assets/…" stays absolute after trimming – PocketBase serves the SPA
    // fallback, which must not be cached as immutable
    for (const path of ["/%2F%2Fassets/index-Fx7Kq2Ab.js", "/%2F%2Fassets%2Findex-Fx7Kq2Ab.js"]) {
      const res = await head(path);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain("spa-fixture");
      expect(res.contentType, path).toContain("text/html");
      expect(res.cacheControl, path).toBe("no-cache");
    }
  });

  it("keeps the header on conditional requests (304)", async () => {
    const first = await fetch(`${PB_URL}/`);
    const lastModified = first.headers.get("last-modified");
    await first.text();
    expect(lastModified).toBeTruthy();

    const revalidated = await head("/", { headers: { "If-Modified-Since": lastModified! } });
    expect(revalidated).toMatchObject({ status: 304, cacheControl: "no-cache" });
  });

  it("leaves the API and the dashboard untouched", async () => {
    for (const path of ["/api/health", "/api/app/totals", "/_/"]) {
      const res = await head(path);
      expect(res.cacheControl, path).toBeNull();
    }
  });
});

describe("unknown API and dashboard paths", () => {
  it("get PocketBase's JSON 404 – never the SPA", async () => {
    const paths = [
      "/api",
      "/api/",
      "/api/unknown",
      "/api/app/totals/", // trailing slash: not the totals route
      "/api/app/totalz?parts=summary",
      "/api%2Funknown", // decoded "api/unknown"
      "/_%2Fsomething", // decoded "_/something" (not the dashboard route)
    ];
    for (const path of paths) {
      const res = await head(path, { headers: { Accept: "text/html" } });
      expect(res.status, path).toBe(404);
      expect(res.contentType, path).toContain("application/json");
      expect(JSON.parse(res.body), path).toEqual({ status: 404, message: "The requested resource wasn't found.", data: {} });
      expect(res.cacheControl, path).toBeNull();

      expect((await head(path, { method: "HEAD" })).status, `HEAD ${path}`).toBe(404);
    }
  });

  it("does not catch SPA paths that only start like them", async () => {
    for (const path of ["/apidoku", "/_x", "/API/unknown"]) {
      const res = await head(path);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain("spa-fixture");
      expect(res.cacheControl, path).toBe("no-cache");
    }
  });
});
