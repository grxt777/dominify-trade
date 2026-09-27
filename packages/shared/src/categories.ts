import type { I18nText } from './enums';

export type FieldType = 'text' | 'number' | 'select' | 'date' | 'boolean';

/** Поле шаблона заявки. Шаблон лежит в categories.field_schema и задаёт, что обязательно спросить. */
export interface FieldDef {
  key: string;
  label: I18nText;
  type: FieldType;
  required?: boolean;
  unit?: string;
  options?: { value: string; label: I18nText }[];
  /** Вопрос, который бот задаст, если поля не хватает. */
  ask?: I18nText;
}

export interface CategoryNode {
  id: number;
  slug: string;
  parentId: number | null;
  name: I18nText;
  fields: FieldDef[];
  children?: CategoryNode[];
}

/** Общие поля любой заявки: их тоже достаёт разбор. */
export const COMMON_FIELDS: FieldDef[] = [
  {
    key: 'quantity',
    label: { ru: 'Количество / тираж', uz: 'Miqdor / tiraj', uzc: 'Миқдор / тираж' },
    type: 'number',
  },
  {
    key: 'deadline',
    label: { ru: 'Срок', uz: 'Muddat', uzc: 'Муддат' },
    type: 'date',
  },
  {
    key: 'budget',
    label: { ru: 'Бюджет, сум', uz: "Byudjet, so'm", uzc: 'Бюджет, сўм' },
    type: 'number',
    unit: 'UZS',
  },
];

/** Какие обязательные поля шаблона не заполнены. */
export function missingRequired(fields: FieldDef[], values: Record<string, unknown>): FieldDef[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    const v = values[f.key];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}
