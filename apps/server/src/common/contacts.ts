/** Коды мобильных и городских операторов Узбекистана: так маска не задевает цены и тиражи. */
const UZ_CODES = '33|50|55|61|62|65|66|67|69|70|71|72|73|74|75|76|77|78|79|88|90|91|93|94|95|97|98|99';
const SEP = '[\\s.\\-]?';

// Порядок важен: ссылка целиком заменяется раньше, чем номер внутри неё (wa.me/998…).
const PATTERNS: RegExp[] = [
  /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|wa\.me|api\.whatsapp\.com|instagram\.com|instagr\.am)\/[\w/?=&%+.-]*/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  // +998 90 123 45 67, 998901234567, (90) 123-45-67, 90.123.45.67
  new RegExp(`(?<!\\d)(?:\\+?998${SEP})?\\(?(?:${UZ_CODES})\\)?${SEP}\\d{3}${SEP}\\d{2}${SEP}\\d{2}(?!\\d)`, 'g'),
  /(?<![\w@])@[a-zA-Z][\w]{4,31}\b/g,
];

export const CONTACT_PLACEHOLDER = '[🔒]';

/**
 * До выбора исполнителя стороны общаются на платформе: телефоны, почта, @username и ссылки на мессенджеры
 * скрываются. Контакт покупателя открывается только выбранному поставщику.
 */
export function maskContacts(text: string): { text: string; masked: boolean } {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, CONTACT_PLACEHOLDER);
  return { text: out, masked: out !== text };
}
