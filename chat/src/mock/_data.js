// MOCK — stand-in para dataset de demo compartilhado (etapa 1)
//
// Fonte da verdade única que alimenta todos os serviços mock do projeto `chat`.
// Consistência garantida: todo símbolo em `positions` tem security + quote +
// fundamentals; todo setor de troca existe em getSecuritiesSectors; todo alvo
// de compra tem security + fundamentals.

'use strict'

// ---------------------------------------------------------------------------
// Conta digital + sessões
// ---------------------------------------------------------------------------

const accounts = {
    '123456': {
        account: '123456',
        document: '11144477735',
        clientName: 'João da Mesa',
        institution: 'XYZ CTVM',
        segment: 'DIGITAL',
        suitability: 'AGRESSIVO',
        isProfessional: false,
        isQualified: true,
        address: 'Av. Faria Lima, 1000 - São Paulo/SP',
        assignedDocuments: ['CONTRATO_INTERMEDIACAO', 'TERMO_ALUGUEL'],
    },
}

const sessions = {
    admin: 'tkn-admin-demo-0001',
    digital: {
        '123456': 'tkn-digital-123456',
    },
}

// ---------------------------------------------------------------------------
// Universo de símbolos (securities)
// ---------------------------------------------------------------------------

const securities = {
    PETR4: {
        symbol: 'PETR4',
        description: 'Petrolina Energia SA',
        exchange: 'BOVESPA',
        securityType: 'STOCK',
        lot: 100,
        minPriceIncrement: 0.01,
        priceUnit: 'BRL.2',
        sector: 'Petróleo, Gás e Biocombustíveis',
    },
    VALE3: {
        symbol: 'VALE3',
        description: 'Valametal Mineração SA',
        exchange: 'BOVESPA',
        securityType: 'STOCK',
        lot: 100,
        minPriceIncrement: 0.01,
        priceUnit: 'BRL.2',
        sector: 'Materiais Básicos',
    },
    ITUB4: {
        symbol: 'ITUB4',
        description: 'Banco Itaupava SA',
        exchange: 'BOVESPA',
        securityType: 'STOCK',
        lot: 100,
        minPriceIncrement: 0.01,
        priceUnit: 'BRL.2',
        sector: 'Financeiro',
    },
    BBAS3: {
        symbol: 'BBAS3',
        description: 'Banco Bandeirante SA',
        exchange: 'BOVESPA',
        securityType: 'STOCK',
        lot: 100,
        minPriceIncrement: 0.01,
        priceUnit: 'BRL.2',
        sector: 'Financeiro',
    },
    ABCD11: {
        symbol: 'ABCD11',
        description: 'ABCD Renda Imobiliária FII',
        exchange: 'BOVESPA',
        securityType: 'FUND',
        lot: 1,
        minPriceIncrement: 0.01,
        priceUnit: 'BRL.2',
        sector: 'Fundos Imobiliários',
    },
    BMIN3: {
        symbol: 'BMIN3',
        description: 'Brumag Mineração SA',
        exchange: 'BOVESPA',
        securityType: 'STOCK',
        lot: 100,
        minPriceIncrement: 0.01,
        priceUnit: 'BRL.2',
        sector: 'Materiais Básicos',
    },
}

// ---------------------------------------------------------------------------
// Cotações
// ---------------------------------------------------------------------------

const quotes = {
    PETR4: { symbol: 'PETR4', lastPrice: 38.42, changePercent: 0.0123, bidPrice: 38.40, askPrice: 38.43, priceUnit: 'BRL.2' },
    VALE3: { symbol: 'VALE3', lastPrice: 54.10, changePercent: -0.0085, bidPrice: 54.08, askPrice: 54.12, priceUnit: 'BRL.2' },
    ITUB4: { symbol: 'ITUB4', lastPrice: 33.75, changePercent: 0.0042, bidPrice: 33.74, askPrice: 33.76, priceUnit: 'BRL.2' },
    BBAS3: { symbol: 'BBAS3', lastPrice: 27.30, changePercent: 0.0066, bidPrice: 27.29, askPrice: 27.31, priceUnit: 'BRL.2' },
    ABCD11: { symbol: 'ABCD11', lastPrice: 98.50, changePercent: 0.0010, bidPrice: 98.40, askPrice: 98.60, priceUnit: 'BRL.2' },
    BMIN3: { symbol: 'BMIN3', lastPrice: 12.85, changePercent: 0.0210, bidPrice: 12.84, askPrice: 12.86, priceUnit: 'BRL.2' },
}

