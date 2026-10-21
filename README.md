# Clavis SDK

Clavis App 向けの公開 npm パッケージ。ライセンスは MIT。

| ディレクトリ | npm 名 | 役割 |
|---|---|---|
| `packages/app` | `@clavis.nexus/app` | サーバ SDK。署名依頼の登録、status、webhook ping、台帳への記録と証拠束。受領・委任の記録・証拠束は照合器 Collatio で確かめる |
| `packages/collatio` | （`@clavis.nexus/collatio` の写し） | 照合器（Collatio）の JS 層と WASM。`@clavis.nexus/collatio` を npm に出すまで `scripts/sync-collatio.mjs` で写す。公開しない |
| `packages/app-shell` | `@clavis.nexus/app-shell` | ブラウザの準備オーバーレイ（Connect へ渡すまで） |
| `packages/setup` | `@clavis.nexus/setup` | developers 向けセットアップ CLI／MCP（Passkey と同意は人間） |

手順の正本は [docs.clavis.nexus](https://docs.clavis.nexus)。`message_digest` の計算はこのリポジトリの対象外。登録には、呼び出し側が用意した digest 文字列を渡す。

---

## npm 公開（メンテナ）

`@clavis.nexus/*` を npm に出す手順。ルート `.npmrc` が `ignore-scripts=true` のため、`prepack` は走らない。**必ず先に build**する。公開前に各 `packages/*/package.json` の `version` を上げる。ブランチは `main`（`--publish-branch main`）。スコープは `publishConfig.access: public`。

### 個別

```bash
pnpm --filter @clavis.nexus/app build
pnpm --filter @clavis.nexus/app publish --access public --publish-branch main

pnpm --filter @clavis.nexus/app-shell build
pnpm --filter @clavis.nexus/app-shell publish --access public --publish-branch main

pnpm --filter @clavis.nexus/setup build
pnpm --filter @clavis.nexus/setup publish --access public --publish-branch main
```

`setup` は `@clavis.nexus/app` に依存する。`app` の新版を先に公開してから `setup` を出す。

`app` 3.0 は `@clavis.nexus/collatio` に依存する（いまは作業区画の写し `packages/collatio`）。照合器のリポジトリ（ClavisNexus/Collatio）が `@clavis.nexus/collatio` を出してから、`packages/app/package.json` の依存を出た版に替えて（`workspace:*` を外す）`app` を出す。照合器を替えたら `node scripts/sync-collatio.mjs` で写しと試験の見本（`packages/app/src/vectors/collatio-ops-1.json`）を取り直す。

### 3 件一括

依存順（`app` → `app-shell` → `setup`）でビルドし、同じ順で公開する。

```bash
pnpm -r build
pnpm -r publish --access public --publish-branch main
```

確認だけなら各コマンドに `--dry-run` を付ける。OTP が要るときは `--otp <code>`。

---

## 公開パッケージの文案ルール

`packages/*` は **npm に公開される顧客向け成果物**である。README・`package.json` の `description`・CLI ヘルプ・MCP ツール説明・公開 export の JSDoc・エンドユーザー向け UI 文言は、すべて公開面として扱う。社内設計メモ・姉妹リポジトリ・運用手順をここに載せない。違反は Clavis 基準ではインシデント扱いとする。

### 出してよい

- 顧客が触る製品語: Clavis、Connect、developers、Org、App、Passkey、Intent（API としての語）
- 公開 API の識別子: `operate`、`master`、`message_digest`、`consume_url`、`poll_secret` など
- 公開ドキュメント: `https://docs.clavis.nexus` および npm 上の他 `@clavis.nexus/*`
- 呼び出し側が次の一手を決めるのに必要な事実（TTL、必須 env、エラー `code`）

### 出さない

- 姉妹リポジトリ名（KiraKiraNexus / KiraKira / DeepDive 社内リポ）と、そこへの相対パス・社内設計正本リンク
- 社内ドキュメントパス（`docs/architecture/`、runbook、ops-console、封印・ゲート手順）
- プラットフォーム内部語（Dimension DO、Workers パス、`platform_approve`、`azp`、L2 など）を顧客向け説明に持ち込むこと
- 顧客向けの本番／開発／staging 環境区分（Clavis にその区分はない）
- brand-site の売り文句、「何か｜何かではない」の排除定義、実装段階名を行為名にすること
- モノレポ内だけのパスや `pnpm --filter` を、公開 README の手順の本体にすること（貢献者向けなら CONTRIBUTING 等へ分ける）

### 書き方

- 読み手は **App を組み込む開発者**または **developers で Org／App を用意する契約者**。混ぜない
- docs と同じく、見出しの下は範囲の一文まで。手順は写せるコマンド／JSON／HTTP を本体にする
- 「〜ではない」で偽友を潰さない。偽友はラベルか区画で解く
- 決済ベンダー名を手続ヒントの主語にしない（「カードの Checkout」など顧客が行う行為で書く）
- 日本語と英語を併記するときは直訳しない。キーは共有し、文面は各言語で書く
- 公開面を直したら、同じ変更で `package.json` の `description` と MCP／CLI の説明も顧客向け語に揃える
