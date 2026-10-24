# 自托管

[English](deploy.md) · [Português](deploy.pt-BR.md) · [Español](deploy.es.md) · **简体中文** · [日本語](deploy.ja.md)

> 本文是[英文指南](deploy.md)的翻译（更新于 2026-10-24）。应用界面和 `docs/` 中的其他文档目前只有英文（[#34](https://github.com/ariedotme/vasta/issues/34)）。

Vasta 以单个 Docker 镜像运行：`ghcr.io/ariedotme/vasta`（支持 `linux/amd64` 和 `linux/arm64`）。镜像在 5174 端口提供 API 和构建好的 Web 应用，数据目录挂载在 `/data`（包含 `vasta.db`，以及 `media/`，除非媒体文件存放在兼容 S3 的存储桶中）。每次发布都会推送 `:<version>`（例如 `:0.2.0`）、`:<major>.<minor>` 和 `:latest` 标签。

## 快速开始

```sh
mkdir vasta && cd vasta
curl -O https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
mv compose.example.yml compose.yml
# 编辑 .env：至少设置 VASTA_TIMEZONE 和 VASTA_WEB_URL
docker compose up -d
docker compose logs vasta      # 显示创建第一个账户所需的设置码
```

打开 Web 应用（默认地址为 `http://127.0.0.1:5174`），用这个设置码创建第一个账户。第一个账户拥有服务器上的空间。要给其他人开账户，在 Settings › Server accounts 中生成邀请链接发给对方（[accounts.md](accounts.md)）。

所有设置都是环境变量，说明见 [`.env.example`](../.env.example)。

## HTTPS 和反向代理

只要不是仅在本机使用，就请启用 HTTPS：会话 Cookie、Service Worker（离线使用和在手机上安装应用）以及桌面应用都依赖它。把 Vasta 放在反向代理后面，并传递 `X-Forwarded-Proto`，这样会话 Cookie 才会被标记为 `Secure`。使用 [Caddy](https://caddyserver.com) 时：

```caddy
vasta.example.org {
	reverse_proxy vasta:5174
}
```

Caddy 会自动设置 `X-Forwarded-Proto`。如果前面还有另一个先终止 TLS 的代理（例如 Cloudflare Tunnel），请加上 `header_up X-Forwarded-Proto https`。Server-Sent Events（`/api/events`）无需额外设置：服务器每 25 秒发送一次心跳。服务器会自行压缩 JSON 响应和 Web 应用的静态资源。compose 文件只在 127.0.0.1 上发布端口；如果代理也运行在 Docker 中，请把两者放在同一个共享网络里。

在手机上打开该地址，选择“添加到主屏幕”（Safari）或“安装应用”（Chrome）：应用会全屏打开，并且可以离线使用。

## 升级和备份

```sh
docker compose pull && docker compose up -d
```

新版本打开数据库时会执行数据库结构变更，之后除了从备份恢复，无法回到旧版本。升级之前，以及平时定期执行：

```sh
docker exec vasta vasta backup /data/backups/vasta-$(date +%Y%m%d).db
```

`vasta backup` 会在服务器运行时生成一份一致的数据库副本。它不会复制媒体文件：请同时备份 `<data>/media`（或存储桶）。媒体文件写入后永不改变（文件名就是内容的哈希值），所以较旧的媒体备份只是缺少较新的文件；`vasta media check` 会列出被对象引用但存储中缺失的文件。

## 将媒体存放在兼容 S3 的存储桶中

上传的文件、捕获的文件和链接预览默认存放在 `<data>/media`，除非 `VASTA_S3_*` 设置指定了一个存储桶：与 Vasta 部署在一起的 [Garage](https://garagehq.deuxfleurs.fr/) 或 MinIO，或者 Cloudflare R2、Backblaze B2、AWS S3。服务器通过 `/media/:key` 提供这些文件（带登录检查，并支持 `Range`，方便音视频拖动进度）。请使用仅限该存储桶的密钥。默认使用路径式寻址（path-style）；`VASTA_S3_PATH_STYLE=0` 会把存储桶放进主机名（AWS 的新存储桶需要这样做），R2 的区域填 `auto`。

要把已有文件迁移到存储桶，先设置 `VASTA_S3_*`，然后反复运行 `docker exec vasta vasta media push`，直到没有文件再被复制，最后运行 `vasta media check`。

## 其他值得了解的设置

- **Telegram**：一个机器人只能被一个进程轮询，所以请给每台服务器（以及本地开发环境）各自配一个机器人（[capture.md](capture.md)）。
- **局域网中的服务**：服务器拒绝抓取私有地址上的链接和日历，防止账户借助它访问你的局域网。需要的服务（例如 Nextcloud 日历、用于提醒的 ntfy 服务器）可以用 `VASTA_ALLOW_PRIVATE_FETCH` 放行（[accounts.md](accounts.md#how-it-is-protected)）。
- **迁移数据库**：在服务器停止时复制，或者使用 `sqlite3 vasta.db ".backup copy.db"`，并把 `media/` 一起复制过去。

## 自行构建镜像

```sh
docker build -t vasta .
```

`Dockerfile` 在构建机器上构建 Web 应用并安装服务器依赖，因此为其他架构构建镜像时不需要模拟。`compose.example.yml` 可以用 `build: .` 代替 `image:`。
