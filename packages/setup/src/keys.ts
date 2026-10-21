import { exportJWK, generateKeyPair } from "jose";

export type OperateKeyPair = {
  kid: string;
  publicJwk: Record<string, unknown>;
  privateJwk: Record<string, unknown>;
  privateJwkJson: string;
};

export async function generateOperateKeyPair(): Promise<OperateKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const pub = (await exportJWK(publicKey)) as Record<string, unknown>;
  const priv = (await exportJWK(privateKey)) as Record<string, unknown>;
  const kid = `operate-${crypto.randomUUID().slice(0, 8)}`;
  pub.kid = kid;
  pub.alg = "EdDSA";
  priv.kid = kid;
  priv.alg = "EdDSA";
  return {
    kid,
    publicJwk: pub,
    privateJwk: priv,
    privateJwkJson: JSON.stringify(priv),
  };
}
