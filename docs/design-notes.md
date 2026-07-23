# Design Notes — agent-router + trader-chat

Notas de arquitetura para retomar o desenvolvimento. Cobre dois blocos discutidos:
**(1) KPIs & observabilidade** e **(2) arquitetura de conversa** (conversa como recurso
provisionado com versão + agentes). Nada aqui está implementado ainda — é o blueprint acordado.

Contexto do sistema:
- **Pacote `agent-router`** (raiz, TypeScript ESM): roteador de intenções multilíngue. MiniLM
  offline (`paraphrase-multilingual-MiniLM-L12-v2`, 384d), kNN denso + BM25, top-8 por consulta.
  recall@8 medido = 98.8% (dataset offline). Ver `README.md`.
- **`chat/`** (CommonJS): chat de trader de mesa (Research). `AgentRuntime` faz o ciclo
  `mensagem → router reduz 46→8 → LLM extrai comandos (json) → executa nos serviços →
  LLM redige resposta (texto)`. Agentes divididos: **trader** (39 cmds) + **content** (7 cmds,
  Research), via `chat/src/agents/` (BaseAgent → TraderAgent → ContentAgent, cadeia de herança;
  comandos tagueados por agente). Router plugado em `chat/src/router/` (ponte CJS→ESM p/ o dist).

---

# Parte 1 — KPIs & Observabilidade

## O insight que define a medição

**O router restringe as escolhas da LLM.** Depois do pré-filtro, a LLM só escolhe entre os 8
comandos entregues. Logo, "a LLM escolheu certo" NÃO prova que o router acertou — se o comando
certo ficou fora do top-8, a LLM nem teve a chance.

Consequência: **recall do router em produção não é observável direto — precisa de shadow eval.**
Numa amostra do tráfego (5–10%), rode a seleção da LLM sobre o catálogo INTEIRO (sem filtro) e
compare com o top-8 do router. Se a escolha sem filtro ∉ top-8, é um miss de recall.

## O funil (espinha dorsal das KPIs)

Cada pedido atravessa 5 estágios; cada um é um ponto de queda mensurável:

| # | Estágio | KPI | Como medir aqui | Decisão que dispara |
|---|---|---|---|---|
| 1 | Router recall@8 | comando certo ∈ top-8 | shadow eval (LLM sem filtro vs top-8), amostra 5–10% | melhorar utterances/keywords do cluster que falha; ajustar top-K |
| 2 | Precisão da LLM | dado top-8 com o certo, escolheu certo? | logar candidatos do router + comando executado; casar | prompt/goalIn, exemplos, modelo |
| 3 | Sucesso de execução | comando rodou e retornou dado (não `instruction`/erro) | `result_status` de cada comando | corrigir serviço/parâmetro; pré-requisitos (conta/ativo) |
| 4 | Fidelidade da resposta | texto reflete só o INPUT_RAW_DATA (sem alucinar) | LLM-judge/amostra humana | prompt goalOut/rulesOut, modelo |
| 5 | Resultado p/ usuário | intenção resolvida | rephrase imediato, thumbs, notFound, abandono | tudo acima |

Medir o funil separado é o que permite **atribuir** a queda ao lugar certo.

## KPIs por camada

**Router (razão de existir do pré-filtro):**
- **recall@8** (shadow) — métrica-mãe. Offline = 98.8% (teto otimista; produção será menor).
- **Rank do comando executado** dentro do top-8 (MRR-like) — observável sempre. Média subindo p/ 5–6 = corte apertado.
- **Saturação do corte** — % de acertos em rank 7–8. Alta → considerar top-10.
- **Abstention rate** e sua precisão (hoje a abstenção NÃO é usada no filtro; se passar a usar, medir).
- **Latência de roteamento** p50/p95/p99 (embedding + busca) — dezenas de ms.

**Agente / tarefa:**
- **Taxa de sucesso de comando** (executou e retornou dado vs caiu em `AgentRuntime.instruction`).
- **notFound rate** — ambíguo (fora de escopo OU router filtrou o certo); só o shadow eval separa.
- **Taxa de interrupt/esclarecimento** (SymbolSelection, AccountSelection…). Um pouco é saudável; muito é fricção.
- **Turnos até resolução**.
- **Containment** — % resolvido sem escalar p/ "Trader Desktop".

**Custo / LLM (o ROI do router — métrica de dinheiro):**
- **Redução de tokens de prompt** — comandos no prompt (~46 → ~10) e tokens de entrada economizados/msg.
- **Custo por conversa / por mensagem** e **delta vs baseline sem router**.
- **Latência da LLM** p50/p95 (json + texto).
- **Taxa de falha de parse do JSON** (`extractJsonObject` falha → turno quebrado).

## North star (o par que se vigia junto)

Router é otimização de **custo sob restrição de qualidade**. A estrela-guia é um PAR:
**task success (estágios 1–5) mantido enquanto tokens/custo caem.** Sempre no mesmo painel,
comparando *com router vs shadow sem router*. Risco: comemorar custo caindo enquanto a qualidade
sangra sem ninguém ver.