// ---------------------------------------------------------------------------
// Fundamentals (união máxima em PETR4; demais coerentes)
// ---------------------------------------------------------------------------

const fundamentals = {
    PETR4: {
        symbol: 'PETR4', hasAnalysis: true,
        marketCapital: 501000000000, enterpriseValue: 560000000000,
        assets: 1050000000000, equity: 390000000000, equityToAssets: 0.3714,
        currentAssets: 230000000000, netCurrentAssets: 60000000000,
        liabilities: 660000000000, currentLiabilities: 170000000000, currentRatio: 1.35,
        grossDebt: 410000000000, grossDebtToEquity: 1.05,
        netDebt: 170000000000, netDebtToEbit: 0.85, netDebtToEbitda: 0.62, netDebtToEquity: 0.44,
        assetTurnover: 0.48, capitalTurnover: 0.62, priceToCapitalTurnover: 1.9,
        netRevenue: 505000000000, ebit: 200000000000, ebitda: 275000000000, netIncome: 124000000000,
        grossMargin: 0.51, ebitMargin: 0.396, ebitdaMargin: 0.545, netMargin: 0.246,
        dividendYield: 0.124, priceToEarnings: 4.1, priceToEarningsToGrowth: 0.9,
        priceToBook: 1.28, priceToAssets: 0.48, priceToEbit: 2.5, priceToEbitda: 1.82,
        priceToSales: 0.99, priceToNetCurrentAsset: 8.35,
        enterpriseValueToEbit: 2.8, enterpriseValueToEbitda: 2.04,
        returnOnInvestedCapital: 0.22, returnOnEquity: 0.318, returnOnAsset: 0.118,
        growthRate: 0.06, earningsPerShare: 9.37, bookValuePerShare: 29.85,
        dividendPerShare: 4.76, salesPerShare: 38.72,
        recommendation: 'COMPRA', targetPrice: 46.00, upside: 0.197,
        earningsDate: '2026-08-05', analysisDate: '2026-07-15',
    },
    VALE3: {
        symbol: 'VALE3', hasAnalysis: true,
        marketCapital: 250000000000, enterpriseValue: 285000000000,
        assets: 620000000000, equity: 300000000000, equityToAssets: 0.4839,
        currentAssets: 140000000000, netCurrentAssets: 45000000000,
        liabilities: 320000000000, currentLiabilities: 95000000000, currentRatio: 1.47,
        grossDebt: 120000000000, grossDebtToEquity: 0.40,
        netDebt: 85000000000, netDebtToEbit: 0.95, netDebtToEbitda: 0.70, netDebtToEquity: 0.28,
        assetTurnover: 0.42, capitalTurnover: 0.55, priceToCapitalTurnover: 1.7,
        netRevenue: 260000000000, ebit: 90000000000, ebitda: 120000000000, netIncome: 62000000000,
        grossMargin: 0.44, ebitMargin: 0.346, ebitdaMargin: 0.462, netMargin: 0.238,
        dividendYield: 0.086, priceToEarnings: 6.2, priceToEarningsToGrowth: 1.3,
        priceToBook: 1.10, priceToAssets: 0.40, priceToEbit: 3.1, priceToEbitda: 2.35,
        priceToSales: 0.96, priceToNetCurrentAsset: 6.10,
        enterpriseValueToEbit: 3.2, enterpriseValueToEbitda: 2.38,
        returnOnInvestedCapital: 0.16, returnOnEquity: 0.207, returnOnAsset: 0.100,
        growthRate: 0.03, earningsPerShare: 8.72, bookValuePerShare: 49.10,
        dividendPerShare: 4.65, salesPerShare: 56.30,
        recommendation: 'NEUTRO', targetPrice: 56.80, upside: 0.05,
        earningsDate: '2026-08-07', analysisDate: '2026-07-14',
    },
    ITUB4: {
        symbol: 'ITUB4', hasAnalysis: true,
        marketCapital: 320000000000, equity: 190000000000,
        netIncome: 39000000000, dividendYield: 0.058,
        priceToEarnings: 8.2, priceToBook: 1.68,
        returnOnEquity: 0.205, returnOnAsset: 0.017,
        earningsPerShare: 4.11, bookValuePerShare: 20.10, dividendPerShare: 1.96,
        recommendation: 'COMPRA', targetPrice: 39.50, upside: 0.17,
        earningsDate: '2026-08-06', analysisDate: '2026-07-15',
    },
    BBAS3: {
        symbol: 'BBAS3', hasAnalysis: true,
        marketCapital: 155000000000, equity: 170000000000,
        netIncome: 35000000000, dividendYield: 0.098,
        priceToEarnings: 4.4, priceToBook: 0.91,
        returnOnEquity: 0.206, returnOnAsset: 0.014,
        earningsPerShare: 6.20, bookValuePerShare: 30.05, dividendPerShare: 2.68,
        recommendation: 'COMPRA', targetPrice: 33.80, upside: 0.238,
        earningsDate: '2026-08-08', analysisDate: '2026-07-15',
    },
    ABCD11: {
        symbol: 'ABCD11', hasAnalysis: true,
        marketCapital: 1800000000, equity: 1750000000,
        dividendYield: 0.112,
        priceToBook: 1.03,
        earningsPerShare: 9.85, bookValuePerShare: 95.60, dividendPerShare: 11.03,
        recommendation: 'COMPRA', targetPrice: 108.00, upside: 0.096,
        earningsDate: '2026-08-01', analysisDate: '2026-07-16',
    },
    BMIN3: {
        symbol: 'BMIN3', hasAnalysis: true,
        marketCapital: 9500000000, equity: 6200000000,
        netIncome: 1400000000, dividendYield: 0.041,
        priceToEarnings: 6.8, priceToBook: 1.53,
        returnOnEquity: 0.226, returnOnAsset: 0.121,
        earningsPerShare: 1.89, bookValuePerShare: 8.40, dividendPerShare: 0.53,
        recommendation: 'COMPRA', targetPrice: 16.45, upside: 0.28,
        earningsDate: '2026-08-04', analysisDate: '2026-07-16',
    },
}

