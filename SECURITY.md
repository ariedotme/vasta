# Security

Vasta holds people's notes, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report it privately through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue for it. Include what an attacker can do,
the steps to reproduce it, and the version (Settings › This device shows the server's build).

You will get an answer within a week. Once a fix is released, the advisory is published with
credit to you, unless you prefer otherwise.

## Supported versions

Only the newest release gets security fixes. Upgrading is
`docker compose pull && docker compose up -d` (see [docs/deploy.md](docs/deploy.md)).

## Scope

How the server protects accounts and data, and the known limits, are described in
[docs/accounts.md](docs/accounts.md#how-it-is-protected). Reports about those limits are still
welcome when they are worse than described.
