# OpenRig WSL + Discord setup

Windows / WSL2でOpenRigのチームを動かし、スマホのDiscordから統括へ依頼・質問回答を送るための設定テンプレートとBotです。

[OpenRig](https://github.com/mvschwarz/openrig)本体とは別の、導入・運用補助リポジトリです。OpenRig本体やAI用CLI、認証情報、プロジェクトのコード・設計書・会話履歴は含みません。

## 含まれるもの

- WSL内へのNode.js / OpenRig / Claude Code / Codex導入スクリプト
- 4席のチーム構成・モデル設定、役割の汎用テンプレート
- Discordからの依頼・進捗・結果・追加回答
- 統括の発言本文の転送（現在はClaude Code席に対応）
- 選択質問のボタン回答と、質問時の本人メンション
- 別PCのパスとDiscord IDからローカル設定を生成するスクリプト

## 保存した構成

| 席 | Runtime | Model |
|---|---|---|
| 統括 `orch.lead` | Claude Code | `claude-opus-5-5` |
| 企画・要件 `planning.lead` | Codex | `gpt-6.1-sol` |
| 開発 `dev.lead` | Codex | `gpt-6.1-sol` |
| 品質 `quality.lead` | Codex | `gpt-6.1-sol` |

2026-11-04に読み取った稼働環境の構成をもとにしています。モデル名は保存時の指定値です。別アカウント・別バージョンでの利用可否は各自の環境で確認してください。生成スクリプトはモデルを自動変更しません。開発・品質のCodex権限設定も保存時の値（workspace-write / approval never / network enabled）を保持します。

プロジェクト固有の承認履歴・ブランチ名・作業指示は公開せず、役割の説明を汎用化しています。実作業の目的・承認範囲は新しい環境で指定してください。稼働中の席・セッションを移動するバックアップではありません。

## 別PCでの導入

前提はWindows 11、WSL2のUbuntu、Windows Terminal、Gitです。WSL側に `curl`、`xz-utils`、`python3`、`tmux` が必要です。スクリプトの既定ディストリビューション名は `Ubuntu-24.04` です。

1. このリポジトリをcloneし、WSLのターミナルでそのフォルダへ移動します。プロジェクト本体も別途用意してください。
2. 次を実行します。インストーラーはOpenRig `0.7.5` を指定し、AI用CLIを導入します。既存設定を変更する `setup-wsl.sh` は、実行前にユーザー設定をWSLホーム内へバックアップします。

   ```bash
   bash scripts/install-wsl.sh
   export PATH="$HOME/.local/share/openrig/node/bin:$HOME/.local/bin:$PATH"
   bash scripts/setup-wsl.sh
   ```

3. Claude CodeとCodexへ、それぞれ新PCでログインします。既存PCの認証ファイルをGitへコピーしないでください。
4. 対象プロジェクトのWSLパスとDiscord IDを指定します。下のIDは自分の値へ置き換えます。

   ```bash
   python3 scripts/configure.py \
     --project-dir /mnt/c/path/to/your-project \
     --rig-name myteam \
     --guild-id YOUR_GUILD_ID \
     --channel-id YOUR_CHANNEL_ID \
     --user-id YOUR_USER_ID
   ```

   `rigs/generated/` と `discord-bot/config.json` が生成されます。どちらもGit対象外です。生成済みファイルは上書きしません。チームだけ生成する場合は3つのID引数を省略できます。NodeやOpenRigの配置が異なる場合は `--openrig-cli-root` を指定します。

5. 生成された役割・モデル・権限・対象パスを確認してから起動します。生成自体では席は起動しません。

   ```bash
   rig spec validate rigs/generated/rig.yaml
   rig up rigs/generated/rig.yaml
   rig ps --nodes --rig myteam --json
   ```

6. Discord Botを設定して起動します。詳しくは [discord-bot/README.md](discord-bot/README.md)。

## PCを移るとき

AI用CLIのログインとBotトークン入力は新PCで行います。同じBotトークンを使って複数PCで同時にBotを動かすと、別々のOpenRigへ同じ依頼を処理するおそれがあるため、移行元のBotを止めてから移行先を起動してください。既存のBot依頼・質問の対応表と会話カーソルはWSLの `~/.local/state/openrig-discord/` にあり、この公開リポジトリには含みません。

WSL内で動く構成のため、Windows実機のビルド・デバイス・GPU検証が自動的に使えるわけではありません。その実行担当と手順は対象PCで決めてください。

## 検証

WSL / Linux、Node.js 22.12以降で実行します。

```bash
cd discord-bot
npm ci --ignore-scripts
npm test
```

BotはOpenRig `0.7.5` のCLIとMission Control回答APIに合わせています。OpenRigを更新したときはAPI・会話ファイル形式を再確認してください。自動テストはモックを使い、実際のDiscord投稿やチームへの依頼を作成しません。
