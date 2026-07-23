/**
 * Renderização legível, em texto puro, de um `RouteResult` — a ferramenta de
 * depuração de recall.
 *
 * Sem cor nem sequências ANSI: a saída é feita para ser lida no terminal E redirecionada
 * para arquivo/`grep` sem sujeira. As colunas são alinhadas dinamicamente.
 */

import type { RouteCandidate, RouteResult } from '../types.js';
import { commandIdToToolName } from './tools.js';

type Align = 'left' | 'right';

const COL_GAP = '  ';

function fmt4(n: number): string {
  return n.toFixed(4);
}

function fmtMs(n: number): string {
  return `${n.toFixed(1)}ms`;
}

/** Colapsa espaços e trunca preservando largura previsível. */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function pad(text: string, width: number, align: Align): string {
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

/**
 * Renderiza uma tabela alinhada com linha de cabeçalho e régua de separação.
 * Cada linha tem o trailing whitespace removido para não sujar diffs/redirecionamento.
 */
function renderTable(headers: string[], rows: string[][], aligns: Align[]): string {
  const widths = headers.map((header, col) => {
    let width = header.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > width) width = cell.length;
    }
    return width;
  });

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, col) => pad(cell, widths[col] ?? 0, aligns[col] ?? 'left'))
      .join(COL_GAP)
      .replace(/\s+$/, '');

  const rule = widths.map((width) => '-'.repeat(width)).join(COL_GAP).replace(/\s+$/, '');

  return [renderRow(headers), rule, ...rows.map(renderRow)].join('\n');
}

/** Ex.: `d1 l3 r2` — posições em cada lista antes da fusão; `-` para ausente. */
function formatRanks(candidate: RouteCandidate): string {
  const { ranks } = candidate.breakdown;
  const parts = [
    ranks.dense !== undefined ? `d${ranks.dense}` : 'd-',
    ranks.lexical !== undefined ? `l${ranks.lexical}` : 'l-',
  ];
  if (ranks.rerank !== undefined) parts.push(`r${ranks.rerank}`);
  return parts.join(' ');
}

/**
 * Devolve um texto multi-linha descrevendo o roteamento: consulta, abstenção, timings
 * e uma tabela por candidato com score, breakdown, o kind e o texto que casou.
 */
export function explainRoute(result: RouteResult): string {
  const { timings } = result;
  const hasRerank = result.candidates.some((c) => c.breakdown.rerank !== undefined);

  const header = [
    `query      : "${result.query}"`,
    `abstained  : ${result.abstained}`,
    `candidatos : ${result.candidates.length}`,
    `timings    : embed ${fmtMs(timings.embedMs)}  search ${fmtMs(timings.searchMs)}  ` +
      `rerank ${fmtMs(timings.rerankMs)}  total ${fmtMs(timings.totalMs)}`,
  ].join('\n');

  if (result.candidates.length === 0) {
    return `${header}\n\n(sem candidatos)`;
  }

  const headers = ['#', 'score', 'dense', 'lexical'];
  const aligns: Align[] = ['right', 'right', 'right', 'right'];
  if (hasRerank) {
    headers.push('rerank');
    aligns.push('right');
  }
  headers.push('ranks', 'agent', 'command', 'kind', 'matched');
  aligns.push('left', 'left', 'left', 'left', 'left');

  const rows: string[][] = result.candidates.map((candidate, i) => {
    const b = candidate.breakdown;
    const row = [
      String(i + 1),
      fmt4(candidate.score),
      fmt4(b.dense),
      fmt4(b.lexical),
    ];
    if (hasRerank) row.push(b.rerank !== undefined ? fmt4(b.rerank) : '-');
    row.push(
      formatRanks(candidate),
      candidate.command.agent,
      commandIdToToolName(candidate.commandId),
      b.matchedKind,
      `"${truncate(b.matchedText, 56)}"`,
    );
    return row;
  });

  return `${header}\n\n${renderTable(headers, rows, aligns)}`;
}