**Anti-KPIs (vaidade):** contagem bruta de mensagens; recall@8 isolado (LLM restrita ainda erra
entre os 8); média de latência sem p95/p99.

## Modelo de dados p/ KPIs

Princípio: **log de eventos append-only** (imutável, granular) + **rollups derivados**
(materializados) p/ painéis. Os eventos crus são a fonte da verdade E viram o dataset de avaliação
real (ver adiante). Tabelas:

```
conversations           (grão: sessão)
  id, context_id_hash, account_hash, channel(digital|admin),
  chat_version, prompt_version, started_at, last_activity_at,
  message_count, status(active|resolved|abandoned), outcome

turns                   (grão: 1 mensagem do usuário + processamento)
  id, conversation_id→, seq, user_text_redacted, created_at,
  state, next_state, interrupt, interrupt_type,
  had_output_card, is_not_found, errored, total_latency_ms

routing_events          (grão: 1 chamada router.route)   ← joia da coroa
  id, turn_id→, query_redacted, model_id, catalog_fingerprint,
  config_topk, config_threshold, abstained, latency_ms, created_at

routing_candidates      (grão: 1 candidato do top-K)
  id, routing_event_id→, rank, command_id, agent, score,
  dense_score, lexical_score, passed_to_llm, was_executed

command_executions      (grão: 1 comando executado)
  id, turn_id→, seq, command_method, agent, params_redacted,
  result_status(success|instruction|interrupt|error|not_found),
  output_card_type, latency_ms,
  in_router_topk, router_rank        ← liga execução ↔ router

llm_calls               (grão: 1 invocação de LLM)
  id, turn_id→, mode(json|text), model, input_tokens,
  output_tokens, cost_usd, latency_ms, parse_ok, temperature

feedback                (grão: 1 sinal do usuário)
  id, turn_id→, type(thumb|rephrase|escalation|csat), value, created_at

shadow_evals            (grão: 1 avaliação amostrada)     ← recall real
  id, turn_id→, unfiltered_llm_choice, in_router_topk,
  router_rank_of_choice, created_at

router_versions         (dimensão de versão)
  model_id, catalog_fingerprint, topk, threshold, deployed_at
```

Ligações que fazem valer ouro: `routing_candidates` × `command_executions` (rank do que rodou +
se o certo estava no top-K) e `shadow_evals` (recall verdadeiro que a LLM restrita esconde).

**Quatro decisões de design:**
1. **Versionamento em cada evento** — `model_id` + `catalog_fingerprint` + config + `prompt_version`
   em `routing_events`. O catálogo é gerado dos `commandElements`; muda quando alguém edita um comando.
   Sem isso, atribuir mudança de métrica vira adivinhação.
2. **PII e retenção** — textos carregam conta/documento (o `getContextId` monta `digital:<conta>`).
   Hash com salt de account/document; redija sequências de dígitos no texto; texto cru curto (30–90d),
   agregados longos; texto integral (se preciso) em store seguro apartado.
3. **Eventos crus → rollups** — materializar `daily_router_metrics`, `daily_agent_metrics`,
   `daily_cost_metrics` (por dia × versão). Não varrer eventos a cada dashboard.
4. **Feche o loop: produção vira eval set** — `routing_candidates` + comando confirmado = rótulos
   reais de produção (melhor que utterances sintéticas, que medem overfitting). Amostre, revise,
   realimente a calibração. Aponta direto os clusters de baixo recall (ex.: `setRequest*`).

**Ordem de instrumentação:** (1) `turns` + `routing_events` + `routing_candidates` +
`command_executions` (funil 1–3 + ROI de tokens); (2) `llm_calls` (custo); (3) `shadow_evals`
(recall real); (4) `feedback` + rollups.

---

# Parte 2 — Arquitetura de Conversa (conversa como recurso)

## A mudança conceitual

Hoje a conversa é uma **chave derivada de headers a cada request**: `getContextId` monta
`digital:123456:chatX:v=1.0.0` juntando conta + chat-id + versão; o runtime guarda estado em
`contexts[essaString]`. Tudo (identidade, versão, isolamento) está codificado no id e recalculado
toda requisição.

Alvo: promover a conversa a **recurso provisionado**. O cliente cria a conversa uma vez; o servidor
**cunha um id opaco** e guarda a config (versão + agentes + dono); as mensagens seguintes só carregam
o id e o servidor resolve o resto do registro. Ganho central: **separar a config durável da conversa
(versão, agentes, identidade) do estado transiente do runtime (memória do agente, mensagens,
pendências)** — hoje fundidos na string do contextId.

## O registro de conversa (modelo)

O id passa a ser **cunhado pelo servidor** — token opaco de alta entropia (UUID ou assinado),
funcionando como *capability*:

```
conversation
  id                 (cunhado; opaco; nova chave do runtime)
  owner              { account | userProfileId, mode: digital|admin }  ← resolvido na criação
  version            (fixada na criação)
  agents             ['trader','content']   ← escopo desta conversa
  status             active | closed | expired
  created_at, last_activity_at, expires_at (TTL)
  metadata           (ex.: conta selecionada inicial p/ admin)
```

