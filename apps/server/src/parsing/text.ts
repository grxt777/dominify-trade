/** Убрать телефоны, ИНН и карты из текста перед отправкой внешнему провайдеру ИИ. */
export function maskPII(text: string): string {
  return text
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[карта]')
    .replace(/(\+?998[\s-]?)?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g, '[телефон]')
    .replace(/\b\d{14}\b/g, '[ПИНФЛ]')
    .replace(/\b(ИНН|INN|STIR)\s*:?\s*\d{9}\b/gi, '$1 [ИНН]')
    .replace(/@[a-zA-Z0-9_]{5,32}\b/g, '[telegram]');
}

/** Грубое определение языка: русский, узбекская латиница или узбекская кириллица. */
export function detectLang(text: string): 'ru' | 'uz' | 'uzc' {
  const t = text.toLowerCase();
  if (/[ўқғҳ]/.test(t)) return 'uzc';
  const cyr = (t.match(/[а-яё]/g) ?? []).length;
  const lat = (t.match(/[a-z]/g) ?? []).length;
  if (lat > cyr) return 'uz';
  if (/\b(керак|бор|нарх|қанча|канча|сизда)\b/.test(t)) return 'uzc';
  return 'ru';
}
