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
