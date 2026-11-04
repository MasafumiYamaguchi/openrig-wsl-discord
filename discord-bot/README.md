# Discord Bot

既存の統括役へDiscordから依頼し、結果を受け取る中継Botです。Bot自身はAIモデルを起動せず、チームやモデルを変更しません。

## 接続準備

1. リポジトリ直下の `scripts/configure.py` で `config.json` を生成するか、`config.example.json` を `config.json` にコピーし、サーバーID・チャンネルID・自分のユーザーID・統括役の宛先を設定します。IDはDiscordの開発者モードでコピーできます。
2. [Discord Developer Portal](https://discord.com/developers/applications)でBotアプリを作成し、Botトークンを取得します。
3. WSLのリポジトリ直下で依存をインストールし、非表示入力の専用スクリプトへトークンを入力します。

   ```bash
   export PATH="$HOME/.local/share/openrig/node/bin:$HOME/.local/bin:$PATH"
   npm ci --prefix discord-bot --ignore-scripts
   bash scripts/discord-setup-token.sh
   ```

4. 表示された招待URLからサーバーへBotを追加します。表示・送信・公開スレッド作成・スレッド内送信・履歴読取を許可します。AdministratorやMessage Content intentは不要です。Interactions Endpoint URLは設定せず、Gateway接続を使います。
5. 既存チームが起動していることを確認し、次を実行します。

   ```bash
   bash scripts/discord-bot.sh doctor
   bash scripts/discord-bot.sh start
   ```

トークンはWSLの `~/.config/openrig-discord/bot.env` に権限600で保存されます。Git・会話・公開設定へ入れないでください。

PowerShellからは、clone先のルートで次を実行できます。別ディストリビューションを使う場合は `-Distro` を指定します。

```powershell
.\scripts\Set-DiscordBotToken.ps1 -Distro Ubuntu-24.04
.\scripts\Start-DiscordBot.ps1 -Mode doctor -Distro Ubuntu-24.04
.\scripts\Start-DiscordBot.ps1 -Distro Ubuntu-24.04
```

停止は専用ターミナルでCtrl+Cです。PC・WSL・OpenRig・Botの稼働中に利用でき、自動起動は設定しません。

## 操作

| コマンド | 動作 |
|---|---|
| `/rig request text:依頼内容` | 親チャンネルから統括へ依頼し、専用スレッドを作成 |
| `/rig status` | スレッド内ではその依頼、親チャンネルでは最近の依頼を表示 |
| `/rig result` | 依頼スレッド内で結果・現在の状態を確認 |
| `/rig reply text:回答` | 依頼スレッドで統括へ追加回答 |

通常のチャット本文は取り込みません。利用者・サーバー・チャンネルを設定で限定し、依頼スレッドも本人のものだけを扱います。進捗は15秒間隔でキューの変化を転送し、明示的な引き継ぎ先を追います。

`relayConversation: true` は統括の発言本文を親チャンネルへ転送します。初回は直近1件、その後は新しい発言だけを送ります。ユーザー入力、内部思考、ツール実行・結果、別担当の会話は転送しません。現在は同じWSL内のClaude Code席に対応し、OpenRigのSQLiteを読み取り専用で参照して正確なセッションUUIDのJSONLを読みます。Python 3が必要です。

`decisionButtons: true` は統括が `decisionRecipient`（既定 `human@kernel`）へ出したOpenRig標準 `humanQuestions` をボタンにします。新しい未回答のカードは許可ユーザーにメンションします。本人の選択を元質問へ記録し、全問そろうとOpenRigが回答を統括へ返します。[質問作成方法](DECISIONS.md)を統括に伝えてください。普通の文章の質問・Claudeの対話画面・ツール権限確認はボタンになりません。

## 保存と制約

状態は `~/.local/state/openrig-discord/state.json` に保存します。再起動で対応表を復元し、同じ作業IDで再試行します。直近のDiscord送信はnonceで重複を抑止しますが、長時間の障害では投稿が重複する場合があります。本文は最大24,000文字で、ローカルの完成物や根拠資料を自動添付しません。親チャンネルの閲覧者には転送した発言・質問が見えます。

APIアダプターは既定で `~/.local/lib/node_modules/@openrig/cli` を使います。配置が違う場合は `BRIDGE_OPENRIG_CLI_ROOT` を指定します。Mission Controlにbearer認証がある場合は起動環境の `OPENRIG_AUTH_BEARER_TOKEN` が必要です。これはDiscord Botトークンとは別の認証です。
