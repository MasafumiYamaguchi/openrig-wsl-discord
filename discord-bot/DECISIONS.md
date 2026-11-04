# Discordで本人に選択を求める方法

既存の統括役 `orch-lead@myteam` から本人へ質問するときの接続仕様です。チーム構成・モデル・担当範囲・優先順位を変更する指示ではありません。

## 質問の作成

OpenRig標準の `humanQuestions` を使用します。統括役自身の席から、`human@kernel` 宛てに質問を作成してください。宛先はBotの `config.json` の `decisionRecipient` と一致させます。現在、Discord Botはこの統括役からこの本人宛ての質問だけを表示します。

```json
[
  {
    "id": "next_step",
    "question": "どちらで進めますか？",
    "options": [
      {"id": "continue", "label": "提案内容で進める", "recommended": true},
      {"id": "hold", "label": "保留して相談する"}
    ]
  }
]
```

上のJSONをファイルへ保存し、質問・選択肢の意味、影響、実施範囲、検証済み事項と未確認事項を説明した本文ファイルを添えて送ります。本人が判断できる根拠のファイルを `--evidence-ref` に指定します。

```bash
rig queue create \
  --destination human@kernel \
  --summary '次の作業について本人の選択を確認' \
  --body-file /absolute/path/decision-brief.txt \
  --human-questions-file /absolute/path/questions.json \
  --evidence-ref /absolute/path/decision-evidence.md \
  --full --json
```

質問は1〜4問、各2〜4択。質問・選択肢IDは英数字・`_`・`-`の1〜40文字、質問文は500文字、選択肢ラベルは75文字までです。推奨は各問最大1つです。複数選択は扱わず、1問につき1つを選びます。

## 回答の扱い

Botが質問を15秒間隔で検出し、Discordの親チャンネルへ判断の説明と各設問のボタンを表示します。指定本人が押すと、質問ID・選択肢ID・DiscordユーザーIDと操作IDを対応させて、OpenRigの標準 `answer` 契約へ記録します。本人を `human@kernel` として申告し、Discordで本人を確認した旨を監査メモに残します。transportで検証済みの席として偽装しません。

一部の設問だけ回答した間は元の質問がpendingのままです。全問そろうとOpenRigが回答qitemを元の質問元へ返し、質問を閉じます。統括は返ってきた回答qitem・元の `humanAnswers` を読み、選ばれた内容と条件を守って続けてください。回答は質問で明示した範囲の意思表示です。承認以外の選択肢や保留も、その意味どおりに扱います。

Botのボタンは一度記録すると変更できません。変更したいときはPC側または追加回答で統括に相談し、新しい質問を出してください。古い質問の内容変更・期限切れ・PC側での回答・取消はクリック時に再確認します。通信切断時は同じ回答だけを再送確認し、別の選択肢へ自動変更しません。

通常の文章の質問やClaude CodeのAskUserQuestion画面、ツール実行のネイティブ権限確認は、このボタンと連動しません。Discordで選択してもらう質問は上記の標準qitemとして作成します。ツール権限の設定を変更したり、自動承認する機能ではありません。

Botの状態はWSLの `~/.local/state/openrig-discord/state.json` に保存されます。設定、モデル、役割、プロジェクトの規約は保持します。
