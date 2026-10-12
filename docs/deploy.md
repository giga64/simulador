# Publicar o SimulaBR

O site precisa do servidor Node (`npm start`): ele entrega a página, consulta a
fonte ao vivo, grava o histórico de chances e gera as imagens de
compartilhamento. Em hosts só estáticos (GitHub Pages) o simulador ainda abre,
mas sem dados ao vivo, links curtos, imagens de cenário e notificações.

Uma única instância Node com um volume persistente é a configuração mais
simples. Em produção, defina `NODE_ENV=production`: o servidor escuta em
`0.0.0.0:$PORT`, envia `Strict-Transport-Security` e força HTTPS no conteúdo.

## Variáveis de ambiente

| Variável                                       | Para quê                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`, `NODE_ENV`                     | Porta e endereço. Em produção, `NODE_ENV=production`.                                                                                                       |
| `SITE_URL`                                     | Endereço público com `https://`. Deixa as imagens de compartilhamento com URL absoluta, que WhatsApp, X e Facebook exigem.                                   |
| `TRUST_PROXY=1`                                | Use atrás de proxy (Render, Fly, Railway) para o limite de requisições usar o IP real de `X-Forwarded-For`. Não ligue sem proxy: o cabeçalho seria forjável. |
| `RUNTIME_DIR`                                  | Pasta do volume persistente (padrão `.runtime/`): resultados observados, histórico de chances e odds.                                                       |
| `LIVE_HISTORY_PATH`, `PROBABILITY_HISTORY_PATH` | Caminhos individuais, se preferir separar.                                                                                                                  |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`     | Contas, palpites sincronizados, cenários salvos e favoritos.                                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY`                    | **Secreta**, só no servidor. Liga exclusão de conta, links curtos de cenário e notificações push.                                                           |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Notificações push. Gere com `npm run vapid`; `VAPID_SUBJECT` é `mailto:seu-email`.                                                                  |
| `ODDS_API_KEY`                                 | Opcional. Chave da [the-odds-api.com](https://the-odds-api.com) para comparar o modelo com as casas de apostas (4 consultas por dia).                         |

Ao iniciar, o servidor lista quais recursos ficaram ativos.

Sem volume persistente, os resultados observados ao vivo e as fotos de chances
tiradas depois do último `npm run build:history` se perdem quando a instância
reinicia. O histórico reconstruído (`data/probability-history-2026.json`)
continua disponível: rode `npm run build:history` sempre que atualizar o
snapshot da temporada.

## Configurar o Supabase

1. Crie um projeto e execute no SQL Editor, nesta ordem, as migrações de
   `supabase/migrations/`:
   - `20261010150000_create_prediction_snapshots.sql`
   - `20261010170000_create_user_scenarios_and_preferences.sql`
   - `20261012180000_push_share_and_limits.sql` (notificações, links curtos e
     limites de tamanho e de quantidade por conta)
2. Em Authentication, defina o Site URL e permita o endereço publicado e
   `http://localhost:4173` como URLs de redirecionamento.
3. Defina `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` (ou a legada
   `SUPABASE_ANON_KEY`). Essa chave é pública e protegida pelas políticas RLS.
4. Para exclusão de conta, links curtos e push, defina também
   `SUPABASE_SERVICE_ROLE_KEY`. Ela nunca vai ao navegador.
5. Teste cadastro, confirmação por e-mail, login, recuperação de senha,
   sincronização e o isolamento de dados entre duas contas.

## Segurança

- **Arquivos públicos:** o servidor só entrega o que está em
  `src/static-paths.js`. Código do servidor (`src/server/`, `scripts/`), testes,
  migrações, `server-assets/`, `node_modules` e arquivos ocultos respondem 404.
- **Cabeçalhos:** `Content-Security-Policy` (scripts só do próprio site, sem
  iframes de terceiros), `X-Frame-Options: DENY`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` e, em
  produção, HSTS.
- **Limites por IP:** 60 requisições de API por minuto; consulta forçada à fonte
  no máximo 4 por minuto por IP e uma a cada 20 s no total; 10 links curtos por
  minuto; 30 imagens por minuto; 5 tentativas de exclusão de conta a cada 10
  minutos. Corpos de requisição têm tamanho máximo e tempo limite.
- **Dados externos:** textos vindos da fonte ao vivo são filtrados na entrada
  (`cleanText`) e escapados na exibição; links externos só são exibidos se forem
  `https:`.
- **Banco:** todas as tabelas usam RLS por `auth.uid()`; `shared_scenarios` não
  tem política nenhuma e só é acessada pelo servidor. Campos JSON têm tamanho
  máximo e cada conta tem limite de cenários (50), palpites (400) e inscrições
  de push (10).
- **Sessão:** o login usa Supabase Auth com sessão em `sessionStorage`; nenhuma
  senha passa pelo servidor do SimulaBR.

## Cache e app instalável

Arquivos estáticos são servidos com `ETag`. Imagens e fontes ficam em cache por
um dia; HTML, JavaScript, CSS e JSON são revalidados a cada acesso, porque os
nomes não têm hash. O service worker (`sw.js`) busca sempre na rede e usa o
cache só sem conexão; para descartar o cache antigo nos navegadores, troque a
constante `CACHE`. As notificações push também passam por ele.

## Notificações push

Com as chaves VAPID e a `service_role` configuradas, quem tem conta, escolhe
clubes favoritos e ativa as notificações em **Minha conta** recebe um aviso
quando um favorito começa a jogar, marca gol ou termina a partida, mesmo com o
site fechado. A inscrição fica em `push_subscriptions`; inscrições expiradas
são apagadas automaticamente. No iPhone, o site precisa estar adicionado à tela
de início.
