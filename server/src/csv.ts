// Lecture CSV minimale (guillemets, guillemets doublés, séparateur « ; » ou « , » détecté, BOM, fins de ligne Windows).
export function parseCsv(text: string): { header: string[]; rows: { line: number; cells: Record<string, string> }[] } {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) && first.includes(';') ? ';' : ',';
  const table: string[][] = []; let row: string[] = []; let cell = ''; let q = false; const lineOf: number[] = []; let line = 1; let rowLine = 1;
  const endRow = () => { row.push(cell); cell = ''; if (row.some(x => x.trim() !== '')) { table.push(row); lineOf.push(rowLine); } row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else { cell += ch; if (ch === '\n') line++; }
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { endRow(); line++; rowLine = line; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  const header = (table[0] ?? []).map(h => h.trim().toLowerCase());
  return { header, rows: table.slice(1).map((r, i) => ({ line: lineOf[i + 1]!, cells: Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])) })) };
}

/** Une cellule CSV protégée contre l'injection de formule (tableur) : préfixe d'une apostrophe si elle commence par = + - @. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]): string => '﻿' + [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
