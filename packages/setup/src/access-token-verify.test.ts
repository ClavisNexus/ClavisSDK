import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDevelopersAccessToken } from "./access-token-verify.js";

const originalFetch = globalThis.fetch;

/** 集約 JWKS の鍵（スロットは鍵の欄 `clavis-slot`） */
async function key(kid: string, slot: string): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "ES256";
  (publicJwk as Record<string, unknown>)["clavis-slot"] = slot;
  return { privateKey: pair.privateKey, publicJwk };
}

function serve(origin: string, keys: JWK[]): void {
  globalThis.fetch = async (input) => {
    expect(String(input)).toBe(`${origin}/.well-known/jwks.json`);
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("verifyDevelopersAccessToken", () => {
  it("accepts a session access token and rejects keys of other slots", async () => {
    const origin = "https://api.example";
    const session = await key("clavis-wauthn-auth-jwt-k7mq", "wauthn-auth-jwt");
    // kid の形が似ていても、スロットの欄で見る
    const intent = await key("clavis-wauthn-auth-jwt-zz22", "sign-receipt");
    serve(origin, [session.publicJwk, intent.publicJwk]);
    const access = await new SignJWT({ tk: "access", sv: 1 })
      .setProtectedHeader({ alg: "ES256", kid: "clavis-wauthn-auth-jwt-k7mq" })
      .setIssuer(origin)
      .setAudience(origin)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(session.privateKey);
    await expect(verifyDevelopersAccessToken(access, origin)).resolves.toMatchObject({ sub: "user-1" });

    const other = await new SignJWT({ tk: "access", sv: 1 })
      .setProtectedHeader({ alg: "ES256", kid: "clavis-wauthn-auth-jwt-zz22" })
      .setIssuer(origin)
      .setAudience(origin)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(intent.privateKey);
    await expect(verifyDevelopersAccessToken(other, origin)).rejects.toThrow(/invalid_access_token_kid/);
  });

  it("rejects a token without tk=access", async () => {
    const origin = "https://api.other.example";
    const session = await key("clavis-wauthn-auth-jwt-k7mq", "wauthn-auth-jwt");
    serve(origin, [session.publicJwk]);
    const token = await new SignJWT({ sv: 1 })
      .setProtectedHeader({ alg: "ES256", kid: "clavis-wauthn-auth-jwt-k7mq" })
      .setIssuer(origin)
      .setAudience(origin)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(session.privateKey);
    await expect(verifyDevelopersAccessToken(token, origin)).rejects.toThrow(/invalid_access_token_kind/);
  });
});
