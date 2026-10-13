# Dados, fontes e modelo

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

## Modelo

O código do modelo fica em `src/model/`, em funções puras e testadas. O
navegador e o servidor usam exatamente o mesmo código (`season-model.js`), então
as chances da página, do histórico e da imagem de compartilhamento coincidem.

- `expected-goals.js`: gols esperados de cada lado a partir de ataque e defesa
  relativos à média da liga, com `k` jogos fictícios de regressão à média,
  força do mando e o ajuste manual de cada clube;
- `poisson.js`: distribuição de placares (Poisson com correção de
  Dixon-Coles) e a amostragem por busca binária;
- `standings.js`: classificação e desempates;
- `monte-carlo.js`: 10.000 simulações do restante do campeonato. Elas rodam
  em um Web Worker (`monte-carlo.worker.js`) para não travar a página; sem
  suporte a workers de módulo, rodam na thread principal;
- `live-matches.js`: jogos em andamento;
- `backtest.js` e `team-ratings.js`: avaliação do modelo fora da amostra.

### Por que k = 14

`npm run backtest` prevê cada rodada desde a 8ª usando só os jogos anteriores a
ela e mede o erro com o Brier score (menor é melhor). Na temporada 2026:

| Configuração                                       | Brier  |
| -------------------------------------------------- | ------ |
| Referência ingênua (só a frequência casa/empate/fora) | 0,6435 |
| k = 6 (padrão anterior)                            | 0,6365 |
| **k = 14 (padrão atual)**                          | 0,6315 |
| Peso maior para jogos recentes (meia-vida 6–20 rodadas) | pior em todos os k testados |

As diferenças são pequenas e o k foi escolhido pelo mesmo teste, então é um
ajuste fino, não uma garantia. Rode o backtest de novo com mais rodadas antes de
mudar o padrão. A aba **Chances › Qualidade do modelo** mostra esse teste com os
ajustes escolhidos pelo usuário.

### Histórico de chances

`npm run build:history` reconstrói, para cada rodada já disputada, as chances
calculadas só com os resultados até ela, e grava em
`data/probability-history-2026.json`. Depois, o servidor tira uma nova foto a
cada resultado novo (`RUNTIME_DIR/probability-history.json`). A aba
**Chances › Evolução** e o perfil de cada clube mostram esses dados. As rodadas
antigas usam o modelo atual: mostram o que ele diria naquele momento, não o
que o site publicou na época.

### Modelo x casas de apostas

Com `ODDS_API_KEY`, o servidor guarda as odds de cada jogo antes do início,
remove a margem das casas (normalizando 1/odd) e registra a probabilidade do
modelo no mesmo instante. Depois do jogo, os dois são comparados pelo Brier
score em **Chances › Qualidade do modelo**.

Cada simulação Monte Carlo usa a semente configurável do cenário. Com os mesmos
dados, palpites, ajustes e semente, as chances são reproduzíveis. A aba
**Chances** mostra a classificação final provável, o mapa de posições, a
evolução ao longo da temporada e a qualidade do modelo.

Na visão de um clube, **Jogos que mais mexem nas chances** usa as mesmas
simulações. Para cada jogo ao vivo e das duas próximas rodadas, compara a
chance da meta escolhida (título, G5, Sul-Americana ou fugir do Z4) quando o
mandante vence, quando empata e quando o visitante vence, e indica o resultado
mais favorável ao clube.

## Jogos ao vivo

Partidas com status `live` no feed:

- entram na classificação com o placar atual, como se terminassem agora, com
  um chip ● ao lado dos dois clubes;
- não aceitam palpite: o card mostra o placar, o minuto e as chances de casa,
  empate e fora a partir do placar atual. Um palpite feito antes do início
  continua guardado e é avaliado em **Palpites** quando o jogo termina;
- nas simulações, partem do placar atual e sorteiam só os gols do tempo que
  falta (gols esperados multiplicados pela fração restante da partida);
- o card do jogo mostra quanto o placar atual mudou a chance de cada time na
  meta mais em disputa (por exemplo, "Sul-Americana 41% → 58%"). Para isso, uma
  segunda simulação trata o jogo como se ainda não tivesse começado.

O feed não informa o minuto. Ele é estimado pelo horário de início: 1º tempo de
cerca de 47 minutos de relógio, 15 minutos de intervalo e depois o 2º tempo.

Alguns sites atualizam a classificação durante o jogo. Quando a tabela tem, para
os dois clubes, exatamente um jogo a mais do que os resultados conhecidos, o
placar parcial é descontado dela antes de ser somado de novo. Assim ele nunca é
contado duas vezes.

