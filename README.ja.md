<h1 align="center">
  <img src="packages/web/public/icon.svg" alt="" width="64" valign="middle" /> Vasta
</h1>

<p align="center">
  <strong>ノート、タスク、毎日をひとつのアプリに。あなたのパソコンでも、あなた自身のサーバーでも。</strong><br/>
  ローカルファースト。オフラインで動作。始めるのにサーバーは不要で、いつでもサーバーに移行できます。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.es.md">Español</a> · <a href="README.zh-CN.md">简体中文</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="https://github.com/ariedotme/vasta/releases/latest"><img src="https://img.shields.io/github/v/release/ariedotme/vasta?style=flat&colorA=222222&colorB=4493F8&label=release" alt="最新リリース" /></a>
  <a href="https://github.com/ariedotme/vasta/blob/main/scripts/downloads-badge.mjs"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fariedotme%2Fvasta%2Fbadges%2Fdownloads.json&style=flat" alt="ダウンロード数：リリースファイルとサーバーイメージの pull" /></a>
  <a href="https://github.com/ariedotme/vasta/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ariedotme/vasta/ci.yml?style=flat&colorA=222222&colorB=3FB950&label=CI" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-222222?style=flat&colorA=222222&colorB=58A6FF" alt="ライセンス：AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/web%20%C2%B7%20macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-222222?style=flat&colorA=222222&colorB=8B949E" alt="Web、macOS、Windows、Linux" />
</p>

<p align="center">
  <a href="#はじめに">はじめに</a> ·
  <a href="#なぜ-vasta-か">なぜ Vasta か</a> ·
  <a href="#セルフホスト">セルフホスト</a> ·
  <a href="#デスクトップアプリ">デスクトップアプリ</a> ·
  <a href="#ドキュメント">ドキュメント</a> ·
  <a href="CONTRIBUTING.md">コントリビュート</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/today-dark.jpg" />
    <img src="docs/assets/today-light.jpg" alt="Vasta の「今日」：その日の予定、3 件のキャプチャが入ったデイリーノート、習慣" width="960" />
  </picture>
</p>

