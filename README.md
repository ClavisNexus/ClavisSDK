# Clavis SDK

Clavis App 向けの公開 npm パッケージ。ライセンスは MIT。

| ディレクトリ | npm 名 | 役割 |
|---|---|---|
| `packages/app` | `@clavis.nexus/app` | サーバ SDK。リレーへの署名、委任の実行、台帳への記録と証拠束。照合器 Collatio が答える受領と記録を確かめる |
| `packages/app-shell` | `@clavis.nexus/app-shell` | ブラウザの準備オーバーレイ（署名依頼の登録まで） |
| `packages/setup` | `@clavis.nexus/setup` | developers 向けセットアップ CLI／MCP（Passkey と同意は人間） |

手順の正本は [docs.clavis.nexus](https://docs.clavis.nexus)。署名は `Authorization: ClavisEntity` と RFC 8785 の正準 JSON で、`POST /relay/v1/sign` のあと `POST /relay/v1/sign/complete` を送る。

---

## npm 公開（メンテナ）

`@clavis.nexus/*` は GitHub Actions（`.github/workflows/publish.yml`）から npm の Trusted Publishing で出す。npm トークンは使わない。手元からは公開しない。

1. `main` で `packages/<dir>/package.json` の `version` を上げてマージする（`X.Y.Z` のみ。npm の latest より上）
2. `main` の該当コミットに `<dir>-v<version>` のタグを打って push する

   ```bash
   git tag app-v4.0.0 && git push origin app-v4.0.0
   ```

3. ワークフローが検査・build・試験・pack のあと、npm に **staged** で積む。この時点では公開されない
4. 承認する前に、Actions の実行を開いて次を確かめる
   - タグ名と、Summary の commit が `main` 上のコミットであること
   - `stage` ジョブの Summary の integrity が、npmjs.com の Staged Packages に出ている integrity と同じこと
   - 中身を見るときは `npm stage download <stage-id>` で tarball を落とす
5. npmjs.com の Staged Packages で 2FA で Approve する。要らなければ Reject

公開の関門は 4〜5 の承認だけである。npm 側の Trusted Publisher は stage だけを許し（`npm publish` と `npm dist-tag` は許さない）、パッケージの Publishing access は「Require two-factor authentication and disallow tokens」にしておく。

`setup` は `@clavis.nexus/app` に依存する。`app` の新版を承認してから `setup` のタグを打つ。pack した `package.json` が npm に無い版の作業区画パッケージに依存していると、`scripts/release-check.mjs` が止める。

`app` は照合器 `@clavis.nexus/collatio` に正確な版で依存する。版を替えたら、照合器のリポジトリをその版のタグ（`vX.Y.Z`）にして `node scripts/sync-collatio.mjs` で試験の見本（`packages/app/src/vectors/collatio-ops-1.json`）を取り直す。

---

## 公開パッケージの文案ルール

`packages/*` は **npm に公開される顧客向け成果物**である。README・`package.json` の `description`・CLI ヘルプ・MCP ツール説明・公開 export の JSDoc・エンドユーザー向け UI 文言は、すべて公開面として扱う。社内設計メモ・姉妹リポジトリ・運用手順をここに載せない。違反は Clavis 基準ではインシデント扱いとする。

### 出してよい

- 顧客が触る製品語: Clavis、Connect、developers、Org、App、Passkey、Intent（API としての語）
- 公開 API の識別子: `operate`、`master`、`message_digest`、`consume_url`、`poll_secret` など
- 公開ドキュメント: `https://docs.clavis.nexus` および npm 上の他 `@clavis.nexus/*`
- 呼び出し側が次の一手を決めるのに必要な事実（TTL、必須 env、エラー `code`）

### 出さない

- 姉妹リポジトリ名（ClavisNexus / KiraKira / DeepDive 社内リポ）と、そこへの相対パス・社内設計正本リンク
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
