import type { CategoryNode, FieldDef } from '@dominify/shared';
import { REGIONS } from '@dominify/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { useT } from '../i18n';

/** Поле шаблона категории. */
export function FieldInput({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const base = def.label[t.lang];
  const label = `${base}${def.unit && def.unit !== 'шт' && def.unit !== 'UZS' && !base.includes(def.unit) ? `, ${def.unit}` : ''}${def.required ? ' *' : ''}`;
  if (def.type === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{def.label[t.lang]}</span>
      </label>
    );
  }
  if (def.type === 'select' && def.options) {
    return (
      <label className="field">
        <span>{label}</span>
        <select className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label[t.lang]}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
        inputMode={def.type === 'number' ? 'numeric' : undefined}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          if (def.type === 'number') onChange(v === '' ? null : Number(v));
          else onChange(v);
        }}
      />
    </label>
  );
}

/** Листовые категории с именем вертикали для выпадающего списка. */
export function useLeafCategories() {
  const q = useQuery({ queryKey: ['categories'], queryFn: () => get<CategoryNode[]>('/v1/categories'), staleTime: 3_600_000 });
  const leaves = (q.data ?? []).flatMap((root) => (root.children ?? []).map((c) => ({ ...c, root })));
  return { tree: q.data ?? [], leaves, isLoading: q.isLoading };
}

export function CategorySelect({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const t = useT();
  const { tree } = useLeafCategories();
  return (
    <label className="field">
      <span>{t('category')} *</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        <option value="">{t('chooseCategory')}</option>
        {tree.map((root) => (
          <optgroup key={root.id} label={root.name[t.lang]}>
            {(root.children ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name[t.lang]}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function RegionSelect({ value, onChange, label }: { value: string | null; onChange: (code: string) => void; label?: string }) {
  const t = useT();
  const roots = REGIONS.filter((r) => !r.parent);
  return (
    <label className="field">
      <span>{label ?? t('region')}</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {roots.map((r) => {
          const kids = REGIONS.filter((k) => k.parent === r.code);
          return kids.length ? (
            <optgroup key={r.code} label={r.name[t.lang]}>
              <option value={r.code}>{r.name[t.lang]}</option>
              {kids.map((k) => (
                <option key={k.code} value={k.code}>
                  {k.name[t.lang]}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={r.code} value={r.code}>
              {r.name[t.lang]}
            </option>
          );
        })}
      </select>
    </label>
  );
}
