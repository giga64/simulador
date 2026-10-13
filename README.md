# SimulaBR

O SimulaBR ajuda a acompanhar a temporada, explorar estatísticas e simular o
Brasileirão 2026 e as copas:

- classificação com os jogos ao vivo e o efeito de cada placar nas chances;
- 10.000 simulações do restante do campeonato, com mapa de posições finais,
  evolução das chances rodada a rodada e contas matemáticas por clube;
- Libertadores, Sul-Americana e Copa do Brasil: chaveamento, grupos e chance
  de cada clube por fase, com força (Elo) editável;
- vagas na Libertadores 2027 combinando o Brasileirão com as copas;
- simulador de placares, comparação de cenários e link curto com imagem de
  prévia para compartilhar;
- notificações de gol dos clubes favoritos e comparação do modelo com as casas
  de apostas (opcionais).

O apoio ao projeto é opcional e pode ser feito pelo [Ko-fi](https://ko-fi.com/simuladorbr).
O site apenas abre a página externa do Ko-fi; não coleta nem processa pagamentos.

## Executar

Requer Node.js 20 ou superior:

```sh
npm install
npm start
```

Abra `http://127.0.0.1:4173`. Em desenvolvimento o servidor entrega os arquivos
de origem. Em produção, rode `npm run build` e inicie com `NODE_ENV=production`:
o servidor passa a entregar `dist/` (minificado, com cache de 1 ano e
compressão).

A classificação e a rodada ativa vêm do GE, pelo pacote
[campeonato-brasileiro-api](https://github.com/ezefranca/campeonato-brasileiro-api);
as copas vêm da ESPN. O servidor consulta as fontes em segundo plano e a página
se atualiza sozinha, sem recarregar.

## Scripts

| Comando                  | O que faz                                                         |
| ------------------------ | ----------------------------------------------------------------- |
| `npm start`              | Servidor (porta `PORT`, padrão 4173)                              |
| `npm run build`          | Build de produção em `dist/`                                      |
| `npm test`               | Testes de unidade e de servidor (`node --test`)                   |
| `npm run test:e2e`       | Testes de navegador com acessibilidade (Playwright + axe)         |
| `npm run lint`           | ESLint                                                            |
| `npm run format`         | Formata o código com Prettier                                     |
| `npm run validate:data`  | Valida o snapshot da temporada e as correções importadas          |
| `npm run import:results` | Importa resultados conferidos (ver `docs/dados-e-modelo.md`)      |
| `npm run check`          | Lint, formatação, testes, validação e build: o mesmo que a CI     |
| `npm run backtest`       | Mede o erro do modelo rodada a rodada (escolha do `k`)            |
| `npm run build:history`  | Reconstrói o histórico de chances após atualizar o snapshot       |
| `npm run build:ratings`  | Recalcula o Elo dos clubes das copas                              |
| `npm run crests`         | Baixa escudos e logos das copas para `assets/crests/`             |
| `npm run vapid`          | Gera as chaves das notificações push                              |

Para os testes de navegador usarem o Chrome instalado em vez do Chromium do
Playwright: `PW_CHANNEL=chrome npm run test:e2e`.

A CI (`.github/workflows/ci.yml`) roda lint, formatação, testes, validação e
build em cada push e pull request e, depois, os testes de navegador.

## Estrutura

```
index.html, app.js, styles.css   página e interface
theme.js                         aplica o tema escolhido antes do CSS
sw.js, manifest.webmanifest      app instalável (PWA), abertura sem conexão e push
src/model/                       modelo do Brasileirão (compartilhado com o servidor)
src/competitions/                copas: formatos, adaptadores (ESPN, openfootball),
                                 Elo, simulação do mata-mata e vagas 2027
src/client/                      código só do navegador (componentes, rotas, copas)
src/server/                      rotas, segurança, SEO, histórico, push, imagens,
                                 odds, copas e monitoramento
src/live-sources/                fonte do feed ao vivo (hoje: GE)
scripts/                         servidor, build e scripts de dados
data/                            snapshot, histórico de chances e notas de força
assets/                          escudos, ícones, fontes e logos
server-assets/                   fontes e escudos PNG usados só pelo servidor
supabase/migrations/             tabelas e políticas de acesso das contas
test/, e2e/                      testes de unidade/servidor e de navegador
```

O servidor só entrega os arquivos listados em `src/static-paths.js` (ou o
conteúdo de `dist/`). Código do servidor, testes, migrações, `node_modules` e
arquivos ocultos respondem 404.

## Documentação

- [Publicar, variáveis de ambiente, Supabase, segurança e monitoramento](docs/deploy.md)
- [Dados, fontes, modelo, copas e jogos ao vivo](docs/dados-e-modelo.md)
