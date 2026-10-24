<h1 align="center">
  <img src="packages/web/public/icon.svg" alt="" width="64" valign="middle" /> Vasta
</h1>

<p align="center">
  <strong>Suas notas, tarefas e dias em um só app, no seu computador ou no seu próprio servidor.</strong><br/>
  Local-first. Funciona offline. Não precisa de servidor para começar; mude para um quando quiser.
</p>

<p align="center">
  <a href="README.md">English</a> · <b>Português</b> · <a href="README.es.md">Español</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/ariedotme/vasta/releases/latest"><img src="https://img.shields.io/github/v/release/ariedotme/vasta?style=flat&colorA=222222&colorB=4493F8&label=release" alt="Última versão" /></a>
  <a href="https://github.com/ariedotme/vasta/blob/main/scripts/downloads-badge.mjs"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fariedotme%2Fvasta%2Fbadges%2Fdownloads.json&style=flat" alt="Downloads: arquivos das versões e pulls da imagem do servidor" /></a>
  <a href="https://github.com/ariedotme/vasta/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ariedotme/vasta/ci.yml?style=flat&colorA=222222&colorB=3FB950&label=CI" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-222222?style=flat&colorA=222222&colorB=58A6FF" alt="Licença: AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/web%20%C2%B7%20macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-222222?style=flat&colorA=222222&colorB=8B949E" alt="Web, macOS, Windows e Linux" />
</p>

<p align="center">
  <a href="#primeiros-passos">Primeiros passos</a> ·
  <a href="#no-seu-servidor">No seu servidor</a> ·
  <a href="#app-desktop">App desktop</a> ·
  <a href="#documentação">Documentação</a> ·
  <a href="CONTRIBUTING.md">Contribuir</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/today-dark.jpg" />
    <img src="docs/assets/today-light.jpg" alt="O dia de hoje no Vasta: os eventos, a nota do dia com três capturas e os hábitos" width="960" />
  </picture>
</p>

