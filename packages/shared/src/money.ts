/** Сумма в сумах с пробелами-разделителями: 149000 → «149 000». */
export function formatUzs(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Payme и Click считают в тийинах: 1 сум = 100 тийин. */
export const uzsToTiyin = (uzs: number): number => Math.round(uzs * 100);
export const tiyinToUzs = (tiyin: number): number => Math.round(tiyin) / 100;
