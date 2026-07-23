/**
 * Contrato central do roteador de intenções.
 *
 * Objetivo do sistema: dado um enunciado livre do usuário (em qualquer idioma),
 * reduzir um catálogo de N comandos (~40-60, espalhados por vários agentes) a um
 * top-K enxuto (padrão 5) que é entregue à LLM. A métrica que importa é
 * recall@K — a intenção correta precisa estar entre os K, não necessariamente
 * em primeiro lugar.
 */

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

/** Identificador de agente. Novos agentes entram aqui e no registry do catálogo. */
export type AgentId = 'risk' | 'trader' | 'content' | 'public-offerings';

export interface AgentDef {
  id: AgentId;
  /** Nome curto exibível, em pt-BR. */
  name: string;
  /** O que o agente cobre. Usado como contexto no rerank e na montagem do prompt. */
  description: string;
}

export type ParamType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

export interface CommandParam {
  name: string;
  type: ParamType;
  required: boolean;
  /** Descrição em pt-BR; vira `description` no JSON Schema entregue à LLM. */
  description: string;
  /** Obrigatório quando `type === 'enum'`. */
  enumValues?: string[];
}

/**
 * Uma intenção roteável.
 *
 * O indexador gera **vários vetores por comando** (ver `VectorKind`): o texto
 * canônico, cada utterance de exemplo e o bloco de keywords. Isso é o que
 * sustenta o recall@5 num catálogo pequeno — uma única embedding da descrição
 * perde paráfrases e gírias de mesa.
 */
export interface CommandDef {
  /** Estável e único no catálogo inteiro. Convenção: `<agent>.<snake_case>`. */
  id: string;
  agent: AgentId;
  /** Nome curto em pt-BR, no imperativo. Ex.: "Calcular VaR da carteira". */
  name: string;
  /** Uma linha descrevendo o que o comando faz e quando usá-lo. */
  description: string;
  /**
   * Paráfrases reais de como um usuário pediria isso — pt-BR (incluindo forma
   * coloquial e jargão de mesa), en e es. Mínimo de 8 por comando; é a alavanca
   * mais forte de recall que existe neste desenho.
   */
  utterances: string[];
  /**
   * Âncoras lexicais que a embedding densa costuma diluir: siglas (VaR, IPO,
   * CVM, PnL), tickers, nomes de produto, números de instrução normativa.
   * Alimentam o índice BM25 e recebem peso extra na fusão.
   */
  keywords: string[];
  params: CommandParam[];
  /**
   * Comandos facilmente confundíveis com este. Usado só pelo eval, para reportar
   * matrizes de confusão — não influencia o roteamento.
   */
  confusableWith?: string[];
}

export interface Catalog {
  agents: AgentDef[];
  commands: CommandDef[];
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * Vetor L2-normalizado. Como tudo é normalizado na escrita, similaridade de
 * cosseno vira produto escalar puro — o kNN não precisa dividir por normas.
 */
export type Vector = Float32Array;

/**
 * Modelos assimétricos (família E5, BGE, Nomic) exigem prefixos diferentes para
 * consulta e documento. Errar isso derruba recall de forma silenciosa, então o
 * provider expõe as duas rotas separadamente em vez de um `embed()` genérico.
 */
export interface EmbeddingProvider {
  /** Identificador estável; entra na chave de cache do índice. */
  readonly id: string;
  readonly dimensions: number;
  /** `true` se consulta e documento usam prefixos/instruções distintos. */
  readonly asymmetric: boolean;

  /** Embeda enunciados do usuário (lado "query"). */
  embedQueries(texts: string[]): Promise<Vector[]>;
  /** Embeda textos do catálogo (lado "passage"/"document"). */
  embedDocuments(texts: string[]): Promise<Vector[]>;

