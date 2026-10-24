# No seu servidor

[English](deploy.md) · **Português** · [Español](deploy.es.md) · [简体中文](deploy.zh-CN.md) · [日本語](deploy.ja.md)

> Esta é uma tradução do [guia em inglês](deploy.md) (atualizada em 2026-10-24). O app e os
> outros documentos em `docs/` ainda estão só em inglês
> ([#34](https://github.com/ariedotme/vasta/issues/34)).

O Vasta roda como uma única imagem Docker, `ghcr.io/ariedotme/vasta` (para `linux/amd64` e
`linux/arm64`): a API mais o web app já compilado na porta 5174, com o diretório de dados montado
em `/data` (`vasta.db`, e `media/` a não ser que os arquivos fiquem num bucket compatível com S3).
Cada release publica `:<versão>` (por exemplo `:0.2.0`), `:<major>.<minor>` e `:latest`.

## Começo rápido

```sh
mkdir vasta && cd vasta
curl -O https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
mv compose.example.yml compose.yml
# edite o .env: pelo menos VASTA_TIMEZONE e VASTA_WEB_URL
docker compose up -d
docker compose logs vasta      # mostra o código de configuração da primeira conta
```

Abra o web app (por padrão em `http://127.0.0.1:5174`) e crie a primeira conta com esse código. A
primeira conta é dona dos espaços do servidor. Para dar uma conta a outra pessoa, crie um link de
convite em Settings › Server accounts e mande para ela ([accounts.md](accounts.md)).

As configurações são variáveis de ambiente, todas descritas no [`.env.example`](../.env.example).

## HTTPS e proxy reverso

Use HTTPS para qualquer coisa além da sua própria máquina: o cookie de sessão, o service worker
(uso offline e instalar o app no celular) e o app desktop esperam isso. Coloque o Vasta atrás de
um proxy reverso e repasse o `X-Forwarded-Proto`, para que o cookie de sessão seja marcado como
`Secure`. Com o [Caddy](https://caddyserver.com):

```caddy
vasta.example.org {
	reverse_proxy vasta:5174
}
```

O Caddy define o `X-Forwarded-Proto` sozinho. Atrás de outro proxy que termina o TLS antes dele
(um túnel da Cloudflare, por exemplo), adicione `header_up X-Forwarded-Proto https`. Os
Server-Sent Events (`/api/events`) não precisam de configuração extra: o servidor manda um ping a
cada 25 s. O servidor comprime ele mesmo as respostas JSON e os arquivos do web app. O arquivo
compose publica a porta só em 127.0.0.1. Quando o proxy também roda no Docker, coloque os dois
numa rede compartilhada.

No celular, abra o endereço e use "Adicionar à Tela de Início" (Safari) ou "Instalar app"
(Chrome): ele abre em tela cheia e continua funcionando offline.

## Atualizações e backups

```sh
docker compose pull && docker compose up -d
```

As mudanças de schema rodam quando a nova versão abre o banco, e depois disso não dá para voltar
a uma versão anterior, a não ser por um backup. Antes de atualizar, e com regularidade:

```sh
docker exec vasta vasta backup /data/backups/vasta-$(date +%Y%m%d).db
```

O `vasta backup` faz uma cópia consistente do banco com o servidor rodando. Ele não copia os
arquivos de mídia: faça backup de `<data>/media` (ou do bucket) também. Os arquivos de mídia nunca
mudam depois de escritos (o nome deles é o hash do conteúdo), então um backup de mídia mais antigo
só não tem os arquivos mais novos, e o `vasta media check` lista o que os objetos apontam e falta
no armazenamento.

## Mídia num bucket compatível com S3

Uploads, arquivos capturados e prévias de links ficam em `<data>/media`, a não ser que as
configurações `VASTA_S3_*` apontem um bucket: [Garage](https://garagehq.deuxfleurs.fr/) ou MinIO
ao lado do Vasta, ou Cloudflare R2, Backblaze B2, AWS S3. O servidor entrega os arquivos em
`/media/:key` (com a checagem de login, e `Range` para avançar em áudio e vídeo). Use uma chave
restrita a esse bucket. O endereçamento por caminho (path-style) é o padrão;
`VASTA_S3_PATH_STYLE=0` põe o bucket no nome do host (a AWS exige isso para buckets novos), e a
região é `auto` para o R2.

Para mover arquivos existentes para um bucket, defina as configurações `VASTA_S3_*` e rode
`docker exec vasta vasta media push` até ele não copiar mais nada, depois `vasta media check`.

## Outras configurações que vale conhecer

- **Telegram**: um bot só pode ser consultado por um processo, então dê a cada servidor (e ao
  desenvolvimento local) o seu próprio bot ([capture.md](capture.md)).
- **Serviços na sua rede**: o servidor se recusa a buscar links e calendários em endereços
  privados, para que as contas não alcancem a sua rede local por ele. Libere os que você precisa
  (um calendário do Nextcloud, um servidor ntfy para lembretes) com `VASTA_ALLOW_PRIVATE_FETCH`
  ([accounts.md](accounts.md#how-it-is-protected)).
- **Mover um banco**: copie com o servidor parado, ou com
  `sqlite3 vasta.db ".backup copy.db"`, e copie o `media/` junto.

## Compilar a imagem você mesmo

```sh
docker build -t vasta .
```

O `Dockerfile` compila o web app e instala as dependências do servidor na máquina de build, então
imagens para outra arquitetura compilam sem emulação. O `compose.example.yml` pode usar
`build: .` no lugar de `image:`.