> Esta é uma tradução do [README em inglês](README.md) (até o commit `7f01fcb`). O app e a
> documentação em `docs/` ainda estão só em inglês
> ([#34](https://github.com/ariedotme/vasta/issues/34)).

O Vasta guarda tudo como objetos com tipo: páginas, tarefas, livros, pessoas ou um tipo que você
cria. Cada dia tem uma nota. As capturas do seu celular, do navegador ou de um agente vão para ela.
Cada dispositivo guarda uma cópia dos seus espaços, então o app funciona offline. Seu servidor
mantém todos os dispositivos sincronizados.

> [!NOTE]
> O Vasta está em alfa. A autora usa todo dia, mas algumas partes são novas. Faça backups
> ([docs/deploy.md](docs/deploy.md#upgrading-and-backups)).

## Primeiros passos

<table>
<tr>
<th width="50%">No seu computador</th>
<th width="50%">No seu próprio servidor</th>
</tr>
<tr>
<td valign="top">

**Sem servidor, sem Docker, nada para configurar.**

1. [Baixe o app desktop](https://github.com/ariedotme/vasta/releases/latest)
   para macOS, Windows ou Linux.
2. Escolha **Start on this computer**.

O app roda o Vasta para você. Suas notas ficam naquele computador.

</td>
<td valign="top">

**Todos os dispositivos, inclusive o celular, e espaços compartilhados.**

1. Rode o servidor com Docker ([No seu servidor](#no-seu-servidor)).
2. Abra no navegador, no celular ou no app desktop.

Capturas do Telegram, da extensão do navegador e de agentes chegam de qualquer lugar.

</td>
</tr>
</table>

> [!TIP]
> **Comece no seu computador, mude depois.** Quando quiser o celular ou outras pessoas, abra
> Settings › Server › **Move to a server…** no app desktop. Cole o código de configuração do
> servidor ou um link de convite, e o Vasta leva suas notas, o histórico delas e seus arquivos
> para uma conta nova lá. [Como funciona →](docs/desktop.md#moving-to-a-server)

## Recursos

<table>
<tr>
<td width="40%" valign="middle">

### Capture numa linha

Digite uma linha no ⌘K, no Telegram ou no atalho do desktop. O Vasta lê o tipo e as propriedades
dela: `/Task Ask Lena due:fri assignee:lena`.

[Captura →](docs/capture.md)

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/capture-dark.jpg" />
  <img src="docs/assets/capture-light.jpg" alt="A paleta ⌘K cria uma tarefa com prazo e responsável a partir de uma linha" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Seus próprios tipos

Crie um tipo para qualquer coisa. Dê propriedades a ele: texto, números, datas, seleções,
relações, fórmulas. Mostre como lista, tabela, quadro, grade, mural ou galeria.

[Modelo de dados →](docs/data-model.md)

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/types-dark.jpg" />
  <img src="docs/assets/types-light.jpg" alt="Um tipo Livros na galeria, com capas, autores e status de leitura" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Trabalhe em equipe

Compartilhe um espaço com outras pessoas. Use quadros, sprints, comentários, @menções e
notificações. Métricas de fluxo mostram a velocidade do trabalho.

[Contas e espaços →](docs/accounts.md)

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/board-dark.jpg" />
  <img src="docs/assets/board-light.jpg" alt="Um quadro de tarefas com as colunas A fazer, Em andamento e Feito, responsáveis e projetos" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Um só calendário

Notas diárias, tarefas, objetos com data, sprints e eventos ficam num só calendário. Adicione seus
outros calendários pelos links iCal.

</td>
<td width="60%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/calendar-dark.jpg" />
  <img src="docs/assets/calendar-light.jpg" alt="A visão do mês com sprints, tarefas e eventos" width="100%" />
</picture>
</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Seus agentes, suas notas

Claude Code, Codex e scripts leem e escrevem suas notas por um endpoint MCP e pelo comando
`vasta`: buscar, consultar, criar objetos, capturar, marcar hábitos. Eles agem como você, com um
token que você pode revogar. O Vasta não tem IA dentro e não guarda chaves de modelos.

[Agentes →](docs/agents.md)

</td>
<td width="60%">

```sh
claude mcp add --transport http vasta \
  https://vasta.example.org/mcp \
  --header "Authorization: Bearer <token>"
```

> Leia minhas notas das reuniões desta semana e crie uma tarefa para cada
> coisa que eu prometi, com prazo na sexta.

</td>
</tr>
</table>

**Também no Vasta:**

- **Offline primeiro**: cada dispositivo guarda uma cópia em SQLite. Edições feitas offline em dois
  dispositivos se juntam.
- **Editor de blocos**: comandos com barra, menções com `@`, embeds, callouts, toggles, colunas,
  tabelas e backlinks.
- **Templates e snippets**: comece os objetos de um tipo ou a nota de cada dia a partir de um
  template, com placeholders (`{{date:+7d}}`, `{{ask:With whom?}}`) e blocos que só aparecem quando
  uma condição vale; insira snippets com `/`. [Templates →](docs/data-model.md#templates-and-snippets)
- **Links salvos** guardam uma prévia, uma cópia legível da página e embeds.
- **Hábitos e lembretes** pelo ntfy, pelo Telegram e pelo app desktop. [Lembretes →](docs/reminders.md)
- **Um diário alimentar** com metas de nutrição, se você ativar.
- **Apps**: instale o web app no celular (PWA). O app desktop adiciona um atalho global de captura.
- **Arquivos** em disco ou num bucket compatível com S3.
- **Importação** do Capacities.

## No seu servidor

Você precisa de Docker. Faça estes passos no servidor:

```sh
mkdir vasta && cd vasta
curl -o compose.yml https://raw.githubusercontent.com/ariedotme/vasta/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/ariedotme/vasta/main/.env.example
docker compose up -d
docker compose logs vasta
```

1. Encontre o código de configuração no log.
2. Abra `http://127.0.0.1:5174`.
3. Crie a primeira conta com o código de configuração.
4. Para adicionar outras pessoas, crie um link de convite em Settings › Server accounts.

Começou com o app desktop no seu computador? Pule o passo 3: no app, abra Settings › Server ›
**Move to a server…** e cole o código de configuração lá. Suas notas vêm junto com a conta nova.

Para HTTPS, backups, atualizações e buckets de arquivos, leia [docs/deploy.md](docs/deploy.md).

## App desktop

Baixe o app para macOS, Windows ou Linux nas
[versões](https://github.com/ariedotme/vasta/releases/latest). Na primeira vez, escolha onde suas
notas ficam:

- **Start on this computer**: não precisa de servidor. O app roda o próprio Vasta, e suas notas
  ficam naquele computador ([docs/desktop.md](docs/desktop.md#on-this-computer)). Settings ›
  Server › **Move to a server…** leva elas para um servidor depois.
- **Seu servidor Vasta**: digite o endereço dele.

A Apple e a Microsoft não assinaram o app. Por isso o sistema bloqueia ele na primeira vez:

- **macOS**: abra Ajustes do Sistema › Privacidade e Segurança. Clique em **Abrir Mesmo Assim**.
- **Windows**: na mensagem do SmartScreen, clique em Mais informações › **Executar assim mesmo**.

Para mais detalhes, leia [docs/desktop.md](docs/desktop.md#installing).

## Desenvolvimento

Você precisa do Node.js 24 ou mais novo e do pnpm 10.

```sh
pnpm install
pnpm dev          # API em 127.0.0.1:5174, web app em http://127.0.0.1:5173
pnpm test
pnpm typecheck
```

A primeira execução escreve um código de configuração no terminal. Use ele para criar sua conta.
Para começar com dados de exemplo, leia [CONTRIBUTING.md](CONTRIBUTING.md).

```
packages/
  core/                  modelo de dados, schema SQLite, sync, armazenamento de arquivos
  editor-schema/         schema de texto rico do editor e do servidor
  server/                API HTTP (Hono), canais de captura, endpoint MCP, CLI de administração
  web/                   o app: Vue 3, Tailwind, TipTap, réplica em sqlite-wasm
  desktop/               o app desktop (Tauri 2)
  cli/                   vasta, a CLI para agentes e scripts
  importer-capacities/   importação do Capacities
extensions/browser/      extensão de navegador "Save to Vasta"
```

## Documentação

A documentação está em inglês.

- [Modelo de dados](docs/data-model.md): objetos, tipos, propriedades, documentos e consultas
- [Contas](docs/accounts.md): usuários, espaços compartilhados, tokens e como a API se protege
- [No seu servidor](docs/deploy.md): Docker, HTTPS, backups e atualizações
- [App desktop](docs/desktop.md): instalação, como funciona, versões
- [Captura](docs/capture.md): Telegram, API HTTP, extensão do navegador, Atalhos
- [Agentes](docs/agents.md): o endpoint MCP e a CLI
- [Lembretes](docs/reminders.md): ntfy, Telegram e o app desktop
- [Sync](docs/sync.md): como funciona o sync local-first

O servidor também descreve sua API de captura em `/api/openapi.json` (OpenAPI 3.1).

## Próximos passos

- Importar pastas de Markdown, Obsidian e Notion, e um export em Markdown documentado
- Uma API HTTP pública para ler e editar objetos
- Várias pessoas editando a mesma nota ao mesmo tempo
- E-mail como canal de captura
- Calendários CalDAV, Google e iCloud (hoje: links iCal)

A lista completa está no [roadmap](https://github.com/users/ariedotme/projects/1), como issues.
Itens com o rótulo `good first issue` são um bom lugar para começar.

## Licença

[AGPL-3.0](LICENSE). Você pode usar, mudar e compartilhar o Vasta. Se rodar uma versão modificada
para outras pessoas numa rede, entregue o código-fonte dela a essas pessoas.