Conta/modo/versão **saem da string do id e vão para o registro** — substitui o padrão frágil de
"codificar tudo num id com `:`" por um lookup. É a MESMA entidade `conversations` da Parte 1.

## Endpoints e ciclo de vida

- `POST /api/trader-chat/conversation` — corpo `{ version, agents }`; identidade vem do auth. Valida
  (agentes existem? usuário pode usá-los? versão tem prompt yml?), cria o registro, devolve
  `{ conversationId, version, agents, expiresAt }`.
- `POST/GET /api/trader-chat` — passam a exigir header `conversation-id`; servidor resolve
  versão+agentes+dono do registro. `x-version`/`x-chat-id` deixam de ser lidos (exceto compat).
- `DELETE /api/trader-chat/conversation/:id` — encerra (mapeia no `reset` existente).
- **Compatibilidade** na transição: se vier `conversation-id`, usa o registro; senão cai no
  `getContextId` atual. Remove o legado depois.

## Onde o escopo de agentes morde (3 lugares)

1. **Montagem do prompt** (`getPromptIn`/`getPromptOut`): incluir só comandos dos agentes habilitados
   (`command.agent ∈ conversation.agents`). O runtime já filtra por flag/versão; adicionar o filtro por agente.
2. **Gate de execução** (`isCommandAvailable`/`processCommand`): rejeitar comando de agente não-habilitado
   (defesa em profundidade — comandos injetados via `req.data.commands` escapam do filtro pós-LLM).
3. **Router** (o interessante): rotear só sobre os agentes da conversa.

**Router — a armadilha a evitar:** NÃO construir um índice do router por conversa (reconstruiria
embeddings toda vez). Catálogo pequeno (~48): manter **um índice global único** e **filtrar os
candidatos por agente na hora da rota** — pontua tudo (`searchDenseAll` já existe), descarta agentes
desabilitados, pega top-8 do que sobra. Barato, exato; o `ChatIntentRouter` faz no wrapper sem tocar
o pacote do router. (Índices por-agente mesclados só valem se o catálogo crescer p/ centenas/milhares.)

Esse modelo **generaliza p/ agentes futuros** (risk, public-offerings): o mesmo endpoint deixa abrir
um chat "trader+content", "risk-only", etc. — escopo de agentes vira parâmetro de 1ª classe.

## Versão: fixar na criação

**Versão imutável por conversa** — pinada na criação. Não se quer prompt/comandos mudando no meio da
conversa. `_resolvePromptVersion` e `isCommandAvailable` passam a ler a versão do REGISTRO, não do
header. É o "isolamento por versão" que o `:v=` já sinalizava, feito direito. Migrar versão de uma
conversa, se preciso, é operação explícita (endpoint), não efeito colateral de header.

## Armazenamento e escala

Registro precisa de store. App já tem Redis e DB (mockados):
- **Redis** p/ o registro vivo + TTL (expiração por inatividade; "expira → cliente recria").
- **DB** p/ o durável/auditável (mesma tabela `conversations` das KPIs).

Consequência a explicitar: hoje `runtime.contexts` é **em memória** → (a) morre no restart, (b) não
escala horizontalmente. O modelo de "criar conversa" destrava resolver isso, mas força uma decisão —
**quanto do estado transiente persistir?**
- **Config no store, estado transiente em memória** (reidratação sob demanda) — mudança menor; sessão
  ainda "gruda" numa instância enquanto quente.
- **Estado transiente também no Redis** — stateless de verdade; qualquer instância atende qualquer
  conversa, ao custo de serializar/desserializar o contexto do agente por turno.

Para agora, a primeira basta; a segunda é o alvo p/ múltiplas instâncias atrás de LB.

## Segurança

`conversation-id` vira **capability** (quem tem o id, fala na conversa):
- **Vincular ao dono** na criação e **verificar** em cada request que a identidade autenticada bate
  com `conversation.owner` — senão id vazado = acesso à conversa/dados de conta de outro.
- **Validar agentes na criação** contra o permitido (agente admin-only p/ cliente digital → rejeita).
- Token opaco, alta entropia, nunca sequencial.

## Caminho de migração

1. Introduzir registro + endpoint de criação; id cunhado vira a **nova chave do runtime** (substitui o
   contextId derivado; `getContext` passa a *resolver do registro* em vez de *parsear a string*).
2. Mover versão e agentes do header/id p/ o registro; `getPromptIn`, `isCommandAvailable` e o wrapper
   do router passam a ler o escopo do registro.
3. Manter `getContextId` como fallback de compat por um tempo; depois remover.

## Decisões abertas (chamada de produto)

1. **Versão imutável por conversa?** (recomendo sim) ou trocável em runtime?
2. **Estado transiente**: persistir no Redis (stateless real) ou só a config, sessão em memória por ora?
3. **Comando de agente desabilitado**: escondido do prompt/router apenas, ou rejeitado duro também no
   gate de execução? (recomendo escondido + rejeitado — cinto e suspensório.)
