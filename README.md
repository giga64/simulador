# Simulador do Brasileirão 2026

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

As simulações e preferências ficam no `localStorage` daquele navegador; o
backup JSON e o link/código transportam o cenário entre navegadores sem
sincronização de conta. Quando uma partida deixa de ser futura, palpites salvos
para ela são removidos, preservando os demais palpites e configurações.

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

Cada simulação Monte Carlo usa a semente configurável do cenário. Com os mesmos
dados, palpites, ajustes e semente, as chances são reproduzíveis. A aba
**Corrida** mostra a chance de título de todos os clubes, calculada pelo mesmo
modelo e número de simulações.
