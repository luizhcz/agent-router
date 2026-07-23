/**
 * Dataset de avaliação rotulado — a régua do roteador.
 *
 * REGRA CENTRAL: as `query`s aqui são formulações GENUINAMENTE NOVAS, não cópias
 * nem quase-cópias das `utterances` do catálogo. Se fossem paráfrases triviais
 * das utterances, o eval mediria a memorização do índice (overfitting) e
 * reportaria um recall@5 falsamente alto. Cada consulta reformula a intenção com
 * outro vocabulário, outra estrutura de frase e, quando marcado, ruído (typo,
 * preâmbulo, code-switching).
 *
 * Cobertura (48 comandos × 5 exemplos = 240):
 * - `tag`: coloquial, sigla, ambiguo, telegrafico, typo, formal, multi-idioma
 *   (code-switching) e contexto-longo (preâmbulo irrelevante antes do pedido);
 *   30 exemplos por tag.
 * - `lang`: ~70% pt, ~18% en, ~12% es.
 * - Casos deliberadamente DIFÍCEIS entre comandos vizinhos (`confusableWith`):
 *   os exemplos marcados `ambiguo` roçam um vizinho de propósito — é ali que o
 *   recall@5 se decide.
 *
 * `hardNegatives`: ~20 consultas fora de escopo (nenhum comando as atende), para
 * medir a taxa de abstenção CORRETA — o roteador deveria abster-se em todas.
 */
import type { EvalExample } from '../types.js';

