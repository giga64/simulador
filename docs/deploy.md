# Publicar o SimulaBR

Para atualização automática, a hospedagem precisa executar este servidor Node
e encaminhar a página e `/api/live-season` pelo mesmo domínio. GitHub Pages e
outros hosts puramente estáticos não executam o endpoint: nesses casos, o
simulador ainda abre, mas usa o snapshot e mostra um aviso de indisponibilidade.

Em produção, o servidor escuta `PORT` e, por padrão, aceita conexões externas
quando `NODE_ENV=production`. Uma única instância Node com volume persistente é
a configuração mais simples para manter o histórico observado.

Resultados finais observados são guardados em `.runtime/live-results-2026.json`
e reaproveitados depois que a API passa para a rodada seguinte. O diretório não
é publicado pelo servidor. Configure `LIVE_HISTORY_PATH` para apontar a um
volume persistente na hospedagem; sem volume, o histórico coletado fica sujeito
a perder-se quando a instância Node reiniciar.

Arquivos estáticos são servidos com `ETag`. Imagens ficam em cache por um dia;
HTML, JavaScript, CSS e JSON são revalidados a cada acesso, porque os nomes não
têm hash. O service worker (`sw.js`) busca sempre na rede e usa o cache só sem
conexão. Para forçar a limpeza do cache antigo nos navegadores, troque a
constante `CACHE` em `sw.js`.

A imagem de compartilhamento (`og:image` em `index.html`) usa um caminho
relativo. Algumas redes sociais só aceitam URL absoluta: troque
`/assets/og-image.png` pelo endereço completo do site publicado.

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
