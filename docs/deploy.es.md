# En tu servidor

[English](deploy.md) · [Português](deploy.pt-BR.md) · **Español** · [简体中文](deploy.zh-CN.md) · [日本語](deploy.ja.md)

> Esta es una traducción de la [guía en inglés](deploy.md) (actualizada el 2026-10-24). La app y
> los demás documentos de `docs/` están, por ahora, solo en inglés
> ([#34](https://github.com/ariedotme/vasta/issues/34)).

Vasta se ejecuta como una sola imagen Docker, `ghcr.io/ariedotme/vasta` (para `linux/amd64` y
`linux/arm64`): la API más la app web ya compilada en el puerto 5174, con el directorio de datos
montado en `/data` (`vasta.db`, y `media/` salvo que los archivos estén en un bucket compatible
con S3). Cada versión publica `:<versión>` (por ejemplo `:0.2.0`), `:<major>.<minor>` y `:latest`.

## Inicio rápido

```sh
mkdir vasta && cd vasta
curl -O https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
mv compose.example.yml compose.yml
# edita .env: al menos VASTA_TIMEZONE y VASTA_WEB_URL
docker compose up -d
docker compose logs vasta      # muestra el código de configuración de la primera cuenta
```

Abre la app web (por defecto en `http://127.0.0.1:5174`) y crea la primera cuenta con ese código.
La primera cuenta es la dueña de los espacios del servidor. Para darle una cuenta a otra persona,
crea un enlace de invitación en Settings › Server accounts y envíaselo ([accounts.md](accounts.md)).

La configuración se hace con variables de entorno, todas descritas en
[`.env.example`](../.env.example).

## HTTPS y proxy inverso

Usa HTTPS para cualquier cosa más allá de tu propia máquina: la cookie de sesión, el service
worker (uso sin conexión e instalar la app en el móvil) y la app de escritorio lo esperan. Pon
Vasta detrás de un proxy inverso y reenvía `X-Forwarded-Proto`, para que la cookie de sesión se
marque como `Secure`. Con [Caddy](https://caddyserver.com):

```caddy
vasta.example.org {
	reverse_proxy vasta:5174
}
```

Caddy define `X-Forwarded-Proto` por sí mismo. Detrás de otro proxy que termina el TLS antes (un
túnel de Cloudflare, por ejemplo), añade `header_up X-Forwarded-Proto https`. Los Server-Sent
Events (`/api/events`) no necesitan ajustes extra: el servidor envía un ping cada 25 s. El
servidor comprime él mismo sus respuestas JSON y los archivos de la app web. El archivo compose
publica el puerto solo en 127.0.0.1. Cuando el proxy también corre en Docker, pon ambos en una
red compartida.

En el móvil, abre la dirección y usa "Añadir a pantalla de inicio" (Safari) o "Instalar app"
(Chrome): se abre a pantalla completa y sigue funcionando sin conexión.

## Actualizaciones y copias de seguridad

```sh
docker compose pull && docker compose up -d
```

Los cambios de esquema se aplican cuando la nueva versión abre la base de datos, y después no hay
forma de volver a una versión anterior salvo una copia de seguridad. Antes de actualizar, y con
regularidad:

```sh
docker exec vasta vasta backup /data/backups/vasta-$(date +%Y%m%d).db
```

`vasta backup` hace una copia consistente de la base de datos mientras el servidor funciona. No
copia los archivos multimedia: haz también copia de `<data>/media` (o del bucket). Los archivos
multimedia nunca cambian una vez escritos (su nombre es el hash del contenido), así que una copia
de medios más antigua solo carece de los archivos más nuevos, y `vasta media check` lista lo que
los objetos referencian y falta en el almacenamiento.

## Archivos en un bucket compatible con S3

Las subidas, los archivos capturados y las vistas previas de enlaces viven en `<data>/media`,
salvo que la configuración `VASTA_S3_*` indique un bucket: [Garage](https://garagehq.deuxfleurs.fr/)
o MinIO junto a Vasta, o Cloudflare R2, Backblaze B2, AWS S3. El servidor los entrega en
`/media/:key` (con la comprobación de sesión, y `Range` para avanzar en audio y vídeo). Usa una
clave limitada a ese bucket. El direccionamiento por ruta (path-style) es el predeterminado;
`VASTA_S3_PATH_STYLE=0` pone el bucket en el nombre del host (AWS lo exige para buckets nuevos), y
la región es `auto` para R2.

Para mover archivos existentes a un bucket, define la configuración `VASTA_S3_*` y ejecuta
`docker exec vasta vasta media push` hasta que no copie nada, y luego `vasta media check`.

## Otros ajustes que conviene conocer

- **Telegram**: un bot solo puede ser consultado por un proceso, así que da a cada servidor (y al
  desarrollo local) su propio bot ([capture.md](capture.md)).
- **Servicios de tu red**: el servidor se niega a obtener enlaces y calendarios en direcciones
  privadas, para que las cuentas no lleguen a tu red local a través de él. Permite los que
  necesites (un calendario de Nextcloud, un servidor ntfy para recordatorios) con
  `VASTA_ALLOW_PRIVATE_FETCH` ([accounts.md](accounts.md#how-it-is-protected)).
- **Mover una base de datos**: cópiala con el servidor detenido, o con
  `sqlite3 vasta.db ".backup copy.db"`, y copia `media/` a su lado.

## Construir la imagen tú mismo

```sh
docker build -t vasta .
```

El `Dockerfile` compila la app web e instala las dependencias del servidor en la máquina de
build, así que las imágenes para otra arquitectura se construyen sin emulación.
`compose.example.yml` puede usar `build: .` en lugar de `image:`.
