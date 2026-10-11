# SimulaBR

O SimulaBR ajuda a acompanhar a temporada, explorar estatísticas e simular as
rodadas do Brasileirão 2026.

A identidade visual do site usa o logo em `assets/simulabr-logo.png`.

O apoio ao projeto é opcional e pode ser feito pelo [Ko-fi](https://ko-fi.com/simuladorbr).
O site apenas abre a página externa do Ko-fi; não coleta nem processa pagamentos.

Site servido por Node.js. A página usa um snapshot local como contingência e
consulta automaticamente a classificação e a rodada ativa do GE por meio do
pacote [campeonato-brasileiro-api](https://github.com/ezefranca/campeonato-brasileiro-api).

## Executar

Requer Node.js 20 ou superior:

```sh
npm install
npm start
```

Abra `http://127.0.0.1:4173`. Não abra `index.html` diretamente por `file://`:
o site carrega JSON, módulos ES e o endpoint `/api/live-season`.

O servidor consulta o GE a cada 2 minutos, mantém cache de 60 segundos e
permite uma consulta manual pelo botão **Atualizar agora**. Se a fonte falhar,
usa a última consulta válida por até 6 horas; sem consulta válida, mantém o
snapshot local e informa que os dados podem estar desatualizados.

Resultados finais observados são guardados em `.runtime/live-results-2026.json`
e reaproveitados depois que a API passa para a rodada seguinte. O diretório não
é publicado pelo servidor. Configure `LIVE_HISTORY_PATH` para apontar a um
volume persistente na hospedagem; sem volume, o histórico coletado fica sujeito
a perder-se quando a instância Node reiniciar.

## Publicar

Para atualização automática, a hospedagem precisa executar este servidor Node
e encaminhar a página e `/api/live-season` pelo mesmo domínio. GitHub Pages e
outros hosts puramente estáticos não executam o endpoint: nesses casos, o
simulador ainda abre, mas usa o snapshot e mostra um aviso de indisponibilidade.

Em produção, o servidor escuta `PORT` e, por padrão, aceita conexões externas
quando `NODE_ENV=production`. Uma única instância Node com volume persistente é
a configuração mais simples para manter o histórico observado.

O cenário ativo fica no navegador. Após configurar Supabase, os palpites
preenchidos e a fotografia do modelo são sincronizados por conta em
`prediction_snapshots`; cenários nomeados e clubes favoritos ficam em
`saved_scenarios` e `user_preferences`. Favoritos e lembretes personalizados
exigem login e não são exibidos para visitantes; cenários nomeados também
exigem conta para sincronização entre dispositivos. Quando uma partida é
concluída, o palpite arquivado mantém placar, instante, semente, parâmetros,
probabilidades e revisão dos dados usados. A calibração compara essas
probabilidades aos resultados reais e mostra contagem e Brier score por rodada;
previsões antigas sem fotografia não são reconstruídas.

O projeto de login anexado era uma demonstração que guardava a senha em texto
claro no `localStorage`, portanto não foi reutilizado como autenticação. O botão
de conta usa Supabase Auth; as senhas são processadas pelo provedor e as tabelas
aplicam Row Level Security para que cada usuário só acesse seus próprios
palpites. A sessão do navegador usa `sessionStorage`.

### Configurar contas Supabase

1. Crie um projeto Supabase e execute, nesta ordem, as migrações
   `supabase/migrations/20261010150000_create_prediction_snapshots.sql` e
   `supabase/migrations/20261010170000_create_user_scenarios_and_preferences.sql`
   no SQL Editor. Elas criam as tabelas e políticas RLS por `auth.uid()`.
2. Nas configurações de Authentication, defina o Site URL do site e permita o
   endereço do Render e `http://localhost:4173` como URLs de redirecionamento.
   Configure a confirmação de e-mail/SMTP conforme o fluxo desejado.
3. No Render, defina `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` (ou a chave
   pública legada `SUPABASE_ANON_KEY`). A chave publishable/anon é pública e
   protegida pelas políticas RLS; **nunca** coloque `service_role` no navegador
   ou nessas variáveis. O servidor só disponibiliza URLs HTTPS `*.supabase.co`
   e chaves públicas reconhecidas; se a configuração estiver ausente ou for
   inválida, o login permanece desativado e nenhuma chave é enviada ao navegador.
4. Para habilitar exclusão de conta pelo próprio site, configure também
   `SUPABASE_SERVICE_ROLE_KEY` no Render usando a chave `service_role` legada
   do Supabase. Ela é secreta, fica somente no servidor e nunca é enviada ao
   navegador; sem ela, a exclusão é desativada. Esta variável é usada apenas
   pelo endpoint autenticado de exclusão.
5. Faça deploy e teste cadastro, confirmação por e-mail, login, recuperação de
   senha, sincronização e isolamento de dados entre duas contas.

Sem essas variáveis o simulador continua funcionando, mas o login informa que
não foi configurado. O armazenamento remoto requer a migração SQL aplicada;
erros de tabela/política são exibidos e os dados locais não são apagados.

### Recursos do site e da conta

- **Início:** reúne partidas ao vivo, próximos jogos, primeiros colocados e,
  para usuários conectados, próximos compromissos dos clubes favoritos.
  Visitantes recebem a opção de criar conta para configurar favoritos e
  lembretes. Os rótulos distinguem a fonte consultada das estimativas do modelo.
- **Disponibilidade dos dados:** mantém uma cópia local da última consulta
  válida ao feed para mostrar a classificação com seu horário quando a fonte
  fica indisponível. A cópia é identificada como desatualizada e atualizada
  quando uma nova consulta válida chega.
- **Fluxo de simulação:** o painel sobre o modelo começa recolhido; a rodada
  mostra quantos palpites estão definidos, permite completar somente os jogos
  vazios e limpar os placares. As opções Casa/Empate/Fora têm nomes acessíveis,
  e as mudanças de posição e as chances atuais aparecem em um resumo do cenário.
- **Estatísticas filtráveis:** explore os resultados do snapshot por clube e
  rodada. Cada recorte exibe o número de partidas da amostra; a tabela da
  temporada completa continua disponível abaixo dos filtros.
- **Visita guiada opcional:** disponível na página inicial e na central de
  ajuda, apresenta o painel, a simulação, as estatísticas e os recursos de
  conta sem interromper quem prefere navegar por conta própria.
- **Perfis dos clubes:** incluem gráfico reconstruído da posição rodada a
  rodada e forma recente. A série usa somente resultados locais disponíveis e
  declara as limitações do histórico e dos critérios de desempate.
- **Ao vivo:** separa jogos em andamento, próximos e encerrados da rodada
  consultada, informa horário e origem, e sinaliza quando o feed está
  desatualizado. Os dados seguem os limites da fonte GE acima.
- **Clubes e histórico:** perfis públicos mostram campanha, resultados
  conhecidos, próximos jogos e projeções. A tabela histórica é reconstruída
  somente com placares disponíveis e explicita que pode divergir da oficial.
- **Cenários salvos e favoritos:** usuários autenticados podem nomear, abrir,
  duplicar e excluir cenários entre dispositivos. Links públicos continuam
  compartilhando um cenário sem incluir dados pessoais. Favoritos e
  lembretes internos sincronizam pela conta; visitantes são convidados a entrar
  ou criar uma conta e não veem dados de favoritos.
- **Lembretes:** são avisos dentro do site para jogos futuros dos clubes
  favoritos; exigem a página aberta e não são enviados por e-mail nem exibidos
  quando o site está fechado.
- **Conta:** permite alterar nome e senha, sair e, se o endpoint estiver
  configurado com `SUPABASE_SERVICE_ROLE_KEY`, excluir a conta e os dados
  associados após confirmação da senha.
- **Busca:** encontra clubes e jogos por nome, sigla, estádio ou rodada.
- **Ajuda, privacidade e termos:** a central de ajuda resume os fluxos
  principais e apresenta divulgações sobre categorias de dados, armazenamento
  local e sincronizado, provedores externos, exclusão da conta e condições de
  uso. Antes de publicar comercialmente, revise o texto legal com os dados de
  contato do operador e as configurações efetivas de retenção da hospedagem e
  do Supabase.

## Fonte e limites da atualização

A API anexada extrai dados da página do GE: não é um serviço oficial da CBF e
não fornece o histórico completo de jogos ou o calendário futuro inteiro.
Portanto:

- classificação, pontos, V/E/D, gols, saldo, aproveitamento e forma dos clubes
  vêm da tabela mais recente consultada no GE;
- resultados finais da rodada ativa são incorporados ao snapshot e persistidos
  localmente para aparecerem também após a mudança de rodada;
- o calendário completo e partidas adiadas fora da rodada ativa continuam
  sujeitos ao snapshot local;
- o resumo histórico detalhado é calculado dos resultados conhecidos, não deve
  ser interpretado como um histórico oficial completo após a data do snapshot;
- a página compara jogos, vitórias, empates, derrotas e gols conhecidos com os
  totais da tabela GE. Diferenças são um alerta de cobertura, não uma prova de
  qual placar está faltando;
- a aba **Fontes e método** contém um relatório jogo a jogo. Resultados do
  snapshot não têm procedência individual; resultados observados identificam o
  feed GE; correções mantêm a fonte HTTPS declarada na importação. O processo
  não autentica essas fontes de forma independente;
- as probabilidades usam os totais atuais por clube do GE; como o feed não
  informa separação casa/fora, a proporção de gols mandante/visitante é uma
  referência histórica do snapshot.

### Recuperar resultados não observados

O pacote do GE retorna somente a rodada atual. Se a instância ficar fora do ar
durante jogos, o histórico local pode ficar incompleto. A página compara os
resultados locais aos totais da classificação GE e aponta possíveis diferenças
por clube; essa checagem não consegue deduzir placares ausentes. O GE não é uma
fonte oficial da CBF, e essa comparação não certifica o histórico jogo a jogo.

Para preencher lacunas, confira os placares em uma fonte confiável e autorizada
quando disponível. Prepare um CSV de siglas e resultados:

```csv
round,home,away,homeGoals,awayGoals
30,FLA,PAL,2,1
```

Importe cada lote com a URL HTTPS e o nome da fonte que você conferiu:

```sh
npm run import:results -- resultados.csv https://fonte-verificada.example "Nome da fonte"
```

O importador exige que cada confronto exista no calendário, valida rodada e
placar, rejeita duplicatas e não sobrescreve resultados divergentes já
registrados. Ele registra a fonte e a data da importação em
`data/historical-backfill-2026.json`, que deve ser revisado e publicado junto
com o site. A validação normal verifica o snapshot mais esse arquivo. O
importador não autentica a fonte nem confirma o placar por conta própria: não
importe dados sem conferi-los.

O arquivo [data/season-2026.json](./data/season-2026.json) é o snapshot de
contingência e registra fonte e instante de atualização. Para mantê-lo:

1. Confira resultados, calendário, estádios e horários nas fontes indicadas no
   JSON.
2. Atualize `results` e `fixtures` em conjunto. Cada resultado deve corresponder
   a uma partida marcada como `played`.
3. Atualize `updatedAt` para o instante real da conferência.
4. Rode `npm run validate:data` e `npm test`.

O validador confere 20 clubes, 380 jogos, 38 partidas por clube, equilíbrio de
19 jogos em casa e 19 fora, resultados duplicados/órfãos, placares e horários.
Rodadas parcialmente disputadas aparecem como avisos.

## Regras e aproximações

O desempate aplicado é pontos, vitórias, saldo, gols pró e confronto direto
quando somente dois clubes continuam empatados nesses critérios. Cartões e
sorteio não são modelados; empates residuais usam uma ordem estável, explicitamente
não oficial.

As faixas continentais e o número de rebaixados ficam em `qualificationModel`.
As vagas da liga são aproximações: títulos de copas e o regulamento oficial
podem mudar as posições classificatórias. O validador rejeita faixas
sobrepostas ou fora das posições da liga.

A interface trata as faixas de classificação como cenários do modelo, não como
vagas oficiais garantidas. O projeto ainda não confirmou um documento oficial
específico do regulamento 2026 com data de publicação verificável; os cortes não
devem ser apresentados como oficiais até que a fonte seja adicionada e conferida.

Cada simulação Monte Carlo usa a semente configurável do cenário. Com os mesmos
dados, palpites, ajustes e semente, as chances são reproduzíveis. A aba
**Corrida** mostra a chance de título de todos os clubes, calculada pelo mesmo
modelo e número de simulações.

A aba **Meus palpites** também calcula calibração das probabilidades salvas em
cada previsão. O Brier score de três resultados é a média da soma dos erros
quadráticos para casa/empate/fora (0 é perfeito; menor é melhor), e a tabela de
confiabilidade compara confiança média com frequência observada por faixas.
Somente previsões com snapshot e resultado registrado entram nessas métricas;
amostras pequenas não são evidência de desempenho futuro.

Em telas estreitas, tabelas e relatórios rolam horizontalmente dentro de regiões
identificadas. Os campos de placar e os controles principais têm alvos de toque
maiores; as abas também aceitam navegação por setas, Home e End.

## Configuração de publicação

- **`SITE_URL`** (variável de ambiente do servidor): endereço público do site, por exemplo `https://simulabr.com.br`.
  Com ela, as tags `og:image` e `twitter:image` saem com URL absoluta, o que o WhatsApp, o X e o Facebook exigem
  para mostrar a pré-visualização ao compartilhar o link. Sem ela, o caminho fica relativo.
- **`CONTACT_EMAIL`** (constante no início do `app.js`): e-mail exibido em Privacidade e Termos. Vazio, o site aponta
  para o perfil do operador no GitHub.
- **App instalável / offline:** `manifest.webmanifest` e `sw.js` funcionam em HTTPS ou `localhost`. Ao criar um módulo
  novo em `src/`, inclua-o no `PRECACHE` de `sw.js` (o teste `test/pwa.test.js` avisa se esquecer).
- **Formatação:** `npm run format` aplica o Prettier; `npm run format:check` só confere.
