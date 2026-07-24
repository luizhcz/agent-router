# Trader Chat

Chat de agentes (trader + content) com **roteador de intenções** embutido: a cada
mensagem, um modelo de embedding (MiniLM, 100% offline em `chat/models/`) pré-filtra
os ~48 comandos do catálogo para um **top-8** antes de chamar a LLM. O motor de
roteamento vive integrado em `src/router/engine/` (CommonJS) — o projeto é
autocontido, sem dependências da raiz do repositório.

## Rodar

```bash
cd chat
npm install
npm start          # http://localhost:8080/trader-chat  (porta = HTTP_PORT no .env)
```

Infra opcional (persistência real de conversa/KPIs em Postgres + Redis):

```bash
docker compose up -d          # sobe Postgres (5442) e Redis (6389)
```

Sem `DB_CONVERSATION_CONNECTION` / `REDIS_CONVERSATION_ENDPOINT` no `.env`, a
aplicação cai em mocks in-memory e roda sem Docker. Sem `LLM_ENDPOINT`, usa uma LLM
mock. O schema do banco (DDL) vive em `schema.sql` — a aplicação **não** cria tabelas.

---

## Endpoints

Base: `http://localhost:8080` · prefixo `/api/trader-chat`.

**Autenticação (obrigatória em toda rota de conversa/chat):** um header de identidade —
`x-efs-account: <conta>` (modo digital) **ou** `x-efs-user-profile-id: <id>` (modo admin).
Ausente ⇒ `400`.

| Método | Rota | Descrição |
|---|---|---|
| `GET`  | `/trader-chat` | UI HTML do chat |
| `GET`  | `/api/trader-chat/info` | versão/ambiente do serviço |
| `POST` | `/api/trader-chat/conversation` | **cria** a conversa (versão + agentes) |
| `GET`  | `/api/trader-chat/conversation` | lê o registro da conversa |
| `DELETE` | `/api/trader-chat/conversation` | encerra a conversa (`status=closed`) |
| `POST` | `/api/trader-chat` | **envia** uma mensagem |
| `GET`  | `/api/trader-chat` | **recebe** a resposta do agente (long-poll ~30s) |
| `DELETE` | `/api/trader-chat` | reseta o contexto (limpa o histórico em memória) |
| `GET`  | `/api/trader-chat/history` | histórico (`?count=&role=&audit=`) |
| `GET`  | `/api/trader-chat/data` | estado/dados atuais do agente |

---

## Fluxo: conversa como recurso (`version` + `conversation-id`)

A conversa é um **recurso provisionado**: o cliente cria passando a **versão** do prompt
e os **agentes** habilitados; o servidor cunha um **id opaco** (`conv_…`) e guarda a
config. As mensagens seguintes só carregam esse id — o servidor resolve o resto
(versão fixada, escopo de agentes, dono).

### 1. Criar a conversa — `POST /api/trader-chat/conversation`

```bash
curl -s -X POST http://localhost:8080/api/trader-chat/conversation \
  -H "Content-Type: application/json" \
  -H "x-efs-account: 12345" \
  -d '{ "version": "1.0.0", "agents": ["trader", "content"] }'
```

**Corpo:**
- `version` — versão do prompt (`prompts/prompt.<version>.yml`; hoje: `1.0.0`).
  **Omitida ⇒ latest** (padrão). É **imutável** por conversa (fixada na criação).
- `agents` — subconjunto de agentes habilitados. **Omitido/`[]` ⇒ todos** os disponíveis
  (`trader`, `content`). Agente fora da lista é bloqueado (escondido do prompt e rejeitado
  na execução, mesmo se injetado).

**Resposta `201`:**
```json
{
  "conversationId": "conv_QzR8t7...",
  "version": "1.0.0",
  "agents": ["trader", "content"],
  "expiresAt": 1737045600000
}
```

### 2. Enviar mensagem — `POST /api/trader-chat`

Repita o **mesmo** header de identidade da criação (o servidor confere que você é o dono)
e mande o `conversation-id`:

```bash
CID="conv_QzR8t7..."
curl -s -X POST http://localhost:8080/api/trader-chat \
  -H "Content-Type: application/json" \
  -H "x-efs-account: 12345" \
  -H "conversation-id: $CID" \
  -d '{ "content": "qual a cotação da PETR4?" }'
```

Retorna o eco da mensagem do usuário; a resposta do agente é assíncrona (passo 3).

### 3. Receber a resposta — `GET /api/trader-chat` (long-poll)

```bash
curl -s http://localhost:8080/api/trader-chat \
  -H "x-efs-account: 12345" \
  -H "conversation-id: $CID"
# → { "role": "agent", "content": "A PETR4 está cotada a R$ 38,42 (+1,23%)." }
```

