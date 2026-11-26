import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { createAppClient, type AppClient, type PendingSignIn } from "./index.js";
import {
  API_ORIGIN,
  APP_STATEMENT,
  MASTER,
  PAIRWISE,
  TRUST,
  fakeNet,
  jsonResponse,
  jwksWith,
  sealedJwksKey,
  sessionSigner,
  vectorP256,
  vectorVerifiers,
  type Handler,
} from "./test-fixtures.js";

const APP_ID = APP_STATEMENT.app;
const VERIFIERS = await vectorVerifiers();
const SESSION = await sessionSigner();
/** 見本の集約 JWKS に、封印者が署名したセッションの鍵を足したもの */
const ID_TOKEN = await sessionSigner("clavis-oidc-id-token-test", "oidc-id-token");
const JWKS = jwksWith(SESSION.jwksKey, ID_TOKEN.jwksKey);
const REDIRECT = "https://app.example/auth/clavis/callback";
const now = () => Math.floor(Date.now() / 1000);

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.alg = "EdDSA";
  return JSON.stringify(jwk);
}

async function atHash(accessToken: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)));
  return btoa(String.fromCharCode(...hash.subarray(0, 16))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Signing = { key?: CryptoKey; kid?: string; alg?: string; iat?: number; exp?: number };

/** id_token。既定はセッションの鍵で、iss・aud・sub・nonce・at_hash を正しく持つ */
async function idToken(claims: Record<string, unknown>, signing: Signing = {}): Promise<string> {
  const iat = signing.iat ?? now();
  return new SignJWT(claims)
    .setProtectedHeader({ alg: signing.alg ?? "ES256", kid: signing.kid ?? SESSION.kid })
    .setIssuedAt(iat)
    .setExpirationTime(signing.exp ?? iat + 900)
    .sign(signing.key ?? SESSION.privateKey);
}

type Token = { body?: Record<string, unknown>; status?: number; claims?: Record<string, unknown>; signing?: Signing; idToken?: string };

/**
 * App の BFF の作り物。`token` はトークンの口の答え（呼ばれた順に一つずつ）。トークンの口は、authorize の URL の
 * code_challenge と code_verifier を照らす（PKCE）。
 */
async function harness(token: Array<Token | ((form: URLSearchParams) => Token)> = [{}], extra: Handler = () => null) {
  const posts: Array<{ path: string; form: URLSearchParams; headers: Headers }> = [];
  const gets: Array<{ path: string; headers: Headers }> = [];
  let challenge: string | null = null;
  let nonce: string | null = null;
  let turn = 0;
  const net = fakeNet(
    async (url, init) => {
      if (init?.method === "POST" && url.pathname.startsWith("/oauth/")) {
        const form = new URLSearchParams(String(init.body));
        posts.push({ path: url.pathname, form, headers: new Headers(init.headers) });
        if (url.pathname !== "/oauth/token") return extra(url, init);
        const step = token[Math.min(turn, token.length - 1)]!;
        turn += 1;
        const t = typeof step === "function" ? step(form) : step;
        if (t.status && t.status !== 200) return jsonResponse(t.body ?? { error: "INVALID_GRANT", message: "refused", trace_id: "t-1" }, t.status);
        if (form.get("grant_type") === "authorization_code") {
          const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier")!)));
          const verified = btoa(String.fromCharCode(...sha)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          if (verified !== challenge) return jsonResponse({ error: "INVALID_GRANT", message: "pkce verification failed" }, 400);
        }
        const accessToken = `access-${turn}`;
        const claims = {
          iss: API_ORIGIN,
          aud: APP_ID,
          sub: PAIRWISE,
          ...(form.get("grant_type") === "authorization_code" ? { nonce } : {}),
          at_hash: await atHash(accessToken),
          ...t.claims,
        };
        return jsonResponse({
          access_token: accessToken,
          refresh_token: `refresh-${turn}`,
          token_type: "Bearer",
          expires_in: 900,
          id_token: t.idToken ?? (await idToken(claims, t.signing)),
          scope: "openid profile",
          ...t.body,
        });
      }
      if (url.pathname.startsWith("/oauth/")) gets.push({ path: url.pathname, headers: new Headers(init?.headers) });
      return extra(url, init);
    },
    { jwks: () => JWKS },
  );
  const client = createAppClient({
    apiOrigin: API_ORIGIN,
    appId: APP_ID,
    operatePrivateJwk: await operateJwk(),
    trustRoot: MASTER,
    verifiers: VERIFIERS,
    fetchImpl: net.fetchImpl,
  });
  /** サインインを始め、Clavis が戻すときの URL を返す */
  async function begin(input: Partial<Parameters<AppClient["beginSignIn"]>[0]> = {}) {
    const { url, pending } = await client.beginSignIn({ redirectUri: REDIRECT, ...input });
    const q = new URL(url).searchParams;
    challenge = q.get("code_challenge");
    nonce = q.get("nonce");
    return { url, pending, q, callback: `${REDIRECT}?code=code-1&state=${encodeURIComponent(q.get("state")!)}` };
  }
  return { client, net, posts, gets, begin };
}

describe("beginSignIn", () => {
  it("builds the authorization URL with PKCE and keeps the verifier out of it", async () => {
    const { begin, net } = await harness();
    const { url, pending, q } = await begin({ scope: ["org.role", "profile"], uiLocales: ["ja", "en-GB"] });
    expect(url.startsWith(`${API_ORIGIN}/oauth/authorize?`)).toBe(true);
    expect(Object.fromEntries(q)).toEqual({
      response_type: "code",
      client_id: APP_ID,
      redirect_uri: REDIRECT,
      scope: "openid profile org.role",
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: q.get("code_challenge"),
      code_challenge_method: "S256",
      ui_locales: "ja en-GB",
    });
    expect(url).not.toContain(pending.codeVerifier);
    expect(pending).toEqual({ state: expect.any(String), nonce: expect.any(String), codeVerifier: expect.any(String), redirectUri: REDIRECT, scope: "openid profile org.role" });
    expect(new Set([pending.state, pending.nonce, pending.codeVerifier]).size).toBe(3);
    // 始めるだけでは Clavis に何も送らない
    expect(net.calls).toEqual([]);
  });

  it("asks for openid alone by default, and makes new values each time", async () => {
    const { begin } = await harness();
    const a = await begin();
    const b = await begin();
    expect(a.q.get("scope")).toBe("openid");
    expect(a.q.has("ui_locales")).toBe(false);
    expect(a.pending.state).not.toBe(b.pending.state);
    expect(a.pending.nonce).not.toBe(b.pending.nonce);
  });

  it("refuses a redirect URI that is not https, an unknown scope and bad language tags", async () => {
    const { client } = await harness();
    for (const redirectUri of ["http://app.example/cb", "app.example/cb", "https://u:p@app.example/cb", "https://app.example/cb#x"]) {
      await expect(client.beginSignIn({ redirectUri })).rejects.toMatchObject({ code: "invalid_sign_in_args" });
    }
    await expect(client.beginSignIn({ redirectUri: "http://localhost:3000/cb" })).resolves.toBeTruthy();
    await expect(client.beginSignIn({ redirectUri: REDIRECT, scope: ["email" as "profile"] })).rejects.toMatchObject({
      code: "invalid_sign_in_args",
    });
    await expect(client.beginSignIn({ redirectUri: REDIRECT, uiLocales: ["日本語"] })).rejects.toMatchObject({ code: "invalid_ui_locales" });
  });
});

describe("completeSignIn", () => {
  it("exchanges the code with the verifier and returns the checked sub", async () => {
    const { client, begin, posts } = await harness([{ claims: { name: "Aoi" } }]);
    const { pending, callback } = await begin({ scope: ["profile"] });
    const signIn = await client.completeSignIn(callback, pending);
    expect(signIn).toEqual({
      iss: API_ORIGIN,
      sub: PAIRWISE,
      name: "Aoi",
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        idToken: expect.any(String),
        expiresAt: expect.any(Number),
        scope: ["openid", "profile"],
      },
    });
    expect(Math.abs(signIn.tokens.expiresAt - (now() + 900))).toBeLessThanOrEqual(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(posts[0]!.form)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: REDIRECT,
      client_id: APP_ID,
      code_verifier: pending.codeVerifier,
    });
  });

  it("reads the return as a URL, a query string or its parameters", async () => {
    const { client, begin } = await harness([{}]);
    const { pending, callback } = await begin();
    const query = new URL(callback).search;
    for (const form of [new URL(callback), query, query.slice(1), new URLSearchParams(query)]) {
      await expect(client.completeSignIn(form, pending)).resolves.toMatchObject({ sub: PAIRWISE });
    }
  });

  it("stops at a missing or different state before sending anything", async () => {
    const { client, begin, posts } = await harness();
    const { pending } = await begin();
    for (const callback of [`${REDIRECT}?code=c`, `${REDIRECT}?code=c&state=`, `${REDIRECT}?code=c&state=other`]) {
      await expect(client.completeSignIn(callback, pending)).rejects.toMatchObject({ code: "state_mismatch" });
    }
    // 断りの戻りも、state が違えば読まない
    await expect(client.completeSignIn(`${REDIRECT}?error=access_denied&state=other`, pending)).rejects.toMatchObject({
      code: "state_mismatch",
    });
    expect(posts).toEqual([]);
  });

  it("maps access_denied to declined and every other refusal to unavailable", async () => {
    const { client, begin, posts } = await harness();
    const { pending } = await begin();
    const back = (error: string) => `${REDIRECT}?error=${error}&state=${encodeURIComponent(pending.state)}`;
    await expect(client.completeSignIn(back("access_denied"), pending)).rejects.toMatchObject({ code: "declined", apiError: "access_denied" });
    for (const error of ["unauthorized_client", "server_error", "invalid_scope"]) {
      await expect(client.completeSignIn(back(error), pending)).rejects.toMatchObject({ code: "unavailable", apiError: error });
    }
    expect(posts).toEqual([]);
  });

  it("maps a refused exchange to unavailable, including the same return used twice", async () => {
    const { client, begin } = await harness([{}, { status: 400, body: { error: "INVALID_GRANT", message: "unknown or expired code", trace_id: "t-9" } }]);
    const { pending, callback } = await begin();
    await client.completeSignIn(callback, pending);
    await expect(client.completeSignIn(callback, pending)).rejects.toMatchObject({
      code: "unavailable",
      status: 400,
      apiError: "INVALID_GRANT",
      traceId: "t-9",
    });
    const gate = await harness([{ status: 400, body: { error: "INVALID_CLIENT", message: "client not authorized for federation" } }]);
    const started = await gate.begin();
    await expect(gate.client.completeSignIn(started.callback, started.pending)).rejects.toMatchObject({ code: "unavailable", apiError: "INVALID_CLIENT" });
    const down = await harness([{ status: 502, body: undefined }]);
    const again = await down.begin();
    await expect(down.client.completeSignIn(again.callback, again.pending)).rejects.toMatchObject({ code: "unavailable", status: 502 });
  });

  it("refuses a return that names another issuer, or carries no code", async () => {
    const { client, begin } = await harness();
    const { pending } = await begin();
    const state = encodeURIComponent(pending.state);
    await expect(client.completeSignIn(`${REDIRECT}?code=c&state=${state}&iss=https://api.other.test`, pending)).rejects.toMatchObject({
      code: "invalid_callback",
    });
    await expect(client.completeSignIn(`${REDIRECT}?state=${state}`, pending)).rejects.toMatchObject({ code: "invalid_callback" });
  });

  it("refuses a pending value that beginSignIn did not make", async () => {
    const { client, begin } = await harness();
    const { pending, callback } = await begin();
    for (const bad of [null, {}, { ...pending, codeVerifier: "short" }, { ...pending, scope: "profile" }, { ...pending, redirectUri: "http://app.example/cb" }]) {
      await expect(client.completeSignIn(callback, bad as unknown as PendingSignIn)).rejects.toMatchObject({ code: "invalid_sign_in_args" });
    }
  });

  it("refuses a token response without the tokens", async () => {
    for (const body of [{ id_token: undefined }, { token_type: "mac" }, { expires_in: "900" }, { refresh_token: 7 }]) {
      const { client, begin } = await harness([{ body }]);
      const { pending, callback } = await begin();
      await expect(client.completeSignIn(callback, pending)).rejects.toMatchObject({ code: "invalid_token_response" });
    }
  });
});

