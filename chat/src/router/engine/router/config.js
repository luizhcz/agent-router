/**
 * Configuração do roteador: valores-padrão do brief técnico + validação com zod.
 *
 * A validação é a rede de segurança contra combinações incoerentes que degradam
 * recall sem quebrar nada visivelmente (ex.: `candidatePool < topK`, do qual o
 * cross-encoder nunca teria de onde resgatar o alvo).
 */
const { z } = require('zod');
/**
 * Valores-padrão concretos (Brief §8). Todos os campos preenchidos:
 * - topK 8: entregar 8 comandos à LLM (não 5). Medido: com MiniLM, recall@5=97.5%
 *   mas recall@8=98.8% — a resposta certa está quase sempre no top-8, e 8 tools
 *   ainda é muito menos que as 48 do catálogo. O custo marginal na LLM é baixo.
 * - RRF k=60: zero-tuning, robusto a escalas incompatíveis (denso ~0.5-0.7 vs BM25 ilimitado).
 * - useLexical: siglas/tickers que o denso dilui exigem BM25.
 * - useRerank false: SEM cross-encoder. Medido que o rerank (jina) só sobe
 *   recall@8 de 98.8%→99.2% (+0.4pt) ao custo de ~20x latência (22ms→430ms) e um
 *   segundo modelo. Não compensa. O router mantém um hook genérico de reranker
 *   (RouterOptions.reranker), mas nenhum é injetado por padrão.
 * - maxPerAgent 0: diversificação prejudica recall sob gold único.
 * - abstainThreshold 0.72: default da lib (escala do E5). É ESPECÍFICO DO MODELO —
 *   ao instanciar o router com outro modelo, recalibre este valor (MiniLM ~0.58).
 */
const DEFAULT_CONFIG = {
    topK: 8,
    candidatePool: 20,
    fusion: { kind: 'rrf', k: 60 },
    useLexical: true,
    useRerank: false,
    maxPerAgent: 0,
    abstainThreshold: 0.72,
};
const fusionSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('rrf'),
        k: z.number().positive('fusion.rrf.k deve ser > 0'),
    }),
    z.object({
        kind: z.literal('weighted'),
        denseWeight: z.number().min(0, 'denseWeight não pode ser negativo'),
        lexicalWeight: z.number().min(0, 'lexicalWeight não pode ser negativo'),
    }),
]);
const configSchema = z
    .object({
    topK: z.number().int().positive('topK deve ser um inteiro >= 1'),
    candidatePool: z.number().int().positive('candidatePool deve ser um inteiro >= 1'),
    fusion: fusionSchema,
    useLexical: z.boolean(),
    useRerank: z.boolean(),
    maxPerAgent: z.number().int().min(0, 'maxPerAgent não pode ser negativo'),
    abstainThreshold: z
        .number()
        .min(0, 'abstainThreshold deve estar em [0, 1] (escala de cosseno)')
        .max(1, 'abstainThreshold deve estar em [0, 1] (escala de cosseno)'),
})
    .superRefine((c, ctx) => {
    if (c.candidatePool < c.topK) {
        ctx.addIssue({
            code: 'custom',
            message: `candidatePool (${c.candidatePool}) não pode ser menor que topK (${c.topK}): o pool é a folga de onde o rerank resgata o acerto que o denso enterrou`,
            path: ['candidatePool'],
        });
    }
    if (c.fusion.kind === 'weighted' && c.fusion.denseWeight === 0 && c.fusion.lexicalWeight === 0) {
        ctx.addIssue({
            code: 'custom',
            message: 'fusion weighted exige ao menos um peso > 0 (ambos zero zera todos os scores)',
            path: ['fusion'],
        });
    }
});
/**
 * Mescla `partial` sobre `base` (por padrão `DEFAULT_CONFIG`), valida com zod e
 * devolve um `RouterConfig` completo. `fusion` é substituído por inteiro (é uma
 * união discriminada — não se faz merge parcial de estratégia).
 *
 * @throws {Error} com mensagem clara quando a combinação é incoerente.
 */
function resolveConfig(partial, base = DEFAULT_CONFIG) {
    const merged = {
        topK: partial?.topK ?? base.topK,
        candidatePool: partial?.candidatePool ?? base.candidatePool,
        fusion: partial?.fusion ?? base.fusion,
        useLexical: partial?.useLexical ?? base.useLexical,
        useRerank: partial?.useRerank ?? base.useRerank,
        maxPerAgent: partial?.maxPerAgent ?? base.maxPerAgent,
        abstainThreshold: partial?.abstainThreshold ?? base.abstainThreshold,
    };
    const parsed = configSchema.safeParse(merged);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `${i.path.length ? i.path.join('.') : 'config'}: ${i.message}`)
            .join('; ');
        throw new Error(`RouterConfig inválido: ${detail}`);
    }
    return parsed.data;
}
module.exports = { DEFAULT_CONFIG, resolveConfig };