A página consulta `/api/live-season` em segundo plano, sem recarregar: a cada
minuto quando há jogo ao vivo e a cada 2 minutos fora disso. A consulta pausa
com a aba escondida e é feita na hora em que a página volta a ficar visível. O
cenário, a rolagem e o campo em edição são preservados. Gols, inícios e fins de
jogo aparecem como aviso. O servidor segue o mesmo ritmo na consulta ao GE.

A aba **Palpites** também calcula calibração das probabilidades salvas em
cada previsão. O Brier score de três resultados é a média da soma dos erros
quadráticos para casa/empate/fora (0 é perfeito; menor é melhor), e a tabela de
confiabilidade compara confiança média com frequência observada por faixas.
Somente previsões com snapshot e resultado registrado entram nessas métricas;
amostras pequenas não são evidência de desempenho futuro.

Em telas estreitas, tabelas e relatórios rolam horizontalmente dentro de regiões
identificadas. Os campos de placar e os controles principais têm alvos de toque
maiores; as abas também aceitam navegação por setas, Home e End.

## Copas

### Fontes e licenças

| Fonte | Uso | Licença |
| ----- | --- | ------- |
| ESPN (`site.api.espn.com`, slugs `conmebol.libertadores`, `conmebol.sudamericana`, `bra.copa_do_brazil`) | Jogos, grupos e chaveamento de 2026; resultados 2021–2026 das copas e das dez ligas nacionais para o Elo | API pública não oficial, sem licença aberta. Os dados brutos ficam só em `.runtime/` (fora do repositório); no repositório vão apenas as notas derivadas |
| [openfootball/south-america](https://github.com/openfootball/south-america) | 3.750 jogos 2012–2025 (Libertadores, Sul-Americana, Copa do Brasil 2025) para média de gols, mando e pênaltis | CC0 1.0 (domínio público) |
| TheSportsDB (chave pública `3`) | Logos das competições e escudos que a ESPN não tem | Uso conforme os termos do site; imagens baixadas, sem hotlink |
| Imprensa sobre os regulamentos 2026 (El Gráfico, 24horas, O Imparcial, Band, NetVasco, Soccerway) | Regras de cada fase e vagas para 2027 | — |

Não há dados abertos da Libertadores 2011 nem da Copa do Brasil antes de 2025
no openfootball; a ESPN tem esses anos, mas sem licença de redistribuição, então
eles entram só no Elo (como dado derivado).

### Formato e regras (`src/competitions/formats.js`)

Cada regra tem a fonte e um campo `confirmed`. Não confirmadas no texto
oficial, e por isso configuráveis:

- prorrogação antes dos pênaltis na final única da Copa do Brasil (padrão: não);
- critérios de desempate da fase de grupos da Sul-Americana (assumidos iguais
  aos da Libertadores 2026).

### Força dos clubes (`npm run build:ratings`)

- **Elo** de 411 clubes com 8.493 jogos: K 30 em copas e 20 em ligas, ganho
  maior para goleadas, 20% de regressão à média por temporada e duas passadas
  para estabilizar clubes com poucos jogos.
- **Mando de campo medido**: por liga nos campeonatos nacionais e, nas copas
  contra estrangeiros, por país, controlando a força dos times (o valor que
  faz o resultado esperado bater com o real). Brasileiros e argentinos têm o
  mando mais forte nas copas.
- **Gols**: Poisson com `λ = exp(base + mando + inclinação × ΔElo/400)`; base e
  mando vêm do histórico do openfootball, a inclinação é ajustada por máxima
  verossimilhança nos jogos de copa de 2024–2026.
- **Editável**: `data/club-ratings-overrides.json` (para todos) e os botões − e
  + na aba Copas (só no navegador de cada visitante).

### Simulação

O mata-mata é simulado com o mesmo número de cenários e a mesma semente do
Brasileirão (10.000). Jogos ao vivo partem do placar atual; empate no agregado
vai à prorrogação só onde o regulamento manda e, depois, aos pênaltis (50%
para cada lado, como no histórico de 2012–2025).

### Vagas na Libertadores 2027

Regra da CBF para 2026: 5 vagas pelo Brasileirão (1º–4º na fase de grupos, 5º na
preliminar) e 2 pelos finalistas da Copa do Brasil (campeão nos grupos, vice na
preliminar); campeões brasileiros da Libertadores e da Sul-Americana ganham
vaga extra. Quando um classificado pelas copas já está no G5, a vaga desce na
tabela. A aba **Chances › Vagas 2027** combina, simulação a simulação, o
Brasileirão com as três copas. Não simula a exigência de o clube estar na Série
A no ano da Libertadores.