  /** Libera recursos nativos (sessões ONNX). Idempotente. */
  dispose?(): Promise<void>;
}

/** Reordenador cross-encoder opcional (estágio 2). */
export interface RerankProvider {
  readonly id: string;
  /**
   * Pontua cada documento contra a query conjuntamente. Retorna scores na mesma
   * ordem da entrada; a escala é livre (logits), então o chamador normaliza.
   */
  rerank(query: string, documents: string[]): Promise<number[]>;
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Índice
// ---------------------------------------------------------------------------

/** De qual campo do comando o vetor foi derivado. */
export type VectorKind = 'canonical' | 'utterance' | 'keywords';

export interface IndexedVector {
  commandId: string;
  kind: VectorKind;
  /** Texto exato que foi embedado (já com prefixo do provider aplicado). */
  text: string;
  vector: Vector;
}

export interface CommandIndex {
  catalog: Catalog;
  vectors: IndexedVector[];
  /** Matriz densa achatada, `vectors.length * dimensions`, para o produto escalar em lote. */
  matrix: Float32Array;
  dimensions: number;
  providerId: string;
  /** Hash do catálogo + provider; invalida o cache em disco quando muda. */
  fingerprint: string;
  builtAt: string;
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

/** Rastro de por que um comando entrou no top-K — indispensável para depurar recall. */
export interface ScoreBreakdown {
  /** Melhor cosseno entre a query e qualquer vetor do comando. */
  dense: number;
  /** BM25 normalizado sobre nome + keywords + utterances. */
  lexical: number;
  /** Score do cross-encoder, quando o rerank rodou. */
  rerank?: number;
  /** Posição em cada lista antes da fusão (1-based); ausente = fora da lista. */
  ranks: { dense?: number; lexical?: number; rerank?: number };
  /** O texto indexado que deu o melhor match denso. Ótimo para diagnosticar. */
  matchedText: string;
  matchedKind: VectorKind;
}

export interface RouteCandidate {
  commandId: string;
  command: CommandDef;
  /** Score final pós-fusão, monotônico mas sem escala fixa. Só ordena. */
  score: number;
  breakdown: ScoreBreakdown;
}

export interface RouteResult {
  query: string;
  /** Ordenado por `score` desc, no máximo `topK`. */
  candidates: RouteCandidate[];
  /**
   * `true` quando nenhum candidato passou do piso de confiança — sinal para a
   * LLM pedir esclarecimento em vez de escolher uma ferramenta a esmo.
   */
  abstained: boolean;
  timings: {
    embedMs: number;
    searchMs: number;
    rerankMs: number;
    totalMs: number;
  };
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/** Como combinar as listas densa e lexical. */
export type FusionStrategy =
  /** Reciprocal Rank Fusion: usa só posições, imune a escalas incompatíveis. */
  | { kind: 'rrf'; k: number }
  /** Soma ponderada após normalização min-max de cada lista. */
  | { kind: 'weighted'; denseWeight: number; lexicalWeight: number };

export interface RouterConfig {
  /** Quantos comandos entregar à LLM. Padrão 5. */
  topK: number;
  /**
   * Tamanho do pool de recuperação antes do rerank. Precisa folgar bem sobre
   * `topK` — é dele que o cross-encoder resgata o acerto que o denso enterrou.
   */
  candidatePool: number;
  fusion: FusionStrategy;
  /** Desliga para rodar só denso (mais rápido, recall menor em siglas). */
  useLexical: boolean;
  /** Desliga para pular o cross-encoder (corta ~30-80ms por chamada). */
  useRerank: boolean;
  /**
   * Teto de comandos por agente no resultado final. Impede que um agente com
   * comandos quase-duplicados ocupe as 5 vagas. `0` desliga a trava.
   */
  maxPerAgent: number;
  /** Abaixo deste cosseno no melhor candidato, `abstained = true`. */
  abstainThreshold: number;
}

// ---------------------------------------------------------------------------
// Saída para a LLM
// ---------------------------------------------------------------------------

/** Uma tool no formato aceito pela API da Anthropic (e compatível com function calling). */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ---------------------------------------------------------------------------
// Avaliação
// ---------------------------------------------------------------------------

export interface EvalExample {
  query: string;
  /** Id do comando correto. */
  expected: string;
  lang: 'pt' | 'en' | 'es';
  /**
   * Rótulo do tipo de dificuldade — "coloquial", "sigla", "ambíguo",
   * "multi-idioma", "typo". Serve para quebrar o recall por categoria.
   */
  tag: string;
}

export interface EvalReport {
  total: number;
  recallAt: Record<number, number>;
  mrr: number;
  abstainRate: number;
  byAgent: Record<string, { total: number; recallAtK: number }>;
  byTag: Record<string, { total: number; recallAtK: number }>;
  byLang: Record<string, { total: number; recallAtK: number }>;
  /** Exemplos em que o alvo ficou fora do top-K. É por onde se melhora o sistema. */
  misses: Array<{
    query: string;
    expected: string;
    lang: string;
    tag: string;
    /** Posição real do alvo na lista completa, ou -1 se nem foi recuperado. */
    expectedRank: number;
    got: string[];
  }>;
  latency: { p50: number; p95: number; p99: number };
}
