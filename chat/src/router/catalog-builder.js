// ROUTER — constrói o catálogo do IntentRouter a partir dos comandos do runtime.
//
// O AgentRuntime já extrai, por reflexão, cada comando com { method, agent, notes,
// examples, inputs }. Aqui convertemos isso no shape que o pacote agent-router
// (../../../dist) espera em `Catalog` — reaproveitando os `@example` do domínio
// como utterances (frases reais de usuário) e as siglas/tickers como keywords.

// Palavras que NÃO identificam um comando (poluiriam o BM25): verbos genéricos,
// marcadores de exemplo, e palavras PT/EN em caixa alta que aparecem nas descrições.
const STOP_KW = new Set([
  'user', 'agent', 'system', 'input', 'hist', 'historico', 'histórico', 'null',
  'type', 'symbol', 'fields', 'the', 'and', 'para', 'com', 'que', 'dos', 'das',
  'get', 'set', 'select', 'query', 'cancel', 'list', 'request', 'de', 'da', 'do',
  'compra', 'venda', 'troca', 'fase', 'ordem', 'boleta', 'ativo', 'conta',
  'alternativas', 'objeto', 'foco', 'selecionado', 'atual', 'importante',
]);

/**
 * Remove ARGUMENTOS (tickers como PETR4/ABCD11, números de conta) do texto — eles
 * são parâmetros, não identificadores de intenção. Deixar "qual o preço de PETR4"
 * casar por ticker faria qualquer comando que citou um ticker num exemplo subir no
 * BM25. Normalizamos para o intent puro ("qual o preço de").
 */
function stripArgs(text) {
  return text
    .replace(/\b[A-Z]{3,6}\d{1,2}\b/g, ' ') // tickers (PETR4, ABCD11, BBAS3)
    .replace(/\b\d{4,}\b/g, ' ')            // números de conta / ordem
    .replace(/\bR\$\s*[\d.,]+/g, ' ')       // valores monetários
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrai as falas de usuário de um exemplo. Um `@example` pode ser multi-turno,
 * ex.: "(HIST ...) [user] confere outro -> [agent] qual ativo? -> [user] VALE3 -> {json}".
 * Pegamos cada segmento "[user] ..." (até o próximo `->`, `[agent]` ou `[user]`),
 * limpando parentéticos de contexto e o JSON de saída.
 */
function exampleToUtterances(ex) {
  const raw = typeof ex === 'string' ? ex : ex && ex.text;
  if (!raw) return [];
  const out = [];
  const re = /\[user\]\s*(.+?)(?=\s*->|\s*\[agent\]|\s*\[user\]|$)/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let u = m[1]
      .replace(/\([^)]*\)/g, ' ') // remove (HIST...), (INPUT)
      .replace(/\{[\s\S]*$/, ' ') // remove JSON de saída, se coube no grupo
      .replace(/\[(agent|user|system|input)\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (u.length >= 2 && !/^\{/.test(u)) out.push(u);
  }
  // exemplo sem marcador [user] explícito: usa o texto antes do '->'
  if (out.length === 0) {
    const u = raw.replace(/->[\s\S]*$/, '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (u.length >= 2 && !/^\{/.test(u)) out.push(u);
  }
  return out;
}

/**
 * Siglas/razões que IDENTIFICAM um comando e que a embedding densa dilui — só
 * acrônimos reais (EBITDA, ROE, ROIC, P/L, EV, DY, GTC, Research), nunca tickers
 * (têm dígito → excluídos) nem palavras PT em caixa alta (stoplist). Alimentam o
 * BM25 sem introduzir ruído de argumento.
 */
function extractKeywords(description, exampleTexts) {
  const hay = [description, ...exampleTexts].join(' ');
  const kw = new Set();
  for (const t of hay.match(/\b[A-Z]{2,6}(?:\/[A-Z]{2,6})?\b/g) || []) {
    if (/\d/.test(t)) continue; // exclui tickers e códigos
    if (STOP_KW.has(t.toLowerCase())) continue; // exclui palavras PT/EN em caixa alta
    kw.add(t);
  }
  return [...kw].slice(0, 10);
}

/** `notes` do tipo desc principal (context 'in', state null) → descrição do comando. */
function mainDescription(cmd) {
  const desc = (cmd.notes || []).find((n) => n.context === 'in' && n.state === null);
  return (desc && desc.text) || `comando ${cmd.method}`;
}

/**
 * Converte os commandElements do runtime num `Catalog` do agent-router.
 * Cada comando vira um CommandDef com id `${agent}.${method}` e `method` anexado
 * para o mapeamento de volta ao runtime. Comandos 'system' (greetings/notFound)
 * são incluídos para o router poder roteá-los também.
 */
function buildCatalog(commandElements) {
  const agentsSeen = new Set();
  const commands = [];

  for (const cmd of commandElements) {
    if (!cmd || !cmd.method) continue;
    const agent = cmd.agent || 'trader';
    agentsSeen.add(agent);

    const exampleTexts = (cmd.examples || []).map((e) => (typeof e === 'string' ? e : e && e.text)).filter(Boolean);
    const utterances = [];
    for (const ex of cmd.examples || []) {
      for (const u of exampleToUtterances(ex)) {
        const s = stripArgs(u); // remove tickers/contas: casa o intent, não o argumento
        if (s.length >= 2) utterances.push(s);
      }
    }
    // 1ª nota 'in' curta (a descrição vem daí; notas longas instrucionais poluem)
    for (const n of cmd.notes || []) {
      if (n.context === 'in' && n.state === null && n.text && n.text.length <= 90) {
        utterances.push(stripArgs(n.text));
      }
    }
    const description = mainDescription(cmd);

    commands.push({
      id: `${agent}.${cmd.method}`,
      agent,
      method: cmd.method, // extra: mapeia o candidato de volta ao runtime
      name: cmd.method,
      description,
      utterances: [...new Set(utterances)].filter(Boolean).slice(0, 16),
      keywords: extractKeywords(description, exampleTexts),
      params: (cmd.inputs || []).map((i) => ({
        name: i.name,
        type: 'string',
        required: false,
        description: i.desc || '',
      })),
    });
  }

  const agentMeta = {
    trader: { id: 'trader', name: 'Trader', description: 'Execução, mercado, ordens, boletas, posições e conta.' },
    content: { id: 'content', name: 'Content', description: 'Conteúdo analítico do Research: fundamentos, teses, recomendações, top picks.' },
    system: { id: 'system', name: 'Sistema', description: 'Saudação e fallback de intenção não reconhecida.' },
  };
  const agents = [...agentsSeen].map((a) => agentMeta[a] || { id: a, name: a, description: a });

  return { agents, commands };
}

module.exports = { buildCatalog, exampleToUtterances, extractKeywords };
