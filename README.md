# agent-router

Roteador de intenções multilíngue para reduzir um catálogo grande de comandos a um
top-K enxuto **antes** de chamar a LLM.

## O problema

O sistema tem **48 comandos distribuídos em 4 agentes** (`risk`, `trader`,
`content`, `public-offerings` — 12 comandos cada). Entregar as 48 ferramentas de
uma vez para a LLM em cada turno é caro (tokens de tool schema), degrada a
qualidade da escolha (quanto mais opções, mais erro) e não escala quando o
catálogo cresce.

A proposta é simples de enunciar e difícil de acertar: dado um enunciado livre do
usuário, **em qualquer idioma** (pt-BR coloquial, jargão de mesa, inglês,
espanhol, com typo ou sigla), selecionar os **8 comandos mais prováveis** e mandar
só esses para a LLM decidir. O roteador é um **pré-filtro de recall**, não o
decisor final — quem escolhe a ferramenta continua sendo a LLM. (`topK=8` foi
medido: com o MiniLM, recall@5=97.5% mas recall@8=98.8% — a resposta certa está
quase sempre no top-8, e 8 tools ainda é muito menos que as 48 do catálogo.)

Isso muda a métrica que importa (ver [Por que recall@5](#por-que-recallk-e-não-acurácia1)).

## Arquitetura do pipeline

Todo o roteamento vive em `IntentRouter` (`src/router/router.ts`). Uma consulta
percorre, **nesta ordem**:

1. **Catálogo multi-representação** (`src/catalog/*`, `src/router/router.ts:collectDocSpecs`).
   Cada comando não vira um único vetor. O indexador gera **vários vetores por
   comando**: o texto canônico (`nome. descrição`), **cada** utterance de exemplo
   (mínimo 8 por comando, em pt/en/es, incluindo forma coloquial) e o bloco de
   keywords. Uma embedding só da descrição perderia paráfrases e gírias — é a
   representação múltipla que sustenta o recall num catálogo pequeno.

2. **Embedding** (`src/embeddings/*`). Todos os textos do catálogo são embedados
   pelo lado "documento"; a consulta, pelo lado "query". O modelo padrão é
   `paraphrase-multilingual-MiniLM-L12-v2` (384d), **simétrico** — os dois lados
   usam o mesmo texto, sem prefixos — rodando 100% offline da pasta `models/`.
   A abstração suporta também modelos **assimétricos** (família E5, prefixos
   `"query: "`/`"passage: "`), por isso o provider expõe `embedDocuments` e
   `embedQueries` separados em vez de um `embed()` genérico — trocar de modelo é
   só mudar o preset (`ROUTER_MODEL=e5`). Todo vetor sai **L2-normalizado**, de
   modo que cosseno vira produto escalar puro no resto do sistema.

3. **kNN denso** (`router.ts:denseSearch`). Produto escalar em lote da query
   contra a matriz densa achatada. Para cada comando toma-se o **maior** cosseno
   entre a query e qualquer um de seus vetores (*max-sim*) — assim uma utterance
   coloquial que casa bem "puxa" o comando inteiro. Guarda-se também qual vetor
   venceu (`matchedText`/`matchedKind`), essencial para depurar.

4. **BM25 léxico** (`src/router/lexical.ts`). Índice esparso em memória sobre
   nome + utterances + keywords. Dois campos: palavras (stopwords mínimas pt/en/es,
   **sem stemming** — code-switching gera stems-lixo) e char 3-grams (tolerância a
   typo). Keywords entram **duplicadas e sem filtro de stopword** (peso extra).
   É o estágio que recupera siglas, tickers e números de instrução normativa
   (VaR, IPO, CVM, DI) que a embedding densa dilui.

5. **Fusão** (`src/router/fusion.ts`). Combina as listas densa e léxica. Padrão:
   **Reciprocal Rank Fusion (RRF, k=60)**, que usa só as **posições** — imune ao
   fato de o cosseno viver em ~[0.7, 0.9] e o BM25 ser ilimitado. Alternativa:
   soma ponderada após min-max (`weighted`), útil quando houver dados rotulados
   para calibrar pesos.

6. **Rerank** (**sem cross-encoder por padrão**). Não há reranker embutido. Foi
   medido que um cross-encoder (jina-reranker-v2) só sobe recall@8 de 98.8% para
   99.2% (+0.4pt) ao custo de ~20x a latência (22ms→430ms) e de um segundo modelo
   — não compensa num pool pequeno onde a etapa densa+léxica já satura. O router
   mantém um **hook genérico** de reranker (`RouterOptions.reranker` + `useRerank`)
   para quem quiser injetar o seu, mas nenhum é fornecido.

7. **Cap por agente** (`src/router/diversify.ts:capPerAgent`, **desligado por
   padrão**, `maxPerAgent: 0`). Teto de comandos por agente no resultado, para
   impedir que um agente cheio de quase-duplicatas ocupe as 8 vagas. Sob gold
   único, diversificar só pode *remover* um candidato relevante, então fica off por
   padrão; há também `mmr()` exportado, mas não faz parte do pipeline padrão.

8. **Corte em top-8** (`router.ts`, `config.topK`). O prefixo final entregue.

9. **Tools** (`src/llm/*`). Os 8 comandos viram `tools` no formato da API da
   Anthropic (`toToolSchemas`), com um system prompt que ensina a LLM que a lista
   foi **pré-filtrada** — a resposta certa quase certamente está entre as opções,
   mas não necessariamente em primeiro lugar — e um `tool_choice`.
   `buildToolChoicePayload` devolve `{ tools, tool_choice, system }` pronto para
   `client.messages.create`.

**Abstenção.** Em paralelo, o roteador decide `abstained` comparando o **melhor
cosseno denso** (grandeza interpretável em [0,1], não o score fundido) contra
`abstainThreshold`. O limiar é **específico do modelo** (a escala de cosseno
difere): o CLI injeta ~0.58 para o MiniLM e ~0.72 para o E5, calibrados por índice
de Youden sobre o dataset. Quando abstém, os candidatos **ainda são devolvidos** —
abstenção é um sinal para a LLM preferir pedir esclarecimento, não motivo para
esconder recall. Nesse caso `buildToolChoicePayload` acrescenta a tool de escape
`pedir_esclarecimento`.

O índice denso é construído uma vez e cacheado em disco (`cacheDir`). O
**fingerprint** (SHA-256 de catálogo + provider + versão da indexação) invalida o
cache automaticamente quando qualquer um deles muda.

## Por que recall@K e não acurácia@1

Porque o roteador **não decide** — ele filtra. A decisão final de qual ferramenta
chamar é da LLM, sobre os 5 candidatos. O que o roteador precisa garantir é que o
comando certo esteja **entre os 5** entregues; a posição exata (1º ou 4º) é
irrelevante, porque a LLM lê a descrição de todos antes de escolher e o prompt a
instrui explicitamente a tratar a ordem como sinal fraco.

Medir **acurácia@1** puniria o roteador por colocar a resposta certa em 2º lugar —
um "erro" que a LLM corrige de graça — e otimizaria para a métrica errada
(reordenar o topo em vez de garantir cobertura). **Recall@5** mede exatamente o
contrato do pré-filtro: *a intenção correta sobreviveu ao corte?* Como o gold é
único por exemplo, recall@5 é 0/1 por consulta. O relatório também traz recall@1 e
recall@3, mas apenas como diagnóstico — o alvo de otimização é o @5.

## Comandos npm

Os únicos scripts que existem de fato (`package.json`):

| Comando | O que faz |
|---|---|
| `npm run index:build` | Valida o catálogo, embeda tudo e **persiste o índice** em `.cache/router-index`. Aceita `--force` para reconstruir do zero. Rode antes dos demais para não pagar o build em memória. |
| `npm run router` | REPL interativo de roteamento (via `explainRoute`). Comandos internos `/config`, `/set <chave> <valor>`, `/tools`, `/help`, `/quit`. Passar uma consulta por argv roteia uma vez e sai. |
| `npm run eval` | Roda o harness sobre o dataset rotulado e imprime o `EvalReport`. |
| `npm run bench` | Mede latência de roteamento por fase (embed/busca), p50/p95/p99. Flags `--runs N`, `--warmup N`. |
| `npm run build` | Compila para `dist/` (`tsconfig.build.json`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` / `npm run test:watch` | Vitest (unidade: fusão, léxico, catálogo, tools, diversify, roteador). |

Flags comuns a `router`/`eval`/`bench`: `--top-k N`, `--lexical`/`--no-lexical`.
`--top-k` também alarga o `candidatePool` (`max(N*4, 20)`) para o pool nunca ficar
menor que o top-K.

## Trocar o modelo de embedding

O provider padrão é **local e 100% offline** (`@huggingface/transformers` +
onnxruntime-node): `paraphrase-multilingual-MiniLM-L12-v2`, **384 dims, fp32,
pooling `mean`, SIMÉTRICO (sem prefixos)**, carregado de
`models/paraphrase-multilingual-MiniLM-L12-v2/` (não baixa nada em runtime).

Pré-requisito: baixar os pesos ONNX para essa pasta uma vez (o `.onnx` é grande e
fica fora do git — ver `.gitignore`):

```bash
DIR=models/paraphrase-multilingual-MiniLM-L12-v2
BASE=https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main
mkdir -p "$DIR/onnx"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json unigram.json; do
  curl -sL --fail "$BASE/$f" -o "$DIR/$f"; done
curl -sL --fail "$BASE/onnx/model.onnx" -o "$DIR/onnx/model.onnx"
```

**Presets prontos** em `MODEL_PRESETS` (`src/embeddings/local.ts`): `minilm`
(padrão, offline) e `e5` (E5-base assimétrico 768d, baixa do Hub na 1ª vez). Cada
modelo tem uma **escala de cosseno própria**, então o `abstainThreshold` é
calibrado por modelo em `resolveModelChoice` (`src/cli/shared.ts`): MiniLM ≈ 0.58,
E5 ≈ 0.72. Ao trocar de modelo, recalibre com `.scratch/calibrate.ts`.

**Via variáveis de ambiente** (afeta os CLIs, ver `src/cli/shared.ts`):

```bash
ROUTER_MODEL=e5 npm run eval                 # usa o E5-base (baixa do Hub)
ROUTER_MODEL=minilm npm run eval             # padrão: MiniLM offline da pasta local
ROUTER_MODELS_DIR=/outra/raiz npm run eval   # aponta outra raiz de modelos locais
ROUTER_CACHE_DIR=/caminho/alternativo npm run index:build
```

**Via API** (`createEmbeddingProvider`, `src/embeddings/`): o campo `kind`
seleciona a implementação — `local`, `openai` ou `cohere`. Para o provider local,
o que muda a **representação** dos vetores é configurável e entra na chave de cache:

```ts
const embedder = await createEmbeddingProvider({
  kind: 'local',
  model: 'Xenova/multilingual-e5-large',
  dimensions: 1024,
  pooling: 'mean',       // 'last_token' para decoders (Qwen3); nunca 'mean' num last-token
  queryPrefix: 'query: ',
  documentPrefix: 'passage: ',
  asymmetric: true,
});
```

Cuidado que sustenta o recall: o `id` do provider embute um hash de
`pooling` + prefixos + `asymmetric`, além de model/dtype/dimensions. Trocar
qualquer desses gera um **novo fingerprint de índice**, então o cache antigo é
descartado e o catálogo é reembedado — query e documentos nunca acabam em espaços
de representação diferentes por acidente. Basta rodar `npm run index:build` depois
de mudar o modelo (ou deixar o primeiro `route()` reconstruir em memória).

## Adicionar um agente ou um comando

**Adicionar um comando** a um agente existente:

1. Em `src/catalog/<agente>.ts`, acrescente um `CommandDef` ao array de comandos:
   - `id` no formato `<agent>.<snake_case>` (estável e único no catálogo inteiro);
   - `name` curto no imperativo, `description` de uma linha;
   - **no mínimo 8 `utterances`** em pt/en/es (é a alavanca de recall mais forte);
   - `keywords` (siglas, tickers, nomes de produto — vão para o BM25 com peso extra);
   - `params` com tipos (`string|number|boolean|date|enum`; `enum` exige `enumValues`).
2. Valide: `npm run index:build` roda `validateCatalog` e aborta listando problemas
   (id duplicado, <8 utterances, sem keywords, prefixo de id errado etc.).
3. O fingerprint muda automaticamente → o índice é reconstruído no próximo build.
4. Adicione ~5 exemplos ao `evalDataset` (`src/eval/dataset.ts`) — formulações
   **novas**, não cópias das utterances — e rode `npm run eval`.

**Adicionar um agente novo** (passos extras antes dos acima):

1. Inclua o novo id em `AgentId` (`src/types.ts`).
2. Crie `src/catalog/<agente>.ts` exportando um `AgentDef` e o array de `CommandDef`.
3. Registre ambos em `src/catalog/index.ts` (`agents: [...]` e `commands: [...]`).
4. Siga os passos de "adicionar um comando" para cada comando do agente.

## Interpretar a saída do eval

`npm run eval` (`src/cli/eval.ts` → `runEval` → `computeReport`) imprime:

- **Métricas globais**: `recall@1/3/5/8`, `MRR` (média de 1/rank sobre o ranking
  completo; alvo não recuperado conta 0) e **taxa de abstenção**. Cores: verde
  ≥90%, amarelo ≥75%, vermelho abaixo. O número que decide é o **recall@topK**
  (padrão **recall@8**), o ponto de operação real do sistema.
- **Quebras** por agente, idioma e tag (`coloquial`, `sigla`, `ambiguo`,
  `telegrafico`, `typo`, `formal`, `multi-idioma`, `contexto-longo`), todas em
  recall@topK — mostram *onde* o roteador falha (ex.: recall bom em `formal` e ruim
  em `sigla` aponta para reforçar keywords/BM25).
- **Latência** de roteamento p50/p95/p99.
- **Misses** — o coração do relatório. Cada consulta cujo alvo ficou fora do top-K,
  com a **posição real** do alvo no ranking completo e o top-K que saiu no lugar.
  Ler a posição:
  - `posição real #9..#N` → o comando **foi recuperado**, mas a fusão o ranqueou
    abaixo do corte; ajustar pesos/RRF, alargar o `topK` ou reforçar utterances
    pode salvá-lo.
  - `não recuperado` (`expectedRank = -1`) → o alvo nem entrou no pool de produção;
    é falha de **representação** (faltam utterances/keywords que casem com aquele
    vocabulário), não de ordenação.

Fidelidade do harness (`src/eval/run.ts`): para descobrir a posição real do alvo,
o eval alarga **apenas** o `topK` até a profundidade do `candidatePool` de
produção — **nunca** o `candidatePool` em si. Assim o prefixo top-5 devolvido é
bit-a-bit o de produção sob qualquer config, e recall/MRR são o valor real do
roteador; um alvo fora do pool de produção aparece como `-1`, exatamente como
produção o perderia.

## Números medidos

Medido nesta máquina (Apple arm64) sobre o dataset de 240 exemplos, com o modelo
padrão (**MiniLM offline, 384d, sem rerank, topK=8**):

| Métrica | MiniLM (padrão) | E5-base (`ROUTER_MODEL=e5`) |
|---|---|---|
| recall@8 | **98.8%** | — |
| recall@5 | 97.5% | 97.1% |
| recall@1 | 87.1% | 91.3% |
| MRR | 0.918 | 0.941 |
| latência p50 | **23 ms** | 83 ms |
| build do índice | 4.3 s | 14.5 s |

Leitura: o MiniLM empata/ganha em recall@8 e é ~3–4x mais rápido; o E5 é melhor só
em recall@1/MRR (precisão na 1ª posição, que não é a métrica-alvo). O ensemble dos
dois chega a 98.3% em recall@5, mas para recall@8 o MiniLM sozinho já entrega mais.
Os números não são versionados como relatório; reproduza com:

```bash
npm run index:build   # aquece o cache (offline, da pasta models/)
npm run eval          # recall@1/3/5/8, MRR, abstenção, quebras, misses
npm run bench         # latências p50/p95/p99
```

## Exemplo (API pública)

Superfície pública em `src/index.ts`:

```ts
import {
  IntentRouter,
  createEmbeddingProvider,
  catalog,
  buildToolChoicePayload,
} from 'agent-router';

// Provider local/offline: E5 base, 768d. cacheDir persiste o índice denso.
const embedder = await createEmbeddingProvider({ kind: 'local' });
const router = await IntentRouter.create({
  catalog,
  embedder,
  cacheDir: '.cache/router-index',
});

const result = await router.route(
  'quanto o fundo pode perder num dia ruim com 99% de confiança?',
);

for (const c of result.candidates) {
  console.log(c.score.toFixed(3), c.commandId, '·', c.command.name);
}
console.log('abstained:', result.abstained);

// Pronto para a API da Anthropic: { tools, tool_choice, system }.
// A tool `pedir_esclarecimento` entra sozinha quando result.abstained é true.
const payload = buildToolChoicePayload(result);
// await client.messages.create({ model, messages, ...payload });

await router.dispose();
```
