# セルフホスト

[English](deploy.md) · [Português](deploy.pt-BR.md) · [Español](deploy.es.md) · [简体中文](deploy.zh-CN.md) · **日本語**

> これは[英語版ガイド](deploy.md)の翻訳です（2026-10-24 更新）。アプリと `docs/` のほかのドキュメントは、今のところ英語のみです（[#34](https://github.com/ariedotme/vasta/issues/34)）。

Vasta は 1 つの Docker イメージ `ghcr.io/ariedotme/vasta`（`linux/amd64` と `linux/arm64` 対応）で動きます。ポート 5174 で API とビルド済みの Web アプリを提供し、データディレクトリは `/data` にマウントします（`vasta.db` と、メディアを S3 互換バケットに置かない場合は `media/`）。リリースごとに `:<version>`（例：`:0.2.0`）、`:<major>.<minor>`、`:latest` のタグが公開されます。

## クイックスタート

```sh
mkdir vasta && cd vasta
curl -O https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
mv compose.example.yml compose.yml
# .env を編集：少なくとも VASTA_TIMEZONE と VASTA_WEB_URL
docker compose up -d
docker compose logs vasta      # 最初のアカウント用のセットアップコードが表示されます
```

Web アプリ（デフォルトは `http://127.0.0.1:5174`）を開き、そのセットアップコードで最初のアカウントを作成します。最初のアカウントがサーバーのスペースの所有者になります。ほかの人にアカウントを渡すには、Settings › Server accounts で招待リンクを作って送ってください（[accounts.md](accounts.md)）。

設定はすべて環境変数で、[`.env.example`](../.env.example) に説明があります。

## HTTPS とリバースプロキシ

自分のマシン以外から使うなら HTTPS にしてください。セッション Cookie、Service Worker（オフライン利用とスマートフォンへのアプリのインストール）、デスクトップアプリはどれも HTTPS を前提にしています。Vasta をリバースプロキシの後ろに置き、`X-Forwarded-Proto` を渡すと、セッション Cookie に `Secure` が付きます。[Caddy](https://caddyserver.com) の場合：

```caddy
vasta.example.org {
	reverse_proxy vasta:5174
}
```

Caddy は `X-Forwarded-Proto` を自動で設定します。その手前で TLS を終端する別のプロキシ（たとえば Cloudflare Tunnel）がある場合は、`header_up X-Forwarded-Proto https` を追加してください。Server-Sent Events（`/api/events`）に追加の設定は不要です。サーバーが 25 秒ごとに ping を送ります。JSON の応答と Web アプリのアセットはサーバー自身が圧縮します。compose ファイルはポートを 127.0.0.1 でのみ公開します。プロキシも Docker で動かす場合は、両方を共有ネットワークに入れてください。

スマートフォンでは、アドレスを開いて「ホーム画面に追加」（Safari）または「アプリをインストール」（Chrome）を選びます。全画面で開き、オフラインでも使えます。

## アップグレードとバックアップ

```sh
docker compose pull && docker compose up -d
```

スキーマの変更は、新しいバージョンがデータベースを開いたときに実行されます。その後は、バックアップから戻す以外に古いバージョンへ戻る方法はありません。アップグレードの前に、そして定期的に：

```sh
docker exec vasta vasta backup /data/backups/vasta-$(date +%Y%m%d).db
```

`vasta backup` はサーバーの稼働中にデータベースの一貫したコピーを作ります。メディアはコピーしないので、`<data>/media`（またはバケット）も別にバックアップしてください。メディアファイルは一度書き込まれると変わりません（ファイル名は内容のハッシュです）。そのため古いメディアのバックアップに欠けているのは新しいファイルだけで、`vasta media check` はオブジェクトが参照しているのにストアにないものを一覧にします。

## S3 互換バケットにメディアを置く

アップロード、キャプチャしたファイル、リンクのプレビューは `<data>/media` に置かれます。`VASTA_S3_*` の設定でバケットを指定した場合はそちらに置かれます：Vasta と並べて動かす [Garage](https://garagehq.deuxfleurs.fr/) や MinIO、または Cloudflare R2、Backblaze B2、AWS S3。サーバーはそれらを `/media/:key` で配信します（ログインのチェック付きで、音声や動画のシーク用に `Range` にも対応）。そのバケットだけに権限を絞ったキーを使ってください。デフォルトはパス形式（path-style）のアドレス指定です。`VASTA_S3_PATH_STYLE=0` にするとバケットがホスト名に入ります（AWS の新しいバケットではこれが必要です）。R2 のリージョンは `auto` です。

既存のファイルをバケットへ移すには、`VASTA_S3_*` を設定し、何もコピーされなくなるまで `docker exec vasta vasta media push` を実行してから、`vasta media check` を実行します。

## 知っておきたいほかの設定

- **Telegram**：1 つのボットをポーリングできるのは 1 つのプロセスだけです。サーバーごとに（ローカル開発にも）別のボットを用意してください（[capture.md](capture.md)）。
- **ネットワーク内のサービス**：アカウントがサーバー経由で LAN に届かないよう、サーバーはプライベートアドレスのリンクやカレンダーを取得しません。必要なもの（Nextcloud のカレンダー、リマインダー用の ntfy サーバーなど）は `VASTA_ALLOW_PRIVATE_FETCH` で許可します（[accounts.md](accounts.md#how-it-is-protected)）。
- **データベースの移動**：サーバーを止めた状態でコピーするか、`sqlite3 vasta.db ".backup copy.db"` を使い、`media/` も一緒にコピーしてください。

## イメージを自分でビルドする

```sh
docker build -t vasta .
```

`Dockerfile` は Web アプリのビルドとサーバーの依存関係のインストールをビルドマシン上で行うので、ほかのアーキテクチャ向けのイメージもエミュレーションなしでビルドできます。`compose.example.yml` では `image:` の代わりに `build: .` を使えます。