// ---------------------------------------------------------------------------
// Resumos de fundamentos (research)
// ---------------------------------------------------------------------------

const fundamentalsSummary = {
    PETR4: {
        fullSummary: 'Petrolina Energia apresenta geração de caixa robusta, endividamento controlado (net debt/EBITDA 0,9x) e dividend yield atrativo de 12,4%. Recomendação de COMPRA com alvo de R$46,00.',
        generationDate: '2026-07-18T12:00:00Z',
    },
    VALE3: {
        fullSummary: 'Valametal enfrenta pressão de preços no minério e margens em compressão. Cenário NEUTRO com alvo de R$56,80 e upside limitado; recomenda-se avaliar rotação para nomes de maior potencial no setor.',
        generationDate: '2026-07-18T12:00:00Z',
    },
    ITUB4: {
        fullSummary: 'Banco Itaupava mantém rentabilidade elevada (ROE 20,5%) e inadimplência sob controle. Recomendação de COMPRA com alvo de R$39,50.',
        generationDate: '2026-07-18T12:00:00Z',
    },
    BBAS3: {
        fullSummary: 'Banco Bandeirante negocia abaixo do valor patrimonial (P/VP 0,91x) com dividend yield de 9,8%. Recomendação de COMPRA com alvo de R$33,80.',
        generationDate: '2026-07-18T12:00:00Z',
    },
    ABCD11: {
        fullSummary: 'ABCD Renda Imobiliária FII entrega distribuição consistente com dividend yield de 11,2% e portfólio de lajes corporativas bem localizadas. Recomendação de COMPRA.',
        generationDate: '2026-07-18T12:00:00Z',
    },
    BMIN3: {
        fullSummary: 'Brumag Mineração combina baixo custo de produção e alavancagem operacional. Top pick de Materiais Básicos, COMPRA com alvo de R$16,45 e upside de 28%.',
        generationDate: '2026-07-18T12:00:00Z',
    },
}

