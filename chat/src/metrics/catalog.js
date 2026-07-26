// Catálogo de KPIs do trader-chat (fonte da verdade das queries de métrica).
// TODOS os KPIs filtram por PERÍODO: o SQL recebe $1 = cutoff (epoch-ms) e conta
// apenas eventos com created_at >= $1. O período (1d/1w/1m/3m) é escolhido na tela.
// O SQL vive no servidor (nunca exposto ao cliente).

const PERIODS = [
    { id: '1d', label: '1 dia', days: 1 },
    { id: '1w', label: '1 semana', days: 7 },
    { id: '1m', label: '1 mês', days: 30 },
    { id: '3m', label: '3 meses', days: 90 },
]

const SECTIONS = [
    { id: 'exec', title: 'Resumo Executivo', description: 'Os números que a diretoria olha primeiro: adoção, qualidade de compreensão e saúde de execução.' },
    { id: 'conversa', title: 'Saúde da Conversa', description: 'Qualidade e experiência: latência, comprimento, tempo até resolver e abandono.' },
    { id: 'agentes', title: 'Agentes & Comandos', description: 'Mix de uso: trader (negócio) vs system, todos os comandos e desempenho por comando.' },
    { id: 'ordens', title: 'Ordens / Execução', description: 'Resultado de execução: notional enviado, conversão em ordem e fluxo enviadas/canceladas.' },
    { id: 'llm', title: 'LLM & Performance', description: 'Custo e confiabilidade do motor: throughput, chamadas e tokens por dia e taxa de erro.' },
]

const HEADLINE = ['conversas_totais', 'usuarios_ativos', 'taxa_resolucao', 'taxa_nao_reconhecido', 'ordens_enviadas', 'taxa_cancelamento']