export const evalDataset: EvalExample[] = [
  // === risk.calcular_var ===
  { query: "no pior dos casos, quanto esse fundo derrete num pregão ruim?", expected: 'risk.calcular_var', lang: 'pt', tag: 'coloquial' },
  { query: "roda o VaR e o ES da carteira a 99% pra dez dias", expected: 'risk.calcular_var', lang: 'pt', tag: 'sigla' },
  { query: "how much is the equity book likely to lose on a really bad day, in money terms?", expected: 'risk.calcular_var', lang: 'en', tag: 'ambiguo' },
  { query: "perda potencial 1 dia 97,5 consolidado da gestora", expected: 'risk.calcular_var', lang: 'pt', tag: 'telegrafico' },
  { query: "calcula el valor en riesgo de la carteira al 99 porsiento", expected: 'risk.calcular_var', lang: 'es', tag: 'typo' },

  // === risk.stress_test ===
  { query: "Solicito a reprecificação da carteira sob um cenário hipotético de elevação abrupta da curva de juros.", expected: 'risk.stress_test', lang: 'pt', tag: 'formal' },
  { query: "faz um stress test simulando um crash estilo 2008 no nosso book", expected: 'risk.stress_test', lang: 'pt', tag: 'multi-idioma' },
  { query: "The compliance pack is due Friday, but first run a scenario where the Brazilian real collapses 15% and show the portfolio hit.", expected: 'risk.stress_test', lang: 'en', tag: 'contexto-longo' },
  { query: "e se der ruim geral amanhã, tipo tudo caindo junto, quanto que sangra?", expected: 'risk.stress_test', lang: 'pt', tag: 'coloquial' },
  { query: "aplica un shock de 300 pb en la curva DI y mira el impacto", expected: 'risk.stress_test', lang: 'es', tag: 'sigla' },

  // === risk.checar_enquadramento ===
  { query: "esse fundo tá respeitando todos os limites do regulamento agora?", expected: 'risk.checar_enquadramento', lang: 'pt', tag: 'ambiguo' },
  { query: "conformidade mandato pré-trade compra 5% VALE3", expected: 'risk.checar_enquadramento', lang: 'pt', tag: 'telegrafico' },
  { query: "chek if the portfolio is still within its investmnet policy limmits", expected: 'risk.checar_enquadramento', lang: 'en', tag: 'typo' },
  { query: "Verificar a aderência da carteira às vedações da RCVM 175 antes de executar a ordem.", expected: 'risk.checar_enquadramento', lang: 'pt', tag: 'formal' },
  { query: "revisa el enquadramento del fondo contra los limites del mandate", expected: 'risk.checar_enquadramento', lang: 'es', tag: 'multi-idioma' },

  // === risk.exposicao_por_fator ===
  { query: "acabei de voltar de férias e tô me atualizando; me quebra a carteira mostrando de onde vem o risco por setor e por moeda", expected: 'risk.exposicao_por_fator', lang: 'pt', tag: 'contexto-longo' },
  { query: "de onde tá vindo o tombo? quero ver o risco aberto por fator", expected: 'risk.exposicao_por_fator', lang: 'pt', tag: 'coloquial' },
  { query: "show gross and net exposure plus the aggregate beta vs IBOV", expected: 'risk.exposicao_por_fator', lang: 'en', tag: 'sigla' },
  { query: "quanto do meu risco tá alocado em papel de tecnologia?", expected: 'risk.exposicao_por_fator', lang: 'pt', tag: 'ambiguo' },
  { query: "exposición neta por país y por sector", expected: 'risk.exposicao_por_fator', lang: 'es', tag: 'telegrafico' },

  // === risk.tracking_error ===
  { query: "qual o traking error do fundo contra o CDI nos ultimos 12 mezes", expected: 'risk.tracking_error', lang: 'pt', tag: 'typo' },
  { query: "Apresentar o risco ativo anualizado da carteira frente ao índice de referência, com o respectivo information ratio.", expected: 'risk.tracking_error', lang: 'pt', tag: 'formal' },
  { query: "what's the tracking error contra o Ibovespa this quarter?", expected: 'risk.tracking_error', lang: 'en', tag: 'multi-idioma' },
  { query: "o cotista mandou um e-mail reclamando de performance; antes de eu responder, me diz o quanto o fundo tá descolando do índice de referência", expected: 'risk.tracking_error', lang: 'pt', tag: 'contexto-longo' },
  { query: "¿cuánto nos estamos despegando del índice este año?", expected: 'risk.tracking_error', lang: 'es', tag: 'coloquial' },

  // === risk.concentracao ===
  { query: "calcula o HHI da carteira e o peso das cinco maiores no PL", expected: 'risk.concentracao', lang: 'pt', tag: 'sigla' },
  { query: "a gente depende demais de poucos nomes na carteira?", expected: 'risk.concentracao', lang: 'pt', tag: 'ambiguo' },
  { query: "top 10 holdings share of NAV", expected: 'risk.concentracao', lang: 'en', tag: 'telegrafico' },
  { query: "risco de concentraçao por emissor, tem alguem acima de 10 porcento do patrimonio?", expected: 'risk.concentracao', lang: 'pt', tag: 'typo' },
  { query: "Solicito el índice de Herfindahl de la cartera y el peso del mayor emisor.", expected: 'risk.concentracao', lang: 'es', tag: 'formal' },

  // === risk.liquidez_carteira ===
  { query: "em quantos dias eu consigo dar unwind nessa posição sem estourar 20% do ADTV?", expected: 'risk.liquidez_carteira', lang: 'pt', tag: 'multi-idioma' },
  { query: "tô montando o material pro comitê de risco da semana que vem; preciso saber que fração do book dá pra liquidar em até cinco dias", expected: 'risk.liquidez_carteira', lang: 'pt', tag: 'contexto-longo' },
  { query: "if everyone asks for their money back this week, can we pay them all out?", expected: 'risk.liquidez_carteira', lang: 'en', tag: 'coloquial' },
  { query: "dias pra zerar PETR4 a 20% do ADTV", expected: 'risk.liquidez_carteira', lang: 'pt', tag: 'sigla' },
  { query: "¿en cuánto tiempo puedo salir de toda la cartera si hay rescates fuertes?", expected: 'risk.liquidez_carteira', lang: 'es', tag: 'ambiguo' },

  // === risk.margem_garantias ===
  { query: "o gerente da corretora ligou agora de manhã; antes de eu responder, me fala quanto de garantia a câmara tá exigindo hoje nos meus derivativos", expected: 'risk.margem_garantias', lang: 'pt', tag: 'contexto-longo' },
  { query: "tenho que depositar mais grana de garantia hoje ou tá tranquilo?", expected: 'risk.margem_garantias', lang: 'pt', tag: 'coloquial' },
  { query: "what's the CORE margin requirement at B3 for the futures book?", expected: 'risk.margem_garantias', lang: 'en', tag: 'sigla' },
  { query: "sobra caixa livre depois que a B3 trava a margem?", expected: 'risk.margem_garantias', lang: 'pt', tag: 'ambiguo' },
  { query: "¿cuánto colateral tengo que reponer hoy en la cámara?", expected: 'risk.margem_garantias', lang: 'es', tag: 'telegrafico' },

  // === risk.sensibilidade_taxa ===
  { query: "se a curva mexer um pontinho base, quanto o book de juros balança?", expected: 'risk.sensibilidade_taxa', lang: 'pt', tag: 'coloquial' },
  { query: "me dá o DV01 por vértice e a duration modificada da carteira de crédito", expected: 'risk.sensibilidade_taxa', lang: 'pt', tag: 'sigla' },
  { query: "how much do I lose if rates move up exactly one basis point?", expected: 'risk.sensibilidade_taxa', lang: 'en', tag: 'ambiguo' },
  { query: "gregas das opções, delta e vega, book todo", expected: 'risk.sensibilidade_taxa', lang: 'pt', tag: 'telegrafico' },
  { query: "cual es la duracion modificada de la carteira de bonos", expected: 'risk.sensibilidade_taxa', lang: 'es', tag: 'typo' },

  // === risk.backtest_var ===
  { query: "Solicito a validação retrospectiva do modelo de VaR, com a contagem de exceções e o teste de aderência de Kupiec.", expected: 'risk.backtest_var', lang: 'pt', tag: 'formal' },
  { query: "roda o backtesting do VaR e me diz how many exceptions a gente teve no ano", expected: 'risk.backtest_var', lang: 'pt', tag: 'multi-idioma' },
  { query: "The regulator's inspection is next month; for the model validation appendix, count how many times realized losses exceeded the VaR over the past 250 days.", expected: 'risk.backtest_var', lang: 'en', tag: 'contexto-longo' },
  { query: "o modelo de risco tá furando muito ou tá ok? conta quantas vezes estourou", expected: 'risk.backtest_var', lang: 'pt', tag: 'coloquial' },
  { query: "backtesting del VaR a 250d con el test de Christoffersen", expected: 'risk.backtest_var', lang: 'es', tag: 'sigla' },

  // === risk.risco_contraparte ===
  { query: "qual o meu tamanho de exposição na XP e qual o rating de crédito deles?", expected: 'risk.risco_contraparte', lang: 'pt', tag: 'ambiguo' },
  { query: "PD e CVA do book de swaps de balcão", expected: 'risk.risco_contraparte', lang: 'pt', tag: 'telegrafico' },
  { query: "any issuer downgraded this month? show credti spread by issuer", expected: 'risk.risco_contraparte', lang: 'en', tag: 'typo' },
  { query: "Solicito a análise da qualidade creditícia das contrapartes, incluindo probabilidade de inadimplência e ajuste de valor de crédito.", expected: 'risk.risco_contraparte', lang: 'pt', tag: 'formal' },
  { query: "muéstrame el counterparty risk de los swaps y el rating de cada emisor", expected: 'risk.risco_contraparte', lang: 'es', tag: 'multi-idioma' },

  // === risk.alertas_limite ===
  { query: "cheguei atrasado hoje e quero saber o que rolou de manhã; lista os alertas de risco que dispararam e os limites que estouraram", expected: 'risk.alertas_limite', lang: 'pt', tag: 'contexto-longo' },
  { query: "estourou algum limite por aí? me mostra o que tá pegando fogo", expected: 'risk.alertas_limite', lang: 'pt', tag: 'coloquial' },
  { query: "list open breaches filtered by the VaR limit, last 7d", expected: 'risk.alertas_limite', lang: 'en', tag: 'sigla' },
  { query: "quais desenquadramentos ainda estão em aberto pra tratar?", expected: 'risk.alertas_limite', lang: 'pt', tag: 'ambiguo' },
  { query: "alertas de riesgo abiertos severidad alta", expected: 'risk.alertas_limite', lang: 'es', tag: 'telegrafico' },

  // === trader.enviar_ordem ===
  { query: "boletar compra de 3 mil ITUB4 a mercado agra", expected: 'trader.enviar_ordem', lang: 'pt', tag: 'typo' },
  { query: "Favor registrar uma ordem limitada de venda de 1.000 ações de MGLU3 ao preço de 9,90.", expected: 'trader.enviar_ordem', lang: 'pt', tag: 'formal' },
  { query: "place a limit buy de 500 VALE3 at 61 e meio", expected: 'trader.enviar_ordem', lang: 'en', tag: 'multi-idioma' },
  { query: "acabei de falar com o gestor e ele aprovou; manda uma compra de 200 contratos de WINFUT a mercado agora", expected: 'trader.enviar_ordem', lang: 'pt', tag: 'contexto-longo' },
  { query: "méteme una compra a mercado de 100 dólar futuro, dale", expected: 'trader.enviar_ordem', lang: 'es', tag: 'coloquial' },

  // === trader.cancelar_alterar_ordem ===
  { query: "manda um replace na ordem 77120, novo preço 9,70, FIX 35=G", expected: 'trader.cancelar_alterar_ordem', lang: 'pt', tag: 'sigla' },
  { query: "tira aquela minha oferta de compra de PETR4 do livro, não quero mais ela lá", expected: 'trader.cancelar_alterar_ordem', lang: 'pt', tag: 'ambiguo' },
  { query: "kill every open order I've got, immediately", expected: 'trader.cancelar_alterar_ordem', lang: 'en', tag: 'telegrafico' },
  { query: "muda o preso da ordem de VALE3 pra 61,50 e aumenta a quantidad tambem", expected: 'trader.cancelar_alterar_ordem', lang: 'pt', tag: 'typo' },
  { query: "Solicito a modificação da quantidade da minha ordem pendente para 2.000 unidades.", expected: 'trader.cancelar_alterar_ordem', lang: 'es', tag: 'formal' },

  // === trader.consultar_book ===
  { query: "abre o DOM do WDOFUT e me mostra a depth nas duas pontas", expected: 'trader.consultar_book', lang: 'pt', tag: 'multi-idioma' },
  { query: "antes de eu mandar um bloco grande, quero ver o livro de ofertas de VALE3 com uns dez níveis pra cada lado", expected: 'trader.consultar_book', lang: 'pt', tag: 'contexto-longo' },
  { query: "how thick is the book on the mini index right now?", expected: 'trader.consultar_book', lang: 'en', tag: 'coloquial' },
  { query: "spread bid-ask e nível 2 de MGLU3", expected: 'trader.consultar_book', lang: 'pt', tag: 'sigla' },
  { query: "¿cuánta profundidad hay en PETR4 ahora mismo?", expected: 'trader.consultar_book', lang: 'es', tag: 'ambiguo' },

  // === trader.posicao_pnl_dia ===
  { query: "o chefe vai passar aqui daqui a pouco perguntar do resultado; me diz rápido quanto a mesa tá ganhando ou perdendo hoje e a posição líquida", expected: 'trader.posicao_pnl_dia', lang: 'pt', tag: 'contexto-longo' },
  { query: "tô no lucro ou no prejuízo até agora hoje?", expected: 'trader.posicao_pnl_dia', lang: 'pt', tag: 'coloquial' },
  { query: "give me today's MtM P&L, open and realized split", expected: 'trader.posicao_pnl_dia', lang: 'en', tag: 'sigla' },
  { query: "como tá meu resultado do dia em dólar futuro?", expected: 'trader.posicao_pnl_dia', lang: 'pt', tag: 'ambiguo' },
  { query: "posición neta actual y PnL del día", expected: 'trader.posicao_pnl_dia', lang: 'es', tag: 'telegrafico' },

  // === trader.custo_execucao ===
  { query: "paguei caro pra executar aquele bloco de PETR4? quanto foi de slippage no fim?", expected: 'trader.custo_execucao', lang: 'pt', tag: 'coloquial' },
  { query: "roda o TCA da execução de ontem contra o VWAP", expected: 'trader.custo_execucao', lang: 'pt', tag: 'sigla' },
  { query: "how did my average fill price compare to the market benchmark yesterday?", expected: 'trader.custo_execucao', lang: 'en', tag: 'ambiguo' },
  { query: "desvio contra o arrival price no bloco de ontem", expected: 'trader.custo_execucao', lang: 'pt', tag: 'telegrafico' },
  { query: "cuanto me costo de mas ejecutar ese bloke ayer, en corretaje y emolumento?", expected: 'trader.custo_execucao', lang: 'es', tag: 'typo' },

  // === trader.rolar_futuro ===
  { query: "Solicito a rolagem da posição em WINFUT para o vencimento subsequente, executada de forma casada.", expected: 'trader.rolar_futuro', lang: 'pt', tag: 'formal' },
  { query: "rola meu DOL pro next expiry e me diz o calendar spread", expected: 'trader.rolar_futuro', lang: 'pt', tag: 'multi-idioma' },
  { query: "My contract expires this Friday and I don't want to get delivered — move all 300 DI positions to the next maturity.", expected: 'trader.rolar_futuro', lang: 'en', tag: 'contexto-longo' },
  { query: "meu contrato de índice tá vencendo, joga pra frente aí", expected: 'trader.rolar_futuro', lang: 'pt', tag: 'coloquial' },
  { query: "rueda el WDOQ26 al WDOU26", expected: 'trader.rolar_futuro', lang: 'es', tag: 'sigla' },

  // === trader.zerar_posicao ===
  { query: "me tira da comprada em VALE3, tô querendo sair dela", expected: 'trader.zerar_posicao', lang: 'pt', tag: 'ambiguo' },
  { query: "encerra todas as posições antes do gongo", expected: 'trader.zerar_posicao', lang: 'pt', tag: 'telegrafico' },
  { query: "cut haf of my mini index expsure right now", expected: 'trader.zerar_posicao', lang: 'en', tag: 'typo' },
  { query: "Solicito o encerramento de 50% da posição em dólar futuro, com execução passiva ao longo do dia.", expected: 'trader.zerar_posicao', lang: 'pt', tag: 'formal' },
  { query: "cierra mi posición larga en ITUB4, hazlo close out ya", expected: 'trader.zerar_posicao', lang: 'es', tag: 'multi-idioma' },

  // === trader.historico_fills ===
  { query: "a auditoria pediu comprovação dos negócios; me lista todas as execuções que saíram em VALE3 hoje de manhã, com horário e preço de cada uma", expected: 'trader.historico_fills', lang: 'pt', tag: 'contexto-longo' },
  { query: "me diz o horário exato em que a boleta gorda de ITUB4 foi preenchida", expected: 'trader.historico_fills', lang: 'pt', tag: 'coloquial' },
  { query: "give me the fills log for account 12345 across the past week", expected: 'trader.historico_fills', lang: 'en', tag: 'sigla' },
  { query: "quantos parciais teve na minha ordem de PETR4 ontem?", expected: 'trader.historico_fills', lang: 'pt', tag: 'ambiguo' },
  { query: "historial de ejecuciones de la semana pasada en VALE3", expected: 'trader.historico_fills', lang: 'es', tag: 'telegrafico' },

  // === trader.cotacao_ultimo_preco ===
  { query: "quanto tá cotando a PETRO4 agr? subiu ou caiu no dia", expected: 'trader.cotacao_ultimo_preco', lang: 'pt', tag: 'typo' },
  { query: "Solicito a última cotação, a máxima e a mínima do índice Ibovespa no pregão de hoje.", expected: 'trader.cotacao_ultimo_preco', lang: 'pt', tag: 'formal' },
  { query: "what's the last price de VALE3 e a variação hoje?", expected: 'trader.cotacao_ultimo_preco', lang: 'en', tag: 'multi-idioma' },
  { query: "tô no meio de uma reunião e alguém aqui perguntou; rapidão, quanto tá o dólar futuro agora?", expected: 'trader.cotacao_ultimo_preco', lang: 'pt', tag: 'contexto-longo' },
  { query: "¿a cuánto está el mini índice ahorita?", expected: 'trader.cotacao_ultimo_preco', lang: 'es', tag: 'coloquial' },

  // === trader.aluguel_ativos ===
  { query: "quanto tá saindo o aluguel de MGLU3 pra quem toma no BTC hoje?", expected: 'trader.aluguel_ativos', lang: 'pt', tag: 'sigla' },
  { query: "preciso de papel de VALE3 emprestado pra shortear amanhã, tem disponível?", expected: 'trader.aluguel_ativos', lang: 'pt', tag: 'ambiguo' },
  { query: "borrow inventory and rate for MGLU3, taker side", expected: 'trader.aluguel_ativos', lang: 'en', tag: 'telegrafico' },
  { query: "tem papel de VALE3 pra alugar? qual a taxa tomadera hoje", expected: 'trader.aluguel_ativos', lang: 'pt', tag: 'typo' },
  { query: "Solicito la disponibilidad y la tasa de préstamo de acciones de PETR4 como tomador.", expected: 'trader.aluguel_ativos', lang: 'es', tag: 'formal' },

  // === trader.simular_ordem ===
  { query: "faz um dry run da compra de 1 milhão de PETR4 antes de eu boletar", expected: 'trader.simular_ordem', lang: 'pt', tag: 'multi-idioma' },
  { query: "não manda nada ainda, é só teste; se eu vender 500 WIN, qual seria o impacto no preço e quanto de margem trava?", expected: 'trader.simular_ordem', lang: 'pt', tag: 'contexto-longo' },
  { query: "what would happen to the price if I dumped 2 thousand dollar futures? just checking, don't send it", expected: 'trader.simular_ordem', lang: 'en', tag: 'coloquial' },
  { query: "simula o impacto de 2 mil dólar futuro numa saída VWAP, só pra ver", expected: 'trader.simular_ordem', lang: 'pt', tag: 'sigla' },
  { query: "simula la compra de 500 VALE3 y dime el precio medio estimado", expected: 'trader.simular_ordem', lang: 'es', tag: 'ambiguo' },

  // === trader.status_roteamento ===
  { query: "faltam dez minutos pra abertura e tô nervoso; confere pra mim se o gateway de ordens e as sessões estão saudáveis", expected: 'trader.status_roteamento', lang: 'pt', tag: 'contexto-longo' },
  { query: "minhas ordens não tão indo pra bolsa, será que caiu a conexão?", expected: 'trader.status_roteamento', lang: 'pt', tag: 'coloquial' },
  { query: "is the FIX session up? check the DMA latency to B3", expected: 'trader.status_roteamento', lang: 'en', tag: 'sigla' },
  { query: "por que as ordens não estão chegando no mercado agora?", expected: 'trader.status_roteamento', lang: 'pt', tag: 'ambiguo' },
  { query: "estado del enrutamiento de órdenes al exterior", expected: 'trader.status_roteamento', lang: 'es', tag: 'telegrafico' },

  // === content.redigir_relatorio ===
  { query: "senta e escreve um relatório completo de PETR4, com recomendação e pra onde você acha que o papel vai", expected: 'content.redigir_relatorio', lang: 'pt', tag: 'coloquial' },
  { query: "monta um initiation de RENT3 com valuation por DCF e preço-alvo", expected: 'content.redigir_relatorio', lang: 'pt', tag: 'sigla' },
  { query: "write me the full research piece on the banking sector with a rating and target price", expected: 'content.redigir_relatorio', lang: 'en', tag: 'ambiguo' },
  { query: "tese de investimento da Suzano, dez páginas, com upside e riscos", expected: 'content.redigir_relatorio', lang: 'pt', tag: 'telegrafico' },
  { query: "escrebe un report completo de Cemex con recomendacion y valuacion por flujo de caja", expected: 'content.redigir_relatorio', lang: 'es', tag: 'typo' },

  // === content.resumir_call_resultados ===
  { query: "Solicito uma síntese da teleconferência de resultados do terceiro trimestre, com destaque para o guidance apresentado pela administração.", expected: 'content.resumir_call_resultados', lang: 'pt', tag: 'formal' },
  { query: "me dá um TL;DR da earnings call do Itaú, principalmente o Q&A com os analistas", expected: 'content.resumir_call_resultados', lang: 'pt', tag: 'multi-idioma' },
  { query: "I missed the webcast because of another meeting — can you condense Petrobras's Q3 results call, focused on what management said about capex guidance?", expected: 'content.resumir_call_resultados', lang: 'en', tag: 'contexto-longo' },
  { query: "o que o CFO da Ambev falou de importante na call de ontem? resume aí", expected: 'content.resumir_call_resultados', lang: 'pt', tag: 'coloquial' },
  { query: "resume la earnings call del 2T de Vale, con foco en guidance y en el Q&A", expected: 'content.resumir_call_resultados', lang: 'es', tag: 'sigla' },

  // === content.gerar_post_social ===
  { query: "pega esse parágrafo do report e vira um conteúdo pro nosso LinkedIn", expected: 'content.gerar_post_social', lang: 'pt', tag: 'ambiguo' },
  { query: "linkedin post, dollar spike, keep it punchy", expected: 'content.gerar_post_social', lang: 'en', tag: 'telegrafico' },
  { query: "faz um carrosel de instagram com cinco slaids sobre renda fixa", expected: 'content.gerar_post_social', lang: 'pt', tag: 'typo' },
  { query: "Solicito a elaboração de uma publicação para o LinkedIn abordando a decisão do Copom sobre a taxa Selic.", expected: 'content.gerar_post_social', lang: 'pt', tag: 'formal' },
  { query: "escreve uma thread no X explicando o corte da Selic, tom bem didático, e joga umas hashtags no final", expected: 'content.gerar_post_social', lang: 'pt', tag: 'multi-idioma' },

  // === content.montar_newsletter ===
  { query: "a base de assinantes tá crescendo e o chefe quer caprichar; monta a edição semanal da newsletter com os três relatórios que saíram e um bloco de macro", expected: 'content.montar_newsletter', lang: 'pt', tag: 'contexto-longo' },
  { query: "put together this week's investor email with the usual sections", expected: 'content.montar_newsletter', lang: 'en', tag: 'coloquial' },
  { query: "fecha a edição 143 do daily até as 18h", expected: 'content.montar_newsletter', lang: 'pt', tag: 'sigla' },
  { query: "pega esses três reports e transforma num e-mail pra mandar pros clientes private", expected: 'content.montar_newsletter', lang: 'pt', tag: 'ambiguo' },
  { query: "fecha o boletim quinzenal dos assinantes private", expected: 'content.montar_newsletter', lang: 'pt', tag: 'telegrafico' },

  // === content.revisar_compliance ===
  { query: "passa esse relatorio no complaince antes de publicar, será que falta disclamer?", expected: 'content.revisar_compliance', lang: 'pt', tag: 'typo' },
  { query: "Please review this piece for regulatory compliance and insert the mandatory disclaimers before publication.", expected: 'content.revisar_compliance', lang: 'en', tag: 'formal' },
  { query: "esse post promete rentabilidade, será que tá irregular pela CVM? dá um check de compliance nele", expected: 'content.revisar_compliance', lang: 'pt', tag: 'multi-idioma' },
  { query: "o jurídico é chato pra caramba com isso; antes de eu soltar, revisa se o texto tá aderente à RCVM 20 e coloca as ressalvas de praxe", expected: 'content.revisar_compliance', lang: 'pt', tag: 'contexto-longo' },
  { query: "esse texto aqui tá liberado pra sair ou o compliance vai barrar?", expected: 'content.revisar_compliance', lang: 'pt', tag: 'coloquial' },

  // === content.traduzir_conteudo ===
  { query: "verte esse report pra en-US mantendo os tickers e o selo CNPI", expected: 'content.traduzir_conteudo', lang: 'pt', tag: 'sigla' },
  { query: "I need this weekly letter in Spanish, keep the financial jargon intact", expected: 'content.traduzir_conteudo', lang: 'en', tag: 'ambiguo' },
  { query: "versão em inglês da newsletter, com os termos técnicos intactos", expected: 'content.traduzir_conteudo', lang: 'pt', tag: 'telegrafico' },
  { query: "traduz esse materal pro espanhol pro investidor estranjeiro", expected: 'content.traduzir_conteudo', lang: 'pt', tag: 'typo' },
  { query: "Solicito a tradução do relatório para o inglês, preservando os termos técnicos e os tickers no idioma original.", expected: 'content.traduzir_conteudo', lang: 'pt', tag: 'formal' },

  // === content.gerar_roteiro_audiovisual ===
  { query: "estrutura o episódio de podcast dessa semana em segments, com os timestamps certinhos", expected: 'content.gerar_roteiro_audiovisual', lang: 'pt', tag: 'multi-idioma' },
  { query: "The analyst is filming tomorrow morning and needs the teleprompter text — write a ten-minute video script on the rate decision, with segment cues.", expected: 'content.gerar_roteiro_audiovisual', lang: 'en', tag: 'contexto-longo' },
  { query: "monta a pauta e o roteiro da live de abertura de mercado, com deixa pro gráfico entrar na tela", expected: 'content.gerar_roteiro_audiovisual', lang: 'pt', tag: 'coloquial' },
  { query: "roteiro pro Shorts, 60s, tema IPO", expected: 'content.gerar_roteiro_audiovisual', lang: 'pt', tag: 'sigla' },
  { query: "quero o texto corrido que o âncora vai narrar na gravação de amanhã cedo", expected: 'content.gerar_roteiro_audiovisual', lang: 'pt', tag: 'ambiguo' },

  // === content.extrair_destaques ===
  { query: "recebi um anexo gigante do banco coordenador; garimpa esse prospecto de 300 páginas e me devolve os pontos que importam, com a página de cada um", expected: 'content.extrair_destaques', lang: 'pt', tag: 'contexto-longo' },
  { query: "this filing is enormous — just surface the bits that actually move the needle", expected: 'content.extrair_destaques', lang: 'en', tag: 'coloquial' },
  { query: "puxa os highlights desse PDF, com as páginas de origem", expected: 'content.extrair_destaques', lang: 'pt', tag: 'sigla' },
  { query: "nesse relatório anual de 200 páginas, marca só os pontos críticos que eu não posso deixar passar", expected: 'content.extrair_destaques', lang: 'pt', tag: 'ambiguo' },
  { query: "quais riscos esse anexo aponta, me devolve em tópicos", expected: 'content.extrair_destaques', lang: 'pt', tag: 'telegrafico' },

  // === content.criar_titulo_chamada ===
  { query: "essa manchete tá fraquinha, dá um trato e me manda umas opções melhores", expected: 'content.criar_titulo_chamada', lang: 'pt', tag: 'coloquial' },
  { query: "give me five headline options for this piece, under 60 chars, no clickbait, good CTR", expected: 'content.criar_titulo_chamada', lang: 'en', tag: 'sigla' },
  { query: "qual assunto de e-mail faria mais gente abrir essa newsletter?", expected: 'content.criar_titulo_chamada', lang: 'pt', tag: 'ambiguo' },
  { query: "cinco títulos alternativos pro relatório, sem clickbait", expected: 'content.criar_titulo_chamada', lang: 'pt', tag: 'telegrafico' },
  { query: "bola uma linha fina que fisge o leitor sem entregar o miolo da matéra", expected: 'content.criar_titulo_chamada', lang: 'pt', tag: 'typo' },

  // === content.agendar_publicacao ===
  { query: "Solicito o agendamento da publicação desta peça no LinkedIn para terça-feira às 9 horas.", expected: 'content.agendar_publicacao', lang: 'pt', tag: 'formal' },
  { query: "schedule esse post pro site, mas deixa como draft até o compliance liberar", expected: 'content.agendar_publicacao', lang: 'en', tag: 'multi-idioma' },
  { query: "o compliance ainda não liberou, então não publica agora; só joga esse vídeo na fila do calendário editorial, pra depois do fechamento do pregão", expected: 'content.agendar_publicacao', lang: 'pt', tag: 'contexto-longo' },
  { query: "despublica aquela matéria da semana passada, o cliente reclamou dela", expected: 'content.agendar_publicacao', lang: 'pt', tag: 'coloquial' },
  { query: "sobe pro CMS como rascunho e programa o disparo pra quinta às 7h", expected: 'content.agendar_publicacao', lang: 'pt', tag: 'sigla' },

  // === content.buscar_acervo ===
  { query: "a gente já publicou alguma coisa sobre o setor elétrico esse ano? acha aí no que já saiu", expected: 'content.buscar_acervo', lang: 'pt', tag: 'ambiguo' },
  { query: "search the archive for everything on Petrobras, last 12 months", expected: 'content.buscar_acervo', lang: 'en', tag: 'telegrafico' },
  { query: "acha aquele relatorio antigo do IPO da Raizen que a gente publicou", expected: 'content.buscar_acervo', lang: 'pt', tag: 'typo' },
  { query: "Solicito o levantamento de todo o conteúdo já publicado sobre debêntures incentivadas desde janeiro.", expected: 'content.buscar_acervo', lang: 'pt', tag: 'formal' },
  { query: "faz um quick search no acervo e me acha aquele post viral de renda fixa", expected: 'content.buscar_acervo', lang: 'pt', tag: 'multi-idioma' },

  // === content.gerar_visual_apoio ===
  { query: "o relatório tá pronto mas muito seco; gera um gráfico de barras do lucro trimestral pra entrar no meio dele, no nosso template", expected: 'content.gerar_visual_apoio', lang: 'pt', tag: 'contexto-longo' },
  { query: "turn this boring table into a nice visual that fits an Instagram story", expected: 'content.gerar_visual_apoio', lang: 'en', tag: 'coloquial' },
  { query: "gera um gráfico de linha do CDI acumulado no ano na identidade visual da casa", expected: 'content.gerar_visual_apoio', lang: 'pt', tag: 'sigla' },
  { query: "faz um card com os três números principais dessa peça", expected: 'content.gerar_visual_apoio', lang: 'pt', tag: 'ambiguo' },
  { query: "arte de thumbnail pro vídeo em formato 16:9", expected: 'content.gerar_visual_apoio', lang: 'pt', tag: 'telegrafico' },

  // === public-offerings.listar_ofertas_em_andamento ===
  { query: "tem algum IPO na rua agr? me lista as ofertas que estão abertas", expected: 'public-offerings.listar_ofertas_em_andamento', lang: 'pt', tag: 'typo' },
  { query: "Please list all public offerings currently in distribution, filtered by fixed income instruments.", expected: 'public-offerings.listar_ofertas_em_andamento', lang: 'en', tag: 'formal' },
  { query: "quais deals de renda fixa estão em captação neste mês? me mostra o pipeline", expected: 'public-offerings.listar_ofertas_em_andamento', lang: 'pt', tag: 'multi-idioma' },
  { query: "tô montando uma carteira nova pro cliente e quero oportunidades primárias; quais CRI e CRA estão em distribuição agora?", expected: 'public-offerings.listar_ofertas_em_andamento', lang: 'pt', tag: 'contexto-longo' },
  { query: "tá rolando alguma oferta de fundo imobiliário aí?", expected: 'public-offerings.listar_ofertas_em_andamento', lang: 'pt', tag: 'coloquial' },

  // === public-offerings.consultar_cronograma_oferta ===
  { query: "quando cai a liquidação em D+2 e o início de negociação dessa oferta?", expected: 'public-offerings.consultar_cronograma_oferta', lang: 'pt', tag: 'sigla' },
  { query: "when does the reservation window open and close for this deal?", expected: 'public-offerings.consultar_cronograma_oferta', lang: 'en', tag: 'ambiguo' },
  { query: "data do bookbuilding dessa oferta?", expected: 'public-offerings.consultar_cronograma_oferta', lang: 'pt', tag: 'telegrafico' },
  { query: "me passa o cronograma completo do IPO, quando fexa o livro?", expected: 'public-offerings.consultar_cronograma_oferta', lang: 'pt', tag: 'typo' },
  { query: "Solicito o calendário completo da oferta, incluindo as datas de precificação e de liquidação.", expected: 'public-offerings.consultar_cronograma_oferta', lang: 'pt', tag: 'formal' },

  // === public-offerings.enviar_pedido_reserva ===
  { query: "quero dar minha order de reserva nessa oferta, 500 ações, com price limit de 22", expected: 'public-offerings.enviar_pedido_reserva', lang: 'pt', tag: 'multi-idioma' },
  { query: "I've read the prospectus and I'm in — book me 1000 shares in the IPO at market.", expected: 'public-offerings.enviar_pedido_reserva', lang: 'en', tag: 'contexto-longo' },
  { query: "cara, me põe nessa oferta com uns 30 mil, pode ser?", expected: 'public-offerings.enviar_pedido_reserva', lang: 'pt', tag: 'coloquial' },
  { query: "faz meu pedido de reserva na tranche de varejo lock-up", expected: 'public-offerings.enviar_pedido_reserva', lang: 'pt', tag: 'sigla' },
  { query: "quero participar dessa oferta, dá pra registrar minha ordem de subscrição?", expected: 'public-offerings.enviar_pedido_reserva', lang: 'pt', tag: 'ambiguo' },

  // === public-offerings.consultar_rateio_alocacao ===
  { query: "acompanhei o bookbuilding ontem e teve demanda enorme; quero saber quanto da minha reserva sobrou depois do corte e qual foi o fator de alocação", expected: 'public-offerings.consultar_rateio_alocacao', lang: 'pt', tag: 'contexto-longo' },
  { query: "so how much did I actually get in that offering after the cut?", expected: 'public-offerings.consultar_rateio_alocacao', lang: 'en', tag: 'coloquial' },
  { query: "qual foi o fator de rateio pró-rata da tranche institucional?", expected: 'public-offerings.consultar_rateio_alocacao', lang: 'pt', tag: 'sigla' },
  { query: "teve corte na minha reserva ou levei tudo que pedi?", expected: 'public-offerings.consultar_rateio_alocacao', lang: 'pt', tag: 'ambiguo' },
  { query: "alocação efetiva na minha conta nessa oferta", expected: 'public-offerings.consultar_rateio_alocacao', lang: 'pt', tag: 'telegrafico' },

  // === public-offerings.resumir_prospecto ===
  { query: "lê a lâmina dessa oferta e me fala o que realmente importa, sem enrolação", expected: 'public-offerings.resumir_prospecto', lang: 'pt', tag: 'coloquial' },
  { query: "TL;DR of the offering prospectus, focus on the use of proceeds and the covenants", expected: 'public-offerings.resumir_prospecto', lang: 'en', tag: 'sigla' },
  { query: "me explica os covenants e a remuneração dessa emissão a partir da escritura", expected: 'public-offerings.resumir_prospecto', lang: 'pt', tag: 'ambiguo' },
  { query: "principais fatores de risco do prospecto preliminar", expected: 'public-offerings.resumir_prospecto', lang: 'pt', tag: 'telegrafico' },
  { query: "resume o prospeto definitivo dessa emisão, a parte de destinação dos recursos", expected: 'public-offerings.resumir_prospecto', lang: 'pt', tag: 'typo' },

  // === public-offerings.consultar_condicoes_oferta ===
  { query: "Solicito as condições comerciais da oferta: faixa indicativa de preço, lote mínimo e público-alvo.", expected: 'public-offerings.consultar_condicoes_oferta', lang: 'pt', tag: 'formal' },
  { query: "what's the price range and o lote mínimo pra entrar nesse deal?", expected: 'public-offerings.consultar_condicoes_oferta', lang: 'en', tag: 'multi-idioma' },
  { query: "meu cliente é pessoa física e tem pouco pra investir; essa debênture paga quanto, qual a taxa, o prazo e o ticket mínimo?", expected: 'public-offerings.consultar_condicoes_oferta', lang: 'pt', tag: 'contexto-longo' },
  { query: "quem pode entrar nessa oferta? é só pra investidor qualificado ou pessoa física também?", expected: 'public-offerings.consultar_condicoes_oferta', lang: 'pt', tag: 'coloquial' },
  { query: "esse papel se enquadra na Lei 12.431 e fica livre de IR pra pessoa física?", expected: 'public-offerings.consultar_condicoes_oferta', lang: 'pt', tag: 'sigla' },

  // === public-offerings.consultar_status_registro_cvm ===
  { query: "essa emissão já foi liberada pelo regulador ou ainda tá parada na autarquia?", expected: 'public-offerings.consultar_status_registro_cvm', lang: 'pt', tag: 'ambiguo' },
  { query: "registration status of this deal, any comment letters pending?", expected: 'public-offerings.consultar_status_registro_cvm', lang: 'en', tag: 'telegrafico' },
  { query: "em que etapa tá o pedido de registro dessa emisão na comissão? ja deferiram?", expected: 'public-offerings.consultar_status_registro_cvm', lang: 'pt', tag: 'typo' },
  { query: "Solicito informação sobre a fase do pedido de registro da oferta perante a CVM e a existência de ofícios de exigências.", expected: 'public-offerings.consultar_status_registro_cvm', lang: 'pt', tag: 'formal' },
  { query: "quando protocolaram o registration da oferta na CVM? já saiu comment letter?", expected: 'public-offerings.consultar_status_registro_cvm', lang: 'pt', tag: 'multi-idioma' },

  // === public-offerings.comparar_oferta_com_pares ===
  { query: "o cliente desconfia que a oferta tá cara; monta um comps table dessa emissão contra os pares já listados do mesmo segmento pra eu mostrar pra ele", expected: 'public-offerings.comparar_oferta_com_pares', lang: 'pt', tag: 'contexto-longo' },
  { query: "is this IPO priced expensive compared to the peers already trading?", expected: 'public-offerings.comparar_oferta_com_pares', lang: 'en', tag: 'coloquial' },
  { query: "compara o EV/EBITDA e o P/L da oferta com o resto do setor", expected: 'public-offerings.comparar_oferta_com_pares', lang: 'pt', tag: 'sigla' },
  { query: "essa debênture paga mais ou menos que outras de risco de crédito equivalente?", expected: 'public-offerings.comparar_oferta_com_pares', lang: 'pt', tag: 'ambiguo' },
  { query: "múltiplo da oferta lado a lado com os concorrentes listados", expected: 'public-offerings.comparar_oferta_com_pares', lang: 'pt', tag: 'telegrafico' },

  // === public-offerings.consultar_performance_ofertas_recentes ===
  { query: "como performaram os IPOs dos ultimos 12 mezes depois de listar?", expected: 'public-offerings.consultar_performance_ofertas_recentes', lang: 'pt', tag: 'typo' },
  { query: "Solicito o histórico de retorno pós-listagem das ofertas encerradas no último ano, medido contra o preço de emissão.", expected: 'public-offerings.consultar_performance_ofertas_recentes', lang: 'pt', tag: 'formal' },
  { query: "teve first-day pop nas últimas ofertas? quero ver o aftermarket performance delas", expected: 'public-offerings.consultar_performance_ofertas_recentes', lang: 'pt', tag: 'multi-idioma' },
  { query: "estoy armando una presentación sobre el mercado primario; dime cómo rindieron las salidas a bolsa recientes en su primer día de negociación", expected: 'public-offerings.consultar_performance_ofertas_recentes', lang: 'es', tag: 'contexto-longo' },
  { query: "quem entrou nas ofertas do ano passado ganhou ou perdeu dinheiro?", expected: 'public-offerings.consultar_performance_ofertas_recentes', lang: 'pt', tag: 'coloquial' },

  // === public-offerings.consultar_restricoes_lockup ===
  { query: "por quanto tempo fico impedido de vender se entrei no varejo lock-up do IPO?", expected: 'public-offerings.consultar_restricoes_lockup', lang: 'pt', tag: 'sigla' },
  { query: "posso divulgar material sobre essa oferta agora ou tá no período de silêncio?", expected: 'public-offerings.consultar_restricoes_lockup', lang: 'pt', tag: 'ambiguo' },
  { query: "o que é vedado fazer enquanto a oferta ainda está sendo colocada?", expected: 'public-offerings.consultar_restricoes_lockup', lang: 'pt', tag: 'telegrafico' },
  { query: "¿hasta cuando dura el lockup para las personas vinculadas?", expected: 'public-offerings.consultar_restricoes_lockup', lang: 'es', tag: 'typo' },
  { query: "Solicito o detalhamento das vedações de negociação aplicáveis às pessoas vinculadas durante o período de distribuição.", expected: 'public-offerings.consultar_restricoes_lockup', lang: 'pt', tag: 'formal' },

  // === public-offerings.obter_documentos_oferta ===
  { query: "me manda o download do final prospectus dessa oferta em PDF", expected: 'public-offerings.obter_documentos_oferta', lang: 'pt', tag: 'multi-idioma' },
  { query: "meu diretor pediu os arquivos oficiais pra due diligence; onde acho o anúncio de início e o contrato de distribuição dessa emissão?", expected: 'public-offerings.obter_documentos_oferta', lang: 'pt', tag: 'contexto-longo' },
  { query: "cadê a lâmina dessa oferta? me passa o link", expected: 'public-offerings.obter_documentos_oferta', lang: 'pt', tag: 'coloquial' },
  { query: "mándame el prospecto definitivo y el anuncio de inicio en PDF, con el link de la RAD CVM", expected: 'public-offerings.obter_documentos_oferta', lang: 'es', tag: 'sigla' },
  { query: "consegue baixar pra mim o contrato de distribuição assinado dessa emissão?", expected: 'public-offerings.obter_documentos_oferta', lang: 'pt', tag: 'ambiguo' },

  // === public-offerings.configurar_alertas_ofertas ===
  { query: "invisto muito em infra e não quero perder emissão nova; cria um alerta que me avise sempre que sair debênture incentivada de infraestrutura", expected: 'public-offerings.configurar_alertas_ofertas', lang: 'pt', tag: 'contexto-longo' },
  { query: "me avisa toda vez que pintar um IPO de tecnologia, pode ser?", expected: 'public-offerings.configurar_alertas_ofertas', lang: 'pt', tag: 'coloquial' },
  { query: "quero receber um push sempre que abrir emissão nova de CRA no agronegócio", expected: 'public-offerings.configurar_alertas_ofertas', lang: 'pt', tag: 'sigla' },
  { query: "quiero que me notifiquen cuando abra la reserva de un nuevo fondo inmobiliario", expected: 'public-offerings.configurar_alertas_ofertas', lang: 'es', tag: 'ambiguo' },
  { query: "cancela meu monitoramento de novas emissões", expected: 'public-offerings.configurar_alertas_ofertas', lang: 'pt', tag: 'telegrafico' },
];