// ---------------------------------------------------------------------------
// Aluguel (lending) — ABCD11 indisponível (fee null)
// ---------------------------------------------------------------------------

const lendingRates = {
    PETR4: { fee: 0.0215 },
    VALE3: { fee: 0.0180 },
    ITUB4: { fee: 0.0090 },
    BMIN3: { fee: 0.0340 },
    ABCD11: { fee: null },
}

// ---------------------------------------------------------------------------
// Posições da conta 123456
// ---------------------------------------------------------------------------

const positions = {
    '123456': {
        summary: {
            positionCount: 2,
            volume: 35440,
            profit: 1030,
            profitPercent: 0.0299,
            profitD0: -138,
            profitPercentD0: -0.0039,
        },
        financial: {
            balanceD0: 12500.00,
            balanceProjectedD1: 12500.00,
            balanceProjectedD2: 12500.00,
            balanceProjected: 12500.00,
            availableBalance: 11800.00,
            totalFreeze: 700.00,
            totalEquity: 47940.00,
            daytradeAllocatedLimit: 0,
            daytradeAvailableLimit: 50000.00,
            profitDaytrade: 0,
        },
        list: {
            PETR4: {
                account: '123456', symbol: 'PETR4', positionType: 'LONG',
                quantityD0: 500, quantityProjectedD1: 500, quantityProjectedD2: 500,
                totalQuantity: 500, availableQuantity: 500, blockedQuantity: 0,
                volume: 19210, investedVolume: 16050, avgPrice: 32.10,
                investedVolumeAdjusted: 16050, avgPriceAdjusted: 32.10,
                profit: 3160, profitPercent: 0.1969, earningsVolume: 0, yieldOnCost: 0,
                profitD0: 105, profitPercentD0: 0.0123, positionWeight: 0.5420,
            },
            VALE3: {
                account: '123456', symbol: 'VALE3', positionType: 'LONG',
                quantityD0: 300, quantityProjectedD1: 300, quantityProjectedD2: 300,
                totalQuantity: 300, availableQuantity: 300, blockedQuantity: 0,
                volume: 16230, investedVolume: 18360, avgPrice: 61.20,
                investedVolumeAdjusted: 18360, avgPriceAdjusted: 61.20,
                profit: -2130, profitPercent: -0.1160, earningsVolume: 0, yieldOnCost: 0,
                profitD0: -138, profitPercentD0: -0.0085, positionWeight: 0.4580,
            },
        },
    },
}

// ---------------------------------------------------------------------------
// Ordens em aberto (in-memory por conta)
// ---------------------------------------------------------------------------

const orders = {
    '123456': {
        'ORD-1001': {
            orderId: 'ORD-1001', account: '123456', symbol: 'PETR4', side: 'B',
            quantity: 100, quantityMin: 0, quantityDisplay: 0,
            priceType: 'L', priceLimit: 38.00, priceTrigger: null,
            priceTriggerStop: null, priceLimitStop: null,
            expireType: 'DAY', expireTime: null,
            creationTime: '2026-07-21T13:30:00Z', orderStatus: 'OPEN', statusText: 'Aberta',
            requestType: 'N', requestStatus: 'ACCEPTED',
            pendingQuantity: 100, filledQuantity: 0, filledAveragePrice: 0, filledVolume: 0, pendingVolume: 3800,
        },
        'ORD-1002': {
            orderId: 'ORD-1002', account: '123456', symbol: 'VALE3', side: 'S',
            quantity: 300, quantityMin: 0, quantityDisplay: 0,
            priceType: 'L', priceLimit: 51.50, priceTrigger: 52.00,
            priceTriggerStop: 52.00, priceLimitStop: 51.50,
            expireType: 'GTC', expireTime: '2026-07-31',
            creationTime: '2026-07-21T13:45:00Z', orderStatus: 'OPEN', statusText: 'Aberta',
            requestType: 'N', requestStatus: 'ACCEPTED',
            pendingQuantity: 300, filledQuantity: 0, filledAveragePrice: 0, filledVolume: 0, pendingVolume: 15450,
        },
    },
}