> これは[英語版 README](README.md) の翻訳です（2026-10-24 更新）。アプリと `docs/` のドキュメントは、今のところ英語のみです（[#34](https://github.com/ariedotme/vasta/issues/34)）。

Vasta は Capacities と Notion の、オープンソースでセルフホストできる代替です。すべてを型付きのオブジェクトとして保存します。ページ、タスク、本、人物、あるいは自分で作った型です。毎日にひとつのノートがあり、スマートフォンやブラウザ、エージェントからのキャプチャはそこに入ります。各デバイスがスペースのコピーを持つので、アプリはオフラインでも動きます。サーバーがすべてのデバイスを同期させます。

> [!NOTE]
> Vasta はアルファ版です。作者は毎日使っていますが、新しい部分もあります。バックアップを取ってください（[docs/deploy.md](docs/deploy.md#upgrading-and-backups)）。

Vasta が役に立ったら、GitHub で ⭐ を付けてください。ひとりで作っているプロジェクトで、スターが他の人に見つけてもらう手段になります。

## はじめに

<table>
<tr>
<th width="50%">自分のパソコンで</th>
<th width="50%">自分のサーバーで</th>
</tr>
<tr>
<td valign="top">

**サーバーも Docker も不要。設定することはありません。**

1. macOS、Windows、Linux 向けの[デスクトップアプリをダウンロード](https://github.com/ariedotme/vasta/releases/latest)します。
2. **Start on this computer** を選びます。

アプリが Vasta を代わりに動かします。ノートはそのパソコンに保存されます。

</td>
<td valign="top">

**スマートフォンを含むすべてのデバイスで使え、スペースを共有できます。**

1. Docker でサーバーを動かします（[セルフホスト](#セルフホスト)）。
2. ブラウザ、スマートフォン、またはデスクトップアプリで開きます。

Telegram、ブラウザ拡張、エージェントからのキャプチャがどこからでも届きます。

</td>
</tr>
</table>

> [!TIP]
> **まずパソコンで始めて、あとで移行。** スマートフォンや他の人を加えたくなったら、デスクトップアプリで Settings › Server › **Move to a server…** を開きます。サーバーのセットアップコードか招待リンクを貼り付けると、Vasta がノートとその履歴、ファイルをそこの新しいアカウントに移します。[仕組み →](docs/desktop.md#moving-to-a-server)

## 機能

<table>
<tr>
<td width="40%" valign="middle">

### 1 行でキャプチャ

⌘K、Telegram、またはデスクトップのショートカットに 1 行入力すると、Vasta がそこから型とプロパティを読み取ります：`/Task Ask Lena due:fri assignee:lena`

[キャプチャ →](docs/capture.md)

</td>
<td width="60%">
<img src="docs/assets/capture.gif" alt="⌘K パレットが 1 行から期限と担当者付きのタスクを作成する様子" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### 自分だけの型

どんなものにも型を作れます。テキスト、数値、日付、選択肢、リレーション、数式といったプロパティを付け、リスト、テーブル、ボード、グリッド、ウォール、ギャラリーで表示できます。

[データモデル →](docs/data-model.md)

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/types-dark.jpg" />
  <img src="docs/assets/types-light.jpg" alt="ギャラリー表示の「本」の型。表紙、著者、読書状況が並ぶ" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### チームで使う

スペースを他の人と共有できます。ボード、スプリント、コメント、@メンション、通知が使えます。フローメトリクスで仕事の進み具合がわかります。

[アカウントとスペース →](docs/accounts.md)

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/board-dark.jpg" />
  <img src="docs/assets/board-light.jpg" alt="未着手、進行中、完了の列があるタスクボード。担当者とプロジェクト付き" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### ひとつのカレンダー

デイリーノート、タスク、日付のあるオブジェクト、スプリント、予定がひとつのカレンダーに並びます。ほかのカレンダーも iCal リンクで追加できます。

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/calendar-dark.jpg" />
  <img src="docs/assets/calendar-light.jpg" alt="スプリント、タスク、予定が表示された月表示" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### あなたのエージェント、あなたのノート

Claude Code、Codex、スクリプトが、MCP エンドポイントと `vasta` コマンドを通じてノートを読み書きします。検索、クエリ、オブジェクトの作成、キャプチャ、習慣の記録ができます。エージェントは、いつでも無効にできるトークンを使ってあなたとして動きます。Vasta の中に AI はなく、モデルのキーも保存しません。

[エージェント →](docs/agents.md)

</td>
<td width="60%">

```sh
claude mcp add --transport http vasta \
  https://vasta.example.org/mcp \
  --header "Authorization: Bearer <token>"
```

> 今週の会議メモを読んで、私が約束したことをそれぞれ金曜締め切りのタスクにして。

</td>
</tr>
</table>

**Vasta にはほかにも：**

- **オフラインファースト**：各デバイスが SQLite にコピーを持ちます。2 台のデバイスでオフライン中に行った編集はマージされます。
- **ブロックエディタ**：スラッシュコマンド、`@` メンション、埋め込み、コールアウト、トグル、段組み、表、バックリンク。
- **テンプレートとスニペット**：型のオブジェクトや毎日のノートをテンプレートから始められます。プレースホルダー（`{{date:+7d}}`、`{{ask:With whom?}}`）や、条件を満たすときだけ表示されるブロックも使えます。スニペットは `/` で挿入します。[テンプレート →](docs/data-model.md#templates-and-snippets)
- **保存したリンク**にはプレビュー、ページの読みやすいコピー、埋め込みが残ります。
- **習慣とリマインダー**を ntfy、Telegram、デスクトップアプリで通知。[リマインダー →](docs/reminders.md)
- **食事日記**と栄養目標（オンにした場合）。
- **アプリ**：スマートフォンに Web アプリをインストールできます（PWA）。デスクトップアプリはグローバルなキャプチャショートカットを追加します。
- **メディア**はディスクまたは S3 互換のバケットに保存。
- Capacities からの**インポート**。

## なぜ Vasta か

- **Capacities** も型付きのオブジェクトと毎日のノートという同じ考え方ですが、クローズドソースで、ノートは Capacities のサーバーに置かれます。Vasta はあなたのパソコンかサーバーで動き、オフラインでも使え、Capacities のスペースを取り込むインポーターがあります。
- **Notion** はクラウドにあり、Notion のアカウントが必要です。Vasta は各デバイスに完全なコピーを持ち、あなたのサーバーを通じて同期します。
- **Obsidian** は Markdown ファイルをディスクに保存します。同期は有料サービスか自分で用意する必要があり、Vault を他の人と共有するのは大変です。Vasta は型とビューを備え、自分のサーバーと同期し、スペースを他の人と共有できます。Markdown ファイルとしては保存しません（エクスポートは[予定](https://github.com/ariedotme/vasta/issues/1)しています）。
- **AFFiNE と AppFlowy** もオープンソースで、ずっと多くのことができます（ホワイトボード、AI、クラウド）。そのセルフホストのサーバーは、自前のサービスに加えて Postgres と Redis で動きます。Vasta のサーバーはコンテナひとつと SQLite ファイルひとつで、デイリーノート、型付きのオブジェクト、すばやいキャプチャ（Telegram、デスクトップのショートカット、ブラウザ拡張、エージェント）に絞っています。

ネイティブのスマートフォンアプリ（Vasta はインストールできる Web アプリです）、プレーンな Markdown ファイル、または複数人が同じノートに同時に入力すること（[#22](https://github.com/ariedotme/vasta/issues/22)）が必要なら、Vasta はまだ向いていません。

## セルフホスト

Docker が必要です。サーバー上で次の手順を実行します：

```sh
mkdir vasta && cd vasta
curl -o compose.yml https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
docker compose up -d
docker compose logs vasta
```

1. ログからセットアップコードを見つけます。
2. `http://127.0.0.1:5174` を開きます。
3. セットアップコードで最初のアカウントを作ります。
4. 他の人を追加するには、Settings › Server accounts で招待リンクを作ります。

パソコンのデスクトップアプリで始めていた場合は、手順 3 を飛ばしてください。アプリで Settings › Server › **Move to a server…** を開き、そこにセットアップコードを貼り付けます。ノートは新しいアカウントと一緒に移ります。

HTTPS、バックアップ、アップグレード、メディアバケットについては [docs/deploy.md](docs/deploy.md) を読んでください。

## デスクトップアプリ

[リリース](https://github.com/ariedotme/vasta/releases/latest)から macOS、Windows、Linux 版をダウンロードします。最初の起動時に、ノートを置く場所を選びます：

- **Start on this computer**：サーバーは不要です。アプリが自分で Vasta を動かし、ノートはそのパソコンに保存されます（[docs/desktop.md](docs/desktop.md#on-this-computer)）。あとで Settings › Server › **Move to a server…** からサーバーに移せます。
- **自分の Vasta サーバー**：アドレスを入力します。

このアプリは Apple と Microsoft の署名を受けていないため、初回はシステムが起動を止めます：

- **macOS**：システム設定 › プライバシーとセキュリティ を開き、**このまま開く** をクリックします。
- **Windows**：SmartScreen のメッセージで、詳細情報 › **実行** をクリックします。

詳しくは [docs/desktop.md](docs/desktop.md#installing) を読んでください。

## 開発

Node.js 24 以降と pnpm 10 が必要です。

```sh
pnpm install
pnpm dev          # API は 127.0.0.1:5174、Web アプリは http://127.0.0.1:5173
pnpm test
pnpm typecheck
```

最初の起動でターミナルにセットアップコードが表示されるので、それでアカウントを作ります。サンプルデータで始めるには [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください。

```
packages/
  core/                  データモデル、SQLite スキーマ、同期、メディアストア
  editor-schema/         エディタとサーバーで共有するリッチテキストのスキーマ
  server/                HTTP API（Hono）、キャプチャチャネル、MCP エンドポイント、管理 CLI
  web/                   アプリ本体：Vue 3、Tailwind、TipTap、sqlite-wasm のレプリカ
  desktop/               デスクトップアプリ（Tauri 2）
  cli/                   vasta、エージェントとスクリプト向けの CLI
  importer-capacities/   Capacities からのインポート
extensions/browser/      「Save to Vasta」ブラウザ拡張
```

## ドキュメント

ドキュメントは英語です。

- [データモデル](docs/data-model.md)：オブジェクト、型、プロパティ、ドキュメント、クエリ
- [アカウント](docs/accounts.md)：ユーザー、共有スペース、トークン、API の安全性
- [セルフホスト](docs/deploy.md)：Docker、HTTPS、バックアップ、アップグレード
- [デスクトップアプリ](docs/desktop.md)：インストール、仕組み、リリース
- [キャプチャ](docs/capture.md)：Telegram、HTTP API、ブラウザ拡張、ショートカット
- [エージェント](docs/agents.md)：MCP エンドポイントと CLI
- [リマインダー](docs/reminders.md)：ntfy、Telegram、デスクトップアプリ
- [同期](docs/sync.md)：ローカルファーストの同期の仕組み

サーバーはキャプチャ API を `/api/openapi.json`（OpenAPI 3.1）でも公開しています。

## 今後の予定

- Markdown フォルダ、Obsidian、Notion からのインポートと、仕様を文書化した Markdown エクスポート
- オブジェクトを読み書きする公開 HTTP API
- 複数人による同じノートの同時編集
- キャプチャチャネルとしてのメール
- CalDAV、Google、iCloud カレンダー（現在は iCal リンク）

全体の一覧は [ロードマップ](https://github.com/users/ariedotme/projects/1) に issue として載っています。`good first issue` ラベルの付いた項目は最初の一歩に向いています。

## ライセンス

[AGPL-3.0](LICENSE)。Vasta は自由に使い、変更し、共有できます。変更したバージョンをネットワーク越しに他の人へ提供する場合は、そのソースコードを相手に提供してください。