describe("the id_token", () => {
  async function refused(token: Token, reason: string) {
    const { client, begin } = await harness([token]);
    const { pending, callback } = await begin();
    const error = await client.completeSignIn(callback, pending).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "id_token_invalid" });
    expect(String((error as Error).message)).toContain(`(${reason})`);
  }

  it("accepts an ID token signed by the dedicated key while the session key is still published", async () => {
    const { client, begin } = await harness([{ signing: { key: ID_TOKEN.privateKey, kid: ID_TOKEN.kid } }]);
    const { pending, callback } = await begin();
    expect((await client.completeSignIn(callback, pending)).sub).toBe(PAIRWISE);
  });

  it("refuses one whose signature was tampered with", async () => {
    const { client, begin } = await harness([
      {
        idToken: await (async () => {
          const [h, p, s] = (await idToken({ iss: API_ORIGIN, aud: APP_ID, sub: PAIRWISE })).split(".");
          const claims = { ...JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/"))), sub: "someone-else" };
          const forged = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          return `${h}.${forged}.${s}`;
        })(),
      },
    ]);
    const { pending, callback } = await begin();
    await expect(client.completeSignIn(callback, pending)).rejects.toMatchObject({ code: "id_token_invalid" });
  });

  it("refuses an expired one, and one issued too long ago or in the future", async () => {
    await refused({ signing: { iat: now() - 1200, exp: now() - 300 } }, "exp");
    await refused({ signing: { iat: now() - 900, exp: now() + 900 } }, "iat");
    await refused({ signing: { iat: now() + 600, exp: now() + 1200 } }, "iat");
  });

  it("refuses another audience, issuer or nonce", async () => {
    await refused({ claims: { aud: "another-app" } }, "aud");
    await refused({ claims: { aud: [APP_ID, "another-app"] } }, "aud");
    await refused({ claims: { azp: "another-app" } }, "azp");
    await refused({ claims: { iss: "https://api.other.test" } }, "iss");
    // 別のサインインの id_token の持ち込み（nonce が違う）
    await refused({ claims: { nonce: "nonce-of-another-sign-in" } }, "nonce");
    await refused({ claims: { nonce: undefined } }, "nonce");
  });

  it("refuses one for an access token it was not issued with", async () => {
    await refused({ claims: { at_hash: await atHash("another-access-token") } }, "at_hash");
  });

  it("refuses a key outside the sign-in slots of the JWKS that chains to the trust root", async () => {
    // 集約 JWKS にない鍵
    const stray = await generateKeyPair("ES256");
    await refused({ signing: { key: stray.privateKey as CryptoKey, kid: "clavis-wauthn-auth-jwt-zzzz" } }, "kid");
    // 集約 JWKS にあるが、セッションの枠ではない鍵（受領の副署の鍵）
    const receiptKey = await vectorP256("sign-receipt");
    const receiptKid = (JSON.parse(TRUST.jwks) as { keys: { kid: string; "clavis-slot": string }[] }).keys.find((k) => k["clavis-slot"] === "sign-receipt")!.kid;
    await refused({ signing: { key: receiptKey.privateKey, kid: receiptKid } }, "kid");
    // セッションの kid を名乗るが、別の鍵の署名
    await refused({ signing: { key: stray.privateKey as CryptoKey } }, "signature");
    // ES256 でないもの
    const hs = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
    await refused(
      {
        idToken: await new SignJWT({ iss: API_ORIGIN, aud: APP_ID, sub: PAIRWISE }).setProtectedHeader({ alg: "HS256", kid: SESSION.kid }).setIssuedAt().setExpirationTime("10m").sign(hs),
      },
      "alg",
    );
  });

  it("refuses a session key the sealer did not sign", async () => {
    const forged = await sessionSigner("clavis-wauthn-auth-jwt-forged");
    const other = await vectorP256("other-master");
    const badKey = { ...(await sealedJwksKey("wauthn-auth-jwt", forged.kid, other.jwk)), "clavis-sealer-signature": (forged.jwksKey as { "clavis-sealer-signature": string })["clavis-sealer-signature"] };
    const net = fakeNet(() => null, { jwks: () => jwksWith(SESSION.jwksKey, badKey) });
    const client = createAppClient({ apiOrigin: API_ORIGIN, appId: APP_ID, operatePrivateJwk: await operateJwk(), trustRoot: MASTER, verifiers: VERIFIERS, fetchImpl: net.fetchImpl });
    // 封印者の署名が鍵と合わない JWKS は、照合器が断る（trustRoot につながらない）
    await expect(client.verifier.trust()).rejects.toMatchObject({ code: "invalid_trust_root" });
  });

  it("fetches the JWKS once more for a session key it does not hold yet", async () => {
    const rotated = await sessionSigner("clavis-wauthn-auth-jwt-next");
    let served = TRUST.jwks;
    const posts: string[] = [];
    let nonce = "";
    const net = fakeNet(
      async (url, init) => {
        if (url.pathname !== "/oauth/token") return null;
        posts.push(String(init?.body));
        const accessToken = "access-r";
        return jsonResponse({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 900,
          id_token: await idToken({ iss: API_ORIGIN, aud: APP_ID, sub: PAIRWISE, nonce, at_hash: await atHash(accessToken) }, { key: rotated.privateKey, kid: rotated.kid }),
        });
      },
      { jwks: () => served },
    );
    const client = createAppClient({ apiOrigin: API_ORIGIN, appId: APP_ID, operatePrivateJwk: await operateJwk(), trustRoot: MASTER, verifiers: VERIFIERS, fetchImpl: net.fetchImpl });
    // 手元の JWKS を先に読ませておく（新しい鍵はまだ無い）
    await client.verifier.trust();
    served = jwksWith(rotated.jwksKey);
    const { url, pending } = await client.beginSignIn({ redirectUri: REDIRECT });
    nonce = new URL(url).searchParams.get("nonce")!;
    const signIn = await client.completeSignIn(`${REDIRECT}?code=c&state=${encodeURIComponent(pending.state)}`, pending);
    expect(signIn.sub).toBe(PAIRWISE);
    expect(signIn.tokens.refreshToken).toBeUndefined();
    expect(net.calls.filter((c) => c.endsWith("/v1/jwks.json"))).toHaveLength(2);
  });
});