// ---------------------------------------------------------------------------
// Alertas por conta
// ---------------------------------------------------------------------------

const alerts = {
    '123456': [
        { symbol: 'PETR4', account: '123456', conditions: ['lastPrice > 40.00', 'changePercent < -0.03'] },
        { symbol: 'VALE3', account: '123456', conditions: ['lastPrice <= 52.00'] },
    ],
}

// ---------------------------------------------------------------------------
// Setores e recomendações de research
// ---------------------------------------------------------------------------

const sectors = {
    PETR4: 'Petróleo, Gás e Biocombustíveis',
    VALE3: 'Materiais Básicos',
    ITUB4: 'Financeiro',
    BBAS3: 'Financeiro',
    ABCD11: 'Fundos Imobiliários',
    BMIN3: 'Materiais Básicos',
}

// Ranking de recomendações por setor (universo fechado)
const recommendations = {
    'Materiais Básicos': [
        { symbol: 'BMIN3', sector: 'Materiais Básicos', isTopPick: true, recommendation: 'COMPRA', upside: 0.28 },
        { symbol: 'VALE3', sector: 'Materiais Básicos', isTopPick: false, recommendation: 'NEUTRO', upside: 0.05 },
    ],
    'Financeiro': [
        { symbol: 'ITUB4', sector: 'Financeiro', isTopPick: true, recommendation: 'COMPRA', upside: 0.17 },
        { symbol: 'BBAS3', sector: 'Financeiro', isTopPick: true, recommendation: 'COMPRA', upside: 0.238 },
    ],
    'Fundos Imobiliários': [
        { symbol: 'ABCD11', sector: 'Fundos Imobiliários', isTopPick: true, recommendation: 'COMPRA', upside: 0.096 },
    ],
    'Petróleo, Gás e Biocombustíveis': [
        { symbol: 'PETR4', sector: 'Petróleo, Gás e Biocombustíveis', isTopPick: true, recommendation: 'COMPRA', upside: 0.197 },
    ],
}

// Top picks por setor (mapa por ticker)
const topPicks = {
    BMIN3: { sector: 'Materiais Básicos', symbol: 'BMIN3' },
    ITUB4: { sector: 'Financeiro', symbol: 'ITUB4' },
    ABCD11: { sector: 'Fundos Imobiliários', symbol: 'ABCD11' },
    PETR4: { sector: 'Petróleo, Gás e Biocombustíveis', symbol: 'PETR4' },
}

// isTopPick: true para PETR4, ITUB4, BBAS3, ABCD11, BMIN3; false para VALE3
const isTopPickMap = {
    PETR4: true,
    ITUB4: true,
    BBAS3: true,
    ABCD11: true,
    BMIN3: true,
    VALE3: false,
}

// Troca de posição (research): VALE3 é a perdedora → recomendar rotação
const portfolioRecommendation = {
    '123456': [{ positionSymbol: 'VALE3' }],
}

const portfolioAnalysis = {
    '123456': {
        score: 72,
        risk: 'MODERADO',
        summary: 'Carteira concentrada em Petróleo e Mineração. Sugere-se rotação de VALE3 para BMIN3 e diversificação para Financeiro/FIIs.',
        diversification: 0.42,
    },
}

const portfolioAnalysisOverview = {
    '123456': {
        totalVolume: 35440,
        totalProfit: 1030,
        profitPercent: 0.0299,
        bySector: [
            { sector: 'Petróleo, Gás e Biocombustíveis', weight: 0.542, profit: 3160 },
            { sector: 'Materiais Básicos', weight: 0.458, profit: -2130 },
        ],
        suggestions: ['Trocar VALE3 → BMIN3', 'Adicionar ITUB4 (Financeiro)', 'Adicionar ABCD11 (FII)'],
    },
}

module.exports = {
    accounts,
    sessions,
    securities,
    quotes,
    fundamentals,
    fundamentalsSummary,
    lendingRates,
    positions,
    orders,
    alerts,
    sectors,
    recommendations,
    topPicks,
    isTopPickMap,
    portfolioRecommendation,
    portfolioAnalysis,
    portfolioAnalysisOverview,
}
