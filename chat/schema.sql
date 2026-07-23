-- Schema do trader-chat (Postgres). ÚNICA fonte de DDL do projeto — o código da
-- aplicação NÃO executa CREATE TABLE; ele só faz DML (INSERT/SELECT/UPDATE).
--
-- Aplicação:
--   * automática: o docker-compose monta este arquivo em
--     /docker-entrypoint-initdb.d/, então um container Postgres NOVO já sobe com
--     o schema aplicado (`docker compose up -d`).
--   * manual:  psql "$DB_CONVERSATION_CONNECTION" -f schema.sql
--              (ou: docker exec -i trader-chat-postgres psql -U chat -d chat < schema.sql)
--
-- Tipos: tempo em BIGINT epoch-ms (o código grava Date.now()); `agents` em JSONB.
-- Tudo IF NOT EXISTS => idempotente (seguro reaplicar).

-- ============================================================================
-- Registro de conversa (config durável: versão + agentes + dono)
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
    id                    TEXT PRIMARY KEY,
    owner_mode            TEXT,
    owner_account         TEXT,
    owner_user_profile_id TEXT,
    version               TEXT,
    agents                JSONB,
    status                TEXT,
    created_at            BIGINT,
    last_activity_at      BIGINT,
    expires_at            BIGINT
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner_account ON conversations (owner_account);
CREATE INDEX IF NOT EXISTS idx_conversations_status        ON conversations (status);

-- ============================================================================
-- Auditoria / KPIs (append-only, 1 turno = 1 mensagem do usuário)
-- ============================================================================
CREATE TABLE IF NOT EXISTS turns (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT REFERENCES conversations (id) ON DELETE SET NULL,
    context_id       TEXT,
    seq              BIGINT,
    user_text        TEXT,
    agent_text       TEXT,
    state            TEXT,
    next_state       TEXT,
    interrupt        BOOLEAN,
    interrupt_type   TEXT,
    abstained        BOOLEAN,
    had_output_card  BOOLEAN,
    output_card_type TEXT,
    is_not_found     BOOLEAN,
    errored          BOOLEAN,
    total_latency_ms DOUBLE PRECISION,
    created_at       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_turns_conversation_id ON turns (conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_created_at      ON turns (created_at);

CREATE TABLE IF NOT EXISTS routing_events (
    id                  TEXT PRIMARY KEY,
    turn_id             TEXT REFERENCES turns (id) ON DELETE CASCADE,
    query_text          TEXT,
    model_id            TEXT,
    catalog_fingerprint TEXT,
    config_topk         BIGINT,
    abstained           BOOLEAN,
    latency_ms          DOUBLE PRECISION,
    created_at          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_routing_events_turn_id ON routing_events (turn_id);

CREATE TABLE IF NOT EXISTS routing_candidates (
    id               TEXT PRIMARY KEY,
    routing_event_id TEXT REFERENCES routing_events (id) ON DELETE CASCADE,
    rank             BIGINT,
    command_id       TEXT,
    agent            TEXT,
    method           TEXT,
    score            DOUBLE PRECISION,
    was_executed     BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_routing_candidates_event ON routing_candidates (routing_event_id);

CREATE TABLE IF NOT EXISTS command_executions (
    id               TEXT PRIMARY KEY,
    turn_id          TEXT REFERENCES turns (id) ON DELETE CASCADE,
    seq              BIGINT,
    command_method   TEXT,
    agent            TEXT,
    result_status    TEXT,
    output_card_type TEXT,
    in_router_topk   BOOLEAN,
    router_rank      BIGINT,
    created_at       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_command_executions_turn_id ON command_executions (turn_id);
CREATE INDEX IF NOT EXISTS idx_command_executions_method  ON command_executions (command_method);

CREATE TABLE IF NOT EXISTS llm_calls (
    id            TEXT PRIMARY KEY,
    turn_id       TEXT REFERENCES turns (id) ON DELETE CASCADE,
    mode          TEXT,
    model         TEXT,
    input_tokens  BIGINT,
    output_tokens BIGINT,
    latency_ms    DOUBLE PRECISION,
    parse_ok      BOOLEAN,
    created_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_turn_id ON llm_calls (turn_id);
