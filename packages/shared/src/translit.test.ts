import { describe, expect, it } from 'vitest';
import { uzLatinToCyrillic } from './translit';

describe('uzLatinToCyrillic', () => {
  it('переводит типичные слова', () => {
    expect(uzLatinToCyrillic("Toshkent")).toBe('Тошкент');
    expect(uzLatinToCyrillic("O'zbekiston")).toBe('Ўзбекистон');
    expect(uzLatinToCyrillic("choy")).toBe('чой');
    expect(uzLatinToCyrillic("ekran")).toBe('экран');
    expect(uzLatinToCyrillic("Farg'ona")).toBe('Фарғона');
  });
});
