/**
 * Транслитерация узбекского с латиницы на кириллицу. Нужна, чтобы тексты каталога и уведомлений
 * не приходилось вручную дублировать для кириллической версии.
 */
const PAIRS: [string, string][] = [
  ["o'", 'ў'], ['o‘', 'ў'], ['oʻ', 'ў'], ["g'", 'ғ'], ['g‘', 'ғ'], ['gʻ', 'ғ'],
  ["O'", 'Ў'], ['O‘', 'Ў'], ['Oʻ', 'Ў'], ["G'", 'Ғ'], ['G‘', 'Ғ'], ['Gʻ', 'Ғ'],
  ['sh', 'ш'], ['Sh', 'Ш'], ['SH', 'Ш'], ['ch', 'ч'], ['Ch', 'Ч'], ['CH', 'Ч'],
  ['yo', 'ё'], ['Yo', 'Ё'], ['yu', 'ю'], ['Yu', 'Ю'], ['ya', 'я'], ['Ya', 'Я'], ['ye', 'е'], ['Ye', 'Е'],
];
const SINGLE: Record<string, string> = {
  a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н',
  o: 'о', p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з', c: 'ц', w: 'в',
  "'": 'ъ', '’': 'ъ', 'ʼ': 'ъ',
};

export function uzLatinToCyrillic(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const two = input.slice(i, i + 2);
    const pair = PAIRS.find(([lat]) => lat === two);
    if (pair) {
      out += pair[1];
      i += 2;
      continue;
    }
    const ch = input[i];
    const lower = ch.toLowerCase();
    const prev = i === 0 ? ' ' : input[i - 1];
    // «e» в начале слова пишется как «э».
    if (lower === 'e' && !/[a-zA-Z'‘ʻ’]/.test(prev)) {
      out += ch === 'E' ? 'Э' : 'э';
      i += 1;
      continue;
    }
    const mapped = SINGLE[lower];
    if (mapped) {
      out += ch === lower ? mapped : mapped.toUpperCase();
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

/** Текст на трёх языках из русского и узбекской латиницы. */
export function t3(ru: string, uz: string): { ru: string; uz: string; uzc: string } {
  return { ru, uz, uzc: uzLatinToCyrillic(uz) };
}