### Erros

| Status | Quando |
|---|---|
| `400` | identidade ausente · `version` não é semver · agente desconhecido · `conversation-id` ausente |
| `403` | a identidade autenticada não é a dona da conversa |
| `404` | conversa não encontrada ou **expirada** (TTL renovado a cada uso; ~8h de inatividade) |
| `410` | conversa **encerrada** (após `DELETE`) |

### Compatibilidade (modelo antigo, sem `conversation-id`)

Sem o header `conversation-id`, o modelo antigo baseado em headers continua funcionando:
`x-efs-account` (ou `x-efs-user-profile-id`) + `x-chat-id` (isola a conversa) +
`x-version` (seleciona a versão do prompt). Diferença: **sem escopo de agentes** (todos
habilitados) e estado só em memória.

---

## Estender: novo COMANDO

O runtime extrai os comandos por **reflexão** sobre o código-fonte da classe do agente
(`Class.toString()`), lendo blocos `/* # COMMAND */`. Não há registro manual.

**1. Adicione o método + bloco** na classe do agente
(`src/agents/trader-agent.js` ou `src/agents/content-agent.js`):

```js
/* # COMMAND
consulta o preço/cotação atual de um ativo
@input symbol: str -> ticker do ativo (ex.: PETR4)
@output lastPrice: number -> preço mais recente
@example qual o preço de PETR4
@example quanto está a vale hoje
*/
async getQuote({ symbol }) {
  // ...sua lógica; retorne o resultado (vira INPUT_RAW_DATA da resposta)
}
```

Sintaxe do bloco:
- **1ª linha livre** → descrição do comando.
- `@input nome: tipo -> desc` · `@output nome: tipo -> desc`.
- `@example <frase>` → few-shot: vai ao **prompt da LLM** *e* alimenta o router.
- `@note[out] <texto>` → instrução aplicada na redação da resposta.
- `# COMMAND [flag]` → disponibilidade condicional (ver `_evalFlag`).

**2. Nada mais no runtime** — o comando aparece no catálogo no próximo boot.

**3. (Recomendado) Aumente o recall** em `src/router/utterances/<agente>.json`, sob a
chave do método — frases coloquiais/multilíngues. **Só o router lê esse arquivo**, então
é recall de graça (zero token no prompt):

```json
{ "getQuote": ["cotação da vale", "quanto tá negociando", "preço agora", "..."] }
```

**4. Reinicie** (`npm start`). O fingerprint do índice muda → ele **reconstrói sozinho**
(não precisa apagar `.cache/`). O comando entra no top-8.

---

## Estender: novo AGENTE

**1. Crie a classe** em `src/agents/<novo>-agent.js`, seguindo a **cadeia de herança**
(o estado precisa ser uma instância única — por isso herança encadeada, não irmãos):

```js
const { ContentAgent } = require('./content-agent')

class RiskAgent extends ContentAgent {
  /* # COMMAND
  avalia o enquadramento de risco da carteira do cliente
  @input account: str -> conta do cliente
  @example estou enquadrado no meu perfil de risco?
  */
  async getRiskProfile({ account }) { /* ... */ }
}

module.exports = { RiskAgent }
```

**2. Registre em `src/agents/index.js`** — importe, adicione ao `commandSources` e
estenda o composite pela **nova ponta** da cadeia:

```js
const { RiskAgent } = require('./risk-agent')

class TraderChatAgent extends RiskAgent {}   // era `extends ContentAgent`

TraderChatAgent.commandSources = [
  { agent: 'trader',  class: TraderAgent },
  { agent: 'content', class: ContentAgent },
  { agent: 'risk',    class: RiskAgent },     // novo
]
```

**3. Metadados do agente** em `src/router/catalog-builder.js` (`agentMeta`):

```js
risk: { id: 'risk', name: 'Risco', description: 'Enquadramento e perfil de risco da carteira.' },
```
Sem isso, cai num fallback genérico (`{id, name, description: id}`) — funciona, só menos
descritivo na lista de agentes do router.

**4. (Opcional)** `src/router/utterances/risk.json` com frases por método (recall).

**5. Escopo de conversa é automático:** `availableAgents` (em `application.js`) é derivado
dos comandos tagueados, então o novo agente já pode ser habilitado no
`POST /conversation` (`"agents": ["risk", "trader"]`) e o gate `_agentInScope` filtra o
resto.

**6. Reinicie** → índice reconstrói → agente roteável.

> **Não-quebrável:** se o router falhar ou não rankear bem, os comandos `greetings`/
> `notFound` sempre passam, e um comando ainda chega à LLM se ficar no top-8. Sem router
> disponível, todos os comandos vão ao prompt (comportamento original).
