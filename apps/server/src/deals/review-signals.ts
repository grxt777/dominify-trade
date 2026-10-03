export interface ReviewContext {
  /** Подтверждён ли телефон автора отзыва. */
  authorPhoneVerified: boolean;
  /** Совпадает ли телефон автора с телефоном кого-то из компании, которую он оценивает. */
  authorPhoneMatchesTarget: boolean;
  /** Состоит ли автор в компании, которую оценивает. */
  authorIsTargetMember: boolean;
  /** Сколько учтённых отзывов этот автор уже оставил этой компании за период охлаждения. */
  recentCountedPairReviews: number;
}

export type ReviewFlag = 'self_review' | 'same_phone' | 'unverified_author' | 'repeat_pair';

/**
 * Решает, влияет ли отзыв на рейтинг. Отзыв с флагом остаётся видимым, но рейтинг не двигает,
 * а модератор получает задачу на проверку. Порядок важен: сначала самые явные признаки накрутки.
 */
export function decideReview(ctx: ReviewContext): { counted: boolean; flag: ReviewFlag | null } {
  if (ctx.authorIsTargetMember) return { counted: false, flag: 'self_review' };
  if (ctx.authorPhoneMatchesTarget) return { counted: false, flag: 'same_phone' };
  if (!ctx.authorPhoneVerified) return { counted: false, flag: 'unverified_author' };
  if (ctx.recentCountedPairReviews > 0) return { counted: false, flag: 'repeat_pair' };
  return { counted: true, flag: null };
}

/** Флаги, которые стоит показать модератору. Неподтверждённый телефон — частый случай, не спам в очередь. */
export const MODERATED_FLAGS: ReviewFlag[] = ['self_review', 'same_phone', 'repeat_pair'];
