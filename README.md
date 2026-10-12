# SimulaBR

O SimulaBR ajuda a acompanhar a temporada, explorar estatísticas e simular as
rodadas do Brasileirão 2026:

- classificação com os jogos ao vivo e o efeito de cada placar nas chances;
- 10.000 simulações do restante do campeonato, com mapa de posições finais e a
  evolução das chances rodada a rodada;
- simulador de placares com link curto e imagem de prévia para compartilhar;
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

Abra `http://127.0.0.1:4173`. Não abra `index.html` diretamente por `file://`:
o site carrega JSON, módulos ES, um Web Worker e o endpoint `/api/live-season`.

A classificação e a rodada ativa vêm do GE, pelo pacote
[campeonato-brasileiro-api](https://github.com/ezefranca/campeonato-brasileiro-api).
O servidor consulta a fonte a cada minuto durante os jogos e a cada 2 minutos
fora deles, com cache de 60 segundos. A página se atualiza em segundo plano, sem
recarregar. Se a fonte falhar, usa a última consulta válida por até 6 horas; sem
nenhuma, mantém o snapshot local e avisa que os dados podem estar desatualizados.

## Scripts

| Comando                  | O que faz                                                    |
| ------------------------ | ------------------------------------------------------------ |
| `npm start`              | Servidor local (porta `PORT`, padrão 4173)                   |
| `npm test`               | Testes (`node --test`)                                       |
| `npm run lint`           | ESLint                                                       |
| `npm run format`         | Formata o código com Prettier                                |
| `npm run validate:data`  | Valida o snapshot da temporada e as correções importadas     |
| `npm run import:results` | Importa resultados conferidos (ver `docs/dados-e-modelo.md`) |
| `npm run check`          | Lint, formatação, testes e validação: o mesmo que a CI roda  |
| `npm run backtest`       | Mede o erro do modelo rodada a rodada (escolha do `k`)       |
| `npm run build:history`  | Reconstrói o histórico de chances após atualizar o snapshot  |
| `npm run vapid`          | Gera as chaves das notificações push                         |

A CI (`.github/workflows/ci.yml`) roda `lint`, `format:check`, `test` e
`validate:data` em cada push e pull request.

## Estrutura

```
index.html, app.js, styles.css   página e interface
sw.js, manifest.webmanifest      app instalável (PWA) e abertura sem conexão
src/model/                       modelo (compartilhado com o servidor): gols
                                 esperados, placares, desempate, Monte Carlo
                                 (Web Worker), jogos ao vivo, backtest
src/client/                      código só do navegador (simulações, componentes)
src/server/                      rotas, segurança, histórico, push, imagens, odds
src/live-sources/                fontes do feed ao vivo (hoje: GE)
src/*.js                         validação dos dados, cenários, palpites, feed
scripts/serve.mjs                servidor Node: arquivos públicos e API
data/                            snapshot da temporada e correções conferidas
assets/                          escudos (assets/escudos/*.webp), ícones, logo
server-assets/                   fontes e escudos PNG usados só pelo servidor
design/                          arquivos de origem do logo
supabase/migrations/             tabelas e políticas de acesso das contas
test/                            testes
```

O servidor só entrega os arquivos listados em `src/static-paths.js`. Código do
servidor, testes, migrações, `node_modules` e arquivos ocultos (como `.git`)
respondem 404.

## Documentação

- [Publicar, variáveis de ambiente, Supabase e segurança](docs/deploy.md)
- [Dados, fontes, modelo e jogos ao vivo](docs/dados-e-modelo.md)