/**
 * Consultas FORA DE ESCOPO — nenhum comando do catálogo as atende. Servem para
 * medir a taxa de abstenção CORRETA: idealmente o roteador se abstém em todas
 * (melhor cosseno abaixo do piso), sem nunca abster de um pedido in-scope. São
 * mantidas fora de `evalDataset` porque não têm `expected` — não entram no
 * recall, entram só na análise de abstenção.
 */
export const hardNegatives: string[] = [
  "qual a receita de brigadeiro de colher?",
  "que horas são agora em Brasília?",
  "vai chover amanhã em São Paulo?",
  "me conta uma piada, tô entediado",
  "quantos habitantes tem o Brasil?",
  "qual é a capital da Austrália?",
  "how do I bake sourdough bread at home?",
  "what's the meaning of life?",
  "recommend a good sci-fi movie for tonight",
  "how tall is Mount Everest in meters?",
  "¿cómo se hace una tortilla española?",
  "¿quién ganó el mundial de fútbol de 2022?",
  "me ajuda a escolher um presente de aniversário pra minha mãe",
  "qual o melhor tênis pra corrida de rua?",
  "what's a good recipe for vegetarian lasagna?",
  "recomenda uma música boa pra relaxar depois do trabalho",
  "como faço pra trocar o pneu furado do carro?",
  "tell me a bedtime story about friendly dragons",
  "¿cuál es la mejor playa de México para vacacionar?",
  "quanto é 47 vezes 89?",
];
