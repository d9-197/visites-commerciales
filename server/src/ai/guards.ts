import type { Proposal } from './types.js';

// Contrôles automatiques sur la sortie du modèle. Ils ne prouvent pas que le texte est exact : ils signalent ce qui mérite un coup d'œil.

/**
 * Nombres d'un texte, normalisés : « 40 000 », « 40.000 » et « 40000 » deviennent « 40000 » ; les décimaux prennent un point (« 3,5 » -> « 3.5 »).
 * Un groupe de trois chiffres après un séparateur est lu comme un séparateur de milliers.
 */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+(?:[.,]\d+)?|\d+[.,]\d+|\d+/g)) {
    let n = m[0];
    if (/^\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+$/.test(n)) n = n.replace(/[ \u00a0\u202f.,]/g, '');
    else if (/^\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+[.,]\d+$/.test(n)) n = n.replace(/[ \u00a0\u202f]/g, '').replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
    else n = n.replace(',', '.');
    out.add(n.replace(/^0+(?=\d)/, ''));
  }
  return out;
}

/** Mots commençant par une majuscule au milieu d'une phrase (noms propres probables). */
export function properNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
    words.slice(1).forEach(w => { if (/^\p{Lu}/u.test(w) && w.length > 1 && w !== w.toUpperCase()) names.push(w); });
  }
  return names;
}

const norm = (s: string) => s.toLocaleLowerCase('fr').normalize('NFD').replace(/\p{M}/gu, '');

export function checkProposal(p: Proposal, source: string, today: string): string[] {
  const warnings: string[] = [];
  const srcNumbers = numbersIn(source);
  const srcWords = norm(source);
  const texts = [...Object.values(p.fields), ...p.actions.map(a => a.title)];
  const seenN = new Set<string>(), seenW = new Set<string>();
  for (const t of texts) {
    for (const n of numbersIn(t)) if (!srcNumbers.has(n) && !seenN.has(n)) { seenN.add(n); warnings.push(`Nombre absent des notes : ${n}. Les nombres dictés en toutes lettres ne sont pas reconnus : vérifiez.`); }
    for (const w of properNamesIn(t)) if (!srcWords.includes(norm(w)) && !seenW.has(w)) { seenW.add(w); warnings.push(`Nom absent des notes : ${w}.`); }
  }
  for (const a of p.actions) {
    if (a.due_date && a.due_date < today) warnings.push(`Échéance dans le passé pour « ${a.title} » (${a.due_date}).`);
    if (a.due_date && !a.due_date_certain) warnings.push(`Échéance calculée à partir d'une date relative pour « ${a.title} » (${a.due_date}) : à vérifier.`);
  }
  return warnings;
}
