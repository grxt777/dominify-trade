import { formatUzs, REGIONS, type FieldDef, type Lang } from '@dominify/shared';

/** Короткое описание заявки для уведомлений: «Тираж: 1000 · Формат: A5 · Чиланзарский р-н · до 2026-10-05». */
export function summarize(
  req: { fields: Record<string, unknown>; regionCode: string | null; deadline: string | null; budgetUzs: number | null },
  defs: FieldDef[],
  lang: Lang,
): string {
  const parts: string[] = [];
  for (const d of defs) {
    const v = req.fields[d.key];
    if (v === undefined || v === null || v === '' || d.key.startsWith('_')) continue;
    let shown = String(v);
    if (d.type === 'boolean') {
      if (!v) continue;
      shown = { ru: 'да', uz: 'ha', uzc: 'ҳа' }[lang];
    }
    if (d.type === 'select') shown = d.options?.find((o) => o.value === v)?.label[lang] ?? shown;
    parts.push(`${d.label[lang]}: ${shown}`);
  }
  if (req.regionCode) {
    const r = REGIONS.find((x) => x.code === req.regionCode);
    if (r) parts.push(r.name[lang]);
  }
  if (req.deadline) parts.push(`${{ ru: 'срок', uz: 'muddat', uzc: 'муддат' }[lang]} ${req.deadline}`);
  if (req.budgetUzs) parts.push(`${{ ru: 'бюджет', uz: 'byudjet', uzc: 'бюджет' }[lang]} ${formatUzs(req.budgetUzs)}`);
  return parts.join(' · ');
}