const KPIS = [
    // ── Resumo Executivo ────────────────────────────────────────────────
    { id: 'conversas_totais', section: 'exec', name: 'Conversas totais', question: 'Quantas conversas no período?', viz: 'big_number', good_direction: 'up', format: 'number',
        sql: `SELECT COUNT(*) AS v FROM conversations WHERE created_at >= $1` },
    { id: 'usuarios_ativos', section: 'exec', name: 'Usuários ativos', question: 'Quantos usuários distintos?', viz: 'big_number', good_direction: 'up', format: 'number',
        sql: `SELECT COUNT(DISTINCT COALESCE(owner_account, owner_user_profile_id)) AS v FROM conversations WHERE created_at >= $1` },
    { id: 'taxa_resolucao', section: 'exec', name: 'Taxa de resolução', question: '% de turns com resultado útil (card, sem erro, entendido)', viz: 'big_number', good_direction: 'up', format: 'percent',
        sql: `SELECT ROUND(100.0*COUNT(*) FILTER (WHERE had_output_card AND NOT is_not_found AND NOT errored)/NULLIF(COUNT(*),0),1) AS v FROM turns WHERE created_at >= $1` },
    { id: 'taxa_nao_reconhecido', section: 'exec', name: 'Taxa de não-reconhecimento', question: '% das mensagens que o chat não entendeu (notFound)', viz: 'big_number', good_direction: 'down', format: 'percent',
        sql: `SELECT ROUND(100.0*COUNT(*) FILTER (WHERE is_not_found)/NULLIF(COUNT(*),0),1) AS v FROM turns WHERE created_at >= $1` },
    { id: 'ordens_enviadas', section: 'exec', name: 'Ordens enviadas', question: 'Quantas ordens saíram ao mercado?', viz: 'big_number', good_direction: 'up', format: 'number',
        sql: `SELECT COUNT(*) AS v FROM order_events WHERE event_type='ORDER_SENT' AND created_at >= $1` },
    { id: 'taxa_cancelamento', section: 'exec', name: 'Taxa de cancelamento de ordens', question: '% dos eventos de ordem que foi cancelamento', viz: 'big_number', good_direction: 'down', format: 'percent',
        sql: `SELECT ROUND(100.0*COUNT(*) FILTER (WHERE event_type='ORDER_CANCELED')/NULLIF(COUNT(*),0),1) AS v FROM order_events WHERE created_at >= $1` },

    // ── Saúde da Conversa ───────────────────────────────────────────────
    { id: 'latencia_p50', section: 'conversa', name: 'Latência mediana do turn', question: 'p50 do tempo de resposta', viz: 'big_number', good_direction: 'down', format: 'ms',
        sql: `SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_latency_ms)::numeric,0) AS v FROM turns WHERE created_at >= $1` },
    { id: 'media_turns', section: 'conversa', name: 'Média de turns por conversa', question: 'Quantas mensagens por conversa, em média?', viz: 'big_number', good_direction: 'neutral', format: 'number2',
        sql: `SELECT ROUND(AVG(c)::numeric,2) AS v FROM (SELECT conversation_id, COUNT(*) c FROM turns WHERE created_at >= $1 GROUP BY conversation_id) x` },
    { id: 'turns_primeira_resolucao', section: 'conversa', name: 'Turns até a 1ª resolução', question: 'Em que turno chega o 1º resultado útil?', viz: 'big_number', good_direction: 'down', format: 'number2',
        sql: `SELECT ROUND(AVG(fs)::numeric,1) AS v FROM (SELECT conversation_id, MIN(seq) fs FROM turns WHERE created_at >= $1 AND had_output_card AND NOT is_not_found AND NOT errored GROUP BY conversation_id) x` },
    { id: 'abandono', section: 'conversa', name: 'Abandono (proxy)', question: '% de conversas cujo último turno foi notFound/erro', viz: 'big_number', good_direction: 'down', format: 'percent',
        sql: `SELECT ROUND(100.0*COUNT(*) FILTER (WHERE bad)/NULLIF(COUNT(*),0),1) AS v FROM (SELECT DISTINCT ON (conversation_id) conversation_id, (is_not_found OR errored) AS bad FROM turns WHERE created_at >= $1 ORDER BY conversation_id, seq DESC) x` },
    { id: 'dist_tamanho', section: 'conversa', name: 'Distribuição de tamanho de conversa', question: 'Quantas conversas curtas vs longas?', viz: 'bar', good_direction: 'neutral', format: 'number',
        sql: `SELECT CASE WHEN c=1 THEN '1 turn' WHEN c<=3 THEN '2-3' WHEN c<=8 THEN '4-8' WHEN c<=15 THEN '9-15' ELSE '16+' END AS label,
                     COUNT(*) AS n, MIN(CASE WHEN c=1 THEN 1 WHEN c<=3 THEN 2 WHEN c<=8 THEN 3 WHEN c<=15 THEN 4 ELSE 5 END) AS ord
              FROM (SELECT conversation_id, COUNT(*) c FROM turns WHERE created_at >= $1 GROUP BY conversation_id) x
              GROUP BY label ORDER BY ord` },

    // ── Agentes & Comandos ──────────────────────────────────────────────
    { id: 'agentes_acessados', section: 'agentes', name: 'Agentes acessados', question: 'trader (negócio) vs system (saudação/notFound)', viz: 'donut', good_direction: 'neutral', format: 'number',
        sql: `SELECT agent AS label, COUNT(*) AS n, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),1) AS pct FROM command_executions WHERE created_at >= $1 GROUP BY agent ORDER BY n DESC` },
    { id: 'comandos_uso', section: 'agentes', name: 'Uso de comandos', question: 'Quais comandos mais usados (todos)?', viz: 'bar', good_direction: 'neutral', format: 'number',
        sql: `SELECT command_method AS label, agent, COUNT(*) AS n, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),1) AS pct FROM command_executions WHERE created_at >= $1 GROUP BY command_method, agent ORDER BY n DESC` },
    { id: 'desempenho_comando', section: 'agentes', name: 'Desempenho por comando', question: 'Latência média/p95 do turno por comando', viz: 'table', good_direction: 'neutral', format: 'number',
        sql: `SELECT ce.command_method, ce.agent, COUNT(*) AS execucoes,
                     ROUND(AVG(t.total_latency_ms)::numeric,2) AS avg_ms,
                     ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY t.total_latency_ms)::numeric,2) AS p95_ms
              FROM command_executions ce JOIN turns t ON t.id=ce.turn_id
              WHERE ce.created_at >= $1 GROUP BY 1,2 ORDER BY 3 DESC` },

    // ── Ordens / Execução ───────────────────────────────────────────────
    { id: 'notional', section: 'ordens', name: 'Valor total enviado (boletas)', question: 'Notional financeiro enviado ao mercado', viz: 'big_number', good_direction: 'up', format: 'brl',
        sql: `SELECT COALESCE(SUM(quantity*price),0) AS v FROM order_events WHERE event_type='ORDER_SENT' AND created_at >= $1` },
    { id: 'conversas_com_ordens', section: 'ordens', name: 'Conversas com ordens', question: '% de conversas que geraram ao menos uma ordem', viz: 'big_number', good_direction: 'up', format: 'percent',
        sql: `SELECT ROUND(100.0*COUNT(DISTINCT oe.conversation_id)/NULLIF((SELECT COUNT(*) FROM conversations WHERE created_at >= $1),0),1) AS v
              FROM order_events oe WHERE oe.conversation_id IS NOT NULL AND oe.created_at >= $1` },
    { id: 'sent_vs_canceled', section: 'ordens', name: 'Enviadas vs canceladas', question: 'Volume de ordens por tipo', viz: 'donut', good_direction: 'neutral', format: 'number',
        sql: `SELECT event_type AS label, COUNT(*) AS n FROM order_events WHERE created_at >= $1 GROUP BY event_type ORDER BY n DESC` },
    { id: 'ordens_por_dia', section: 'ordens', name: 'Ordens por dia', question: 'Enviadas e canceladas por dia no período', viz: 'timeseries', good_direction: 'neutral', format: 'number',
        sql: `SELECT to_timestamp(created_at/1000.0)::date::text AS dia,
                     COUNT(*) FILTER (WHERE event_type='ORDER_SENT') AS enviadas,
                     COUNT(*) FILTER (WHERE event_type='ORDER_CANCELED') AS canceladas
              FROM order_events WHERE created_at >= $1 GROUP BY 1 ORDER BY 1` },

    // ── LLM & Performance ───────────────────────────────────────────────
    { id: 'throughput', section: 'llm', name: 'Throughput', question: 'Turns processados no período', viz: 'big_number', good_direction: 'neutral', format: 'number',
        sql: `SELECT COUNT(*) AS v FROM turns WHERE created_at >= $1` },
    { id: 'llm_por_dia', section: 'llm', name: 'Chamadas de LLM por dia', question: 'Volume de chamadas de LLM por dia', viz: 'timeseries', good_direction: 'neutral', format: 'number',
        sql: `SELECT to_timestamp(created_at/1000.0)::date::text AS dia, COUNT(*) AS chamadas FROM llm_calls WHERE created_at >= $1 GROUP BY 1 ORDER BY 1` },
    { id: 'tokens_por_dia', section: 'llm', name: 'Tokens por dia', question: 'Tokens consumidos por dia (custo)', viz: 'timeseries', good_direction: 'down', format: 'number',
        sql: `SELECT to_timestamp(created_at/1000.0)::date::text AS dia, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens FROM llm_calls WHERE created_at >= $1 GROUP BY 1 ORDER BY 1` },
    { id: 'taxa_erro', section: 'llm', name: 'Taxa de erro dos turns', question: '% de turns que quebraram', viz: 'big_number', good_direction: 'down', format: 'percent',
        sql: `SELECT ROUND(100.0*COUNT(*) FILTER (WHERE errored)/NULLIF(COUNT(*),0),2) AS v FROM turns WHERE created_at >= $1` },

    // ── Custo (tokens × preço por modelo) ───────────────────────────────
    { id: 'tokens_por_conversa', section: 'llm', name: 'Tokens por conversa', question: 'Consumo médio de tokens por conversa', viz: 'big_number', good_direction: 'down', format: 'number',
        sql: `SELECT ROUND(AVG(toks)::numeric,0) AS v FROM (
                SELECT t.conversation_id, SUM(COALESCE(lc.input_tokens,0)+COALESCE(lc.output_tokens,0)) AS toks
                FROM llm_calls lc JOIN turns t ON t.id=lc.turn_id
                WHERE lc.created_at >= $1 GROUP BY t.conversation_id) x` },
    { id: 'custo_estimado', section: 'llm', name: 'Custo estimado (LLM)', question: 'Quanto custou o LLM no período (via model_pricing)', viz: 'big_number', good_direction: 'down', format: 'usd',
        sql: `SELECT ROUND(SUM(COALESCE(lc.input_tokens,0)*mp.price_per_input_token + COALESCE(lc.output_tokens,0)*mp.price_per_output_token)::numeric,2) AS v
              FROM llm_calls lc
              JOIN model_pricing mp ON mp.model_id = lc.model
                 AND lc.created_at >= mp.effective_from AND (mp.effective_to IS NULL OR lc.created_at < mp.effective_to)
              WHERE lc.created_at >= $1` },
    { id: 'custo_por_modelo', section: 'llm', name: 'Custo por modelo', question: 'Chamadas, tokens e custo por modelo (preço de model_pricing)', viz: 'table', good_direction: 'neutral', format: 'number',
        sql: `SELECT mp.model_id AS modelo, mp.currency AS moeda, COUNT(*) AS chamadas,
                     SUM(COALESCE(lc.input_tokens,0)) AS input_tokens, SUM(COALESCE(lc.output_tokens,0)) AS output_tokens,
                     ROUND(SUM(COALESCE(lc.input_tokens,0)*mp.price_per_input_token + COALESCE(lc.output_tokens,0)*mp.price_per_output_token)::numeric,4) AS custo
              FROM llm_calls lc
              JOIN model_pricing mp ON mp.model_id = lc.model
                 AND lc.created_at >= mp.effective_from AND (mp.effective_to IS NULL OR lc.created_at < mp.effective_to)
              WHERE lc.created_at >= $1 GROUP BY mp.model_id, mp.currency ORDER BY chamadas DESC` },
]

const CATALOG = { periods: PERIODS, sections: SECTIONS, headline: HEADLINE, kpis: KPIS }

module.exports = { CATALOG, PERIODS }
