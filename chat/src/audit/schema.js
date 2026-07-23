// Schema do log de auditoria/KPIs (append-only). Grão: 1 turn = 1 mensagem do
// usuário + processamento. As ligações que valem ouro (docs/design-notes.md Parte 1):
// routing_candidates × command_executions (rank do que rodou) e o par model_id +
// catalog_fingerprint em routing_events (atribuição de mudança de métrica).
//
// Em Postgres real: timestamptz no lugar de BIGINT epoch-ms; redigir user_text/agent_text
// (PII) ou guardá-los em store apartado de retenção curta; índices por (turn_id) e (created_at).

const TABLES = {
    turns: `CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        context_id TEXT,
        seq BIGINT,
        user_text TEXT,
        agent_text TEXT,
        state TEXT,
        next_state TEXT,
        interrupt BOOLEAN,
        interrupt_type TEXT,
        abstained BOOLEAN,
        had_output_card BOOLEAN,
        output_card_type TEXT,
        is_not_found BOOLEAN,
        errored BOOLEAN,
        total_latency_ms DOUBLE PRECISION,
        created_at BIGINT
    )`,

    routing_events: `CREATE TABLE IF NOT EXISTS routing_events (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        query_text TEXT,
        model_id TEXT,
        catalog_fingerprint TEXT,
        config_topk BIGINT,
        abstained BOOLEAN,
        latency_ms DOUBLE PRECISION,
        created_at BIGINT
    )`,

    routing_candidates: `CREATE TABLE IF NOT EXISTS routing_candidates (
        id TEXT PRIMARY KEY,
        routing_event_id TEXT,
        rank BIGINT,
        command_id TEXT,
        agent TEXT,
        method TEXT,
        score DOUBLE PRECISION,
        was_executed BOOLEAN
    )`,

    command_executions: `CREATE TABLE IF NOT EXISTS command_executions (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        seq BIGINT,
        command_method TEXT,
        agent TEXT,
        result_status TEXT,
        output_card_type TEXT,
        in_router_topk BOOLEAN,
        router_rank BIGINT,
        created_at BIGINT
    )`,

    llm_calls: `CREATE TABLE IF NOT EXISTS llm_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        mode TEXT,
        model TEXT,
        input_tokens BIGINT,
        output_tokens BIGINT,
        latency_ms DOUBLE PRECISION,
        parse_ok BOOLEAN,
        created_at BIGINT
    )`,
}

async function initSchema(pg) {
    for (const ddl of Object.values(TABLES)) {
        await pg.query(ddl)
    }
}

module.exports = { TABLES, initSchema, TABLE_NAMES: Object.keys(TABLES) }
