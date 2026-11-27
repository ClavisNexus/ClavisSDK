# エージェント向けの指示

## 公開

このリポジトリは公開である。npm の `@clavis.nexus/*` はすでに公開されており、source map でソースも読める。PR のタイトルと本文（編集の履歴を含む）、コミット文、Actions のログと job summary も誰でも読める。

- 見知らぬ人が読んでよいことだけを書く。秘密、公開済みの窓口以外の連絡先、手元のマシンのパスを書かない
- ここから辿れるものだけを引く。このリポのファイル、Collatio などの公開リポ（リポ名を添える）、`https://docs.clavis.nexus` などの公開ページ。非公開リポの設計正本の名前と節番号、パスは書かない
- 出すことがまだ決まっていない作業（このリポの外の判断を待つ新しい形・操作・振る舞い）は手元の枝に置く。決まるまで、その枝を push せず、PR もタグも公開もしない。push した枝は消してもコミットで読め、その push で走る Actions の run は枝の名とコミット文の全体を持ち続ける
- `.github/public-surface.mjs` が CI でファイルを、publish で pack した tarball を確かめる。リポの外を指してよいものは `.github/public-surface.json` の `allowRefs` に足す。スクリプトに分からないもの（内部語・予定）は ClavisNexus の `docs/engineering/public-surfaces.md` に並べてある。スクリプトは公開リポで同じ内容なので、直すときは全部を同じブランチ名で直す

## 公開パッケージの文案

`packages/*` の README・`package.json` の `description`・CLI ヘルプ・MCP ツールの説明・公開 export の JSDoc・エンドユーザー向けの UI 文言は、App を組み込む開発者と developers で Org／App を用意する契約者が読む。

- 出してよい: 顧客が触る製品語（Clavis、Connect、developers、Org、App、Passkey、API としての Intent）、公開 API の識別子（`operate`、`master`、`message_digest`、`consume_url`、`poll_secret` など）、`https://docs.clavis.nexus` と npm 上の他の `@clavis.nexus/*`、呼び出し側が次の一手を決めるのに必要な事実（TTL、必須 env、エラー `code`）
- 出さない: 上の「公開」で書かないもの、プラットフォームの内部語を顧客向けの説明に持ち込むこと、顧客向けの本番／開発／staging の区分（Clavis にその区分はない）、売り文句、実装段階名を行為名にすること、ワークスペース内だけのパスや `pnpm --filter` を公開 README の手順の本体にすること
- 読み手（組み込む開発者／契約者）を混ぜない。見出しの下は範囲の一文まで。手順は写せるコマンド／JSON／HTTP を本体にする
- 「〜ではない」で偽友を潰さない。偽友はラベルか区画で解く
- 決済ベンダー名を手続ヒントの主語にしない（「カードの Checkout」など顧客が行う行為で書く）
- 日本語と英語を併記するときは直訳しない。キーは共有し、文面は各言語で書く
- 公開面を直したら、同じ変更で `package.json` の `description` と MCP／CLI の説明も顧客向けの語に揃える

## Git

commit・push・PR の作成と merge・タグの push は、人の確認を待たずにエージェント（Claude Code・Cursor）が行う。事故は下の ruleset とフックが止め、エージェントの縛りに触れた変更は週次の `Agent watch` が人に並べる。正本は ClavisNexus の `docs/engineering/git-workflow.md`。

- 作業はセッションごとの worktree で、`origin/main` から切った `claude/<topic>` か `cursor/<topic>` のブランチで行う: `git worktree add .worktrees/<topic> -b cursor/<topic> origin/main`
- `main` へは PR だけ。必須のチェックが通ったら自分で `gh pr merge --squash` する。`main` が進んでいたら `gh pr update-branch` してチェックを待ち直す。落ちたチェックは直し、避けて通さない
- PR のタイトルがコミット文になる。英語の 1〜2 文で何をなぜ変えたかを書き、ピリオドで終える。`feat:` などの接頭辞は付けない
- タグは、チェックが全部終わって通った `main` のコミットにだけ打ち、動かさない。リリースは、版を上げる PR を merge してから、そのコミットに `<dir>-v<version>` を打つ（README「npm 公開」）。タグは npm に staged で積むだけで、公開は人が npmjs.com で承認する
- 人に返すもの: ruleset・ブランチ保護・リポや org の設定・Actions の権限・secret と variable を変えること、`git push --no-verify` などフックを飛ばすこと。何をなぜ変えるかを書いて止まる。ruleset を変えた人は同じ変更で `.github/rulesets.json` を直す
- clone ごとに一度 `git config core.hooksPath .githooks`
