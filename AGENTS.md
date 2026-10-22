# エージェント向けの指示

## Git

commit・push・PR の作成と merge・タグの push は、人の確認を待たずにエージェント（Claude Code・Cursor）が行う。事故は下の ruleset とフックが止め、エージェントの縛りに触れた変更は週次の `Agent watch` が人に並べる。正本は ClavisNexus の `docs/engineering/git-workflow.md`。

- 作業はセッションごとの worktree で、`origin/main` から切った `claude/<topic>` か `cursor/<topic>` のブランチで行う: `git worktree add .worktrees/<topic> -b cursor/<topic> origin/main`
- `main` へは PR だけ。必須のチェックが通ったら自分で `gh pr merge --squash` する。`main` が進んでいたら `gh pr update-branch` してチェックを待ち直す。落ちたチェックは直し、避けて通さない
- PR のタイトルがコミット文になる。英語の 1〜2 文で何をなぜ変えたかを書き、ピリオドで終える。`feat:` などの接頭辞は付けない
- タグは、チェックが全部終わって通った `main` のコミットにだけ打ち、動かさない。リリースは、版を上げる PR を merge してから、そのコミットに `<dir>-v<version>` を打つ（README「npm 公開」）。タグは npm に staged で積むだけで、公開は人が npmjs.com で承認する
- 人に返すもの: ruleset・ブランチ保護・リポや org の設定・Actions の権限・secret と variable を変えること、`git push --no-verify` などフックを飛ばすこと。何をなぜ変えるかを書いて止まる。ruleset を変えた人は同じ変更で `.github/rulesets.json` を直す
- clone ごとに一度 `git config core.hooksPath .githooks`
