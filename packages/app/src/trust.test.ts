import { describe, expect, it } from "vitest";
import { CATALOG_STALE_MS, TrustSurface } from "./trust.js";

const MASTER = { kty: "EC", crv: "P-256", x: "x", y: "y" } as JsonWebKey;

describe("trust surface freshness (genesis.md §10.1)", () => {
  it("counts staleness from the last successful fetch, not from the catalog's signature", async () => {
    let up = true;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (!up) throw new Error("offline");
      return new Response(String(url).endsWith("/v1/catalog.json") ? '{"type":"catalog@1","issued_at":1}' : '{"keys":[]}');
    }) as typeof fetch;
    const surface = new TrustSurface({ origins: ["https://trust.example"], master: MASTER, fetchImpl });
    expect(surface.stale()).toBe(false);
    await surface.documents();
    const fetched = Date.now();
    // 目録の署名が古くても（issued_at: 1）、取れたばかりなら古くない
    expect(surface.stale(fetched)).toBe(false);
    // 取り直せないまま 7 日を過ぎたら古い。取り直しを促しても、取れなければ古いまま
    up = false;
    surface.invalidate();
    await surface.documents();
    expect(surface.stale(fetched + CATALOG_STALE_MS - 1000)).toBe(false);
    expect(surface.stale(fetched + CATALOG_STALE_MS + 1000)).toBe(true);
  });
});