describe("refreshSignIn", () => {
  it("refreshes and checks the new id_token names the same user", async () => {
    const { client, posts } = await harness([{}]);
    const signIn = await client.refreshSignIn({ refreshToken: "refresh-0", sub: PAIRWISE });
    expect(signIn).toMatchObject({ iss: API_ORIGIN, sub: PAIRWISE, tokens: { accessToken: "access-1", refreshToken: "refresh-1" } });
    expect(Object.fromEntries(posts[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-0", client_id: APP_ID });
  });

  it("refuses another user, and maps a refused refresh to unavailable", async () => {
    const { client } = await harness([{ claims: { sub: "someone-else" } }, { status: 400, body: { error: "INVALID_GRANT", message: "consent is not in force" } }]);
    await expect(client.refreshSignIn({ refreshToken: "r", sub: PAIRWISE })).rejects.toMatchObject({ code: "id_token_invalid" });
    await expect(client.refreshSignIn({ refreshToken: "r", sub: PAIRWISE })).rejects.toMatchObject({ code: "unavailable", apiError: "INVALID_GRANT" });
    await expect(client.refreshSignIn({ refreshToken: "", sub: PAIRWISE })).rejects.toMatchObject({ code: "invalid_sign_in_args" });
  });
});

describe("revokeSignIn, endSessionUrl and orgMembership", () => {
  it("posts the token to revoke", async () => {
    const { client, posts } = await harness([], (url) => (url.pathname === "/oauth/revoke" ? new Response(null, { status: 200 }) : null));
    await client.revokeSignIn("refresh-1", { tokenTypeHint: "refresh_token" });
    expect(Object.fromEntries(posts[0]!.form)).toEqual({ token: "refresh-1", client_id: APP_ID, token_type_hint: "refresh_token" });
    const refused = await harness([], (url) => (url.pathname === "/oauth/revoke" ? jsonResponse({ error: "RATE_LIMITED" }, 429) : null));
    await expect(refused.client.revokeSignIn("t")).rejects.toMatchObject({ code: "revoke_failed", status: 429 });
  });

  it("builds the sign-out URL without sending anything", async () => {
    const { client, net } = await harness();
    const url = new URL(client.endSessionUrl({ postLogoutRedirectUri: "https://app.example/bye", state: "s1", idTokenHint: "id.token" }));
    expect(`${url.origin}${url.pathname}`).toBe(`${API_ORIGIN}/oauth/end-session`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      post_logout_redirect_uri: "https://app.example/bye",
      state: "s1",
      id_token_hint: "id.token",
    });
    expect(client.endSessionUrl()).toBe(`${API_ORIGIN}/oauth/end-session?client_id=${APP_ID}`);
    expect(() => client.endSessionUrl({ postLogoutRedirectUri: "http://app.example/bye" })).toThrow(expect.objectContaining({ code: "invalid_sign_in_args" }));
    expect(net.calls).toEqual([]);
  });

  it("reads the role in the app's Org with the access token", async () => {
    const answer = { sub: PAIRWISE, app_id: APP_ID, org_id: "jp1.0b4f7e1c-2a3d-4b5c-8d9e-0f1a2b3c4d5e", org_role: "admin" };
    let reply: Response = jsonResponse(answer);
    const { client, gets } = await harness([], (url) => (url.pathname === "/oauth/org-membership" ? reply : null));
    await expect(client.orgMembership("access-1")).resolves.toEqual({ sub: PAIRWISE, appId: APP_ID, orgId: answer.org_id, orgRole: "admin" });
    expect(gets[0]!.headers.get("authorization")).toBe("Bearer access-1");
    reply = jsonResponse({ ...answer, org_role: null });
    await expect(client.orgMembership("access-1")).resolves.toMatchObject({ orgRole: null });
    reply = jsonResponse({ ...answer, app_id: "another-app" });
    await expect(client.orgMembership("access-1")).rejects.toMatchObject({ code: "invalid_org_membership" });
    reply = jsonResponse({ error: "INSUFFICIENT_SCOPE", message: "org.role scope required" }, 403);
    await expect(client.orgMembership("access-1")).rejects.toMatchObject({ code: "org_membership_failed", status: 403, apiError: "INSUFFICIENT_SCOPE" });
  });
});

describe("the test keys", () => {
  it("derive the vector sealer, so the session key added to the JWKS chains to the trust root", async () => {
    const sealer = await vectorP256("sealer");
    const nominated = (JSON.parse(TRUST.jwks) as { sealer: { payload: { sealer_public_jwk: { x: string; y: string } } } }).sealer.payload.sealer_public_jwk;
    expect([sealer.jwk.x, sealer.jwk.y]).toEqual([nominated.x, nominated.y]);
    const net = fakeNet(() => null, { jwks: () => JWKS });
    const client = createAppClient({ apiOrigin: API_ORIGIN, appId: APP_ID, operatePrivateJwk: await operateJwk(), trustRoot: MASTER, verifiers: VERIFIERS, fetchImpl: net.fetchImpl });
    const facts = await client.verifier.trust();
    expect(facts.keys).toContainEqual({ kid: SESSION.kid, slot: "wauthn-auth-jwt", alg: "ES256" });
    expect(decodeJwt(await idToken({ sub: PAIRWISE })).sub).toBe(PAIRWISE);
  });
});
