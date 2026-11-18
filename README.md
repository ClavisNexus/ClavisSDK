# Clavis SDK

Clavis App 向けの公開 npm パッケージ。ライセンスは MIT。

| ディレクトリ | npm 名 | 役割 |
|---|---|---|
| `packages/app` | `@clavis.nexus/app` | サーバ SDK。Clavis でのサインインと連携、署名依頼の登録、status、webhook ping、台帳への記録と証拠束。受領・委任の記録・証拠束は照合器 Collatio で確かめる |
| `packages/app-shell` | `@clavis.nexus/app-shell` | ブラウザの部品。準備オーバーレイ（Connect へ渡すまで）と、「Clavis でサインイン」「Clavis と連携」のボタン |
| `packages/setup` | `@clavis.nexus/setup` | developers 向けセットアップ CLI／MCP（Passkey と同意は人間） |

手順の正本は [docs.clavis.nexus](https://docs.clavis.nexus)。`message_digest` の計算はこのリポジトリの対象外。登録には、呼び出し側が用意した digest 文字列を渡す。

---

## npm 公開（メンテナ）

`@clavis.nexus/*` は GitHub Actions（`.github/workflows/publish.yml`）から npm の Trusted Publishing で出す。npm トークンは使わない。手元からは公開しない。

1. `main` で `packages/<dir>/package.json` の `version` を上げてマージする（`X.Y.Z` のみ。npm の latest より上）
2. `main` の該当コミットに `<dir>-v<version>` のタグを打って push する

   ```bash
   git tag app-v3.0.1 && git push origin app-v3.0.1
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

## 依存の監査（メンテナ）

`ci` は install の前に `pnpm run audit:security`（`scripts/audit-security.mjs`）を走らせ、`pnpm audit` の high 以上の勧告で落とす。毎日の schedule でも同じものが走る。

修正版がまだ無い勧告は直す手が無く、どの PR も同じ所で止まる。次をすべて満たすときだけ、`scripts/audit-exceptions.json` に例外を置いて通す。

- 公開するパッケージの依存に入らない。`pnpm audit --prod` には例外を当てず、そこに high 以上があれば必ず落とす
- 攻撃者が入力を渡せる経路が無い（build や試験の道具が、リポに書いた値だけを受け取るなど）
- 依存の更新や `overrides` で消せない

例外には勧告の ID・パッケージ・見つかった正確な版・理由・決めた日（`decided`）・期限（`until`、`decided` から 30 日まで）を書く。例外を置く・延ばす PR は必須のチェックを弱めるので、理由・影響・外す条件を本文に書き、merge の前に人に確かめる。

スクリプトは次のとき例外を当てずに落とす。修正版の公開と期限は毎日の schedule で見張る。

- 期限を過ぎた。勧告を読み直し、外すか延ばす
- 例外に無い版やパッケージが見つかった
- 修正版が公開され、`minimumReleaseAge`（7 日）が経った。経つまでは install できないので例外のまま通し、いつから入れられるかを出す。経ったら lockfile を上げて例外を外す
- 当たる勧告が無くなった。例外を外す
- audit や registry の応答を読めない

スクリプトの試験は `pnpm run test:scripts`（install は要らない）。
