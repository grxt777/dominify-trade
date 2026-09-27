import { z } from 'zod';
import { ACTIVE_ROLES, COMPANY_TYPES, LANGS } from './enums';

/** Схемы тел запросов API. Одни и те же схемы валидируют форму на фронте и запрос на бэкенде. */

export const updateMeSchema = z.object({
  lang: z.enum(LANGS).optional(),
  activeRole: z.enum(ACTIVE_ROLES).optional(),
  activeCompanyId: z.number().int().positive().nullable().optional(),
});
export type UpdateMeDto = z.infer<typeof updateMeSchema>;

/** ИНН в Узбекистане: 9 цифр у юрлиц, у ИП используется ПИНФЛ из 14 цифр. */
export const innSchema = z
  .string()
  .trim()
  .regex(/^(\d{9}|\d{14})$/, 'ИНН: 9 цифр, для ИП — 14 цифр ПИНФЛ');

export const createCompanySchema = z.object({
  name: z.string().trim().min(2).max(200),
  type: z.enum(COMPANY_TYPES),
  inn: innSchema.optional(),
  regionCode: z.string().min(2).max(64),
  isSupplier: z.boolean().default(false),
  isBuyer: z.boolean().default(true),
  about: z.string().trim().max(1000).optional(),
  categoryIds: z.array(z.number().int().positive()).max(30).default([]),
  areas: z
    .array(z.object({ regionCode: z.string().min(2).max(64) }))
    .max(40)
    .default([]),
  deliversNationwide: z.boolean().default(false),
});
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema.partial();
export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

export const parseRequestSchema = z.object({
  text: z.string().trim().max(4000).default(''),
  fileIds: z.array(z.number().int().positive()).max(10).default([]),
  regionCode: z.string().max(64).optional(),
});
export type ParseRequestDto = z.infer<typeof parseRequestSchema>;

export const submitRequestSchema = z.object({
  requestId: z.number().int().positive(),
  categoryId: z.number().int().positive().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  regionCode: z.string().max(64).optional(),
  title: z.string().trim().min(3).max(200).optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  budgetUzs: z.number().int().positive().max(100_000_000_000).nullable().optional(),
});
export type SubmitRequestDto = z.infer<typeof submitRequestSchema>;

export const answerRequestSchema = z.object({
  answer: z.string().trim().min(1).max(1000),
});
export type AnswerRequestDto = z.infer<typeof answerRequestSchema>;

export const createOfferSchema = z.object({
  priceUzs: z.number().int().positive().max(100_000_000_000),
  leadTimeDays: z.number().int().min(0).max(365),
  comment: z.string().trim().max(1000).optional(),
  fileIds: z.array(z.number().int().positive()).max(5).default([]),
});
export type CreateOfferDto = z.infer<typeof createOfferSchema>;

export const reviewSchema = z.object({
  stars: z.number().int().min(1).max(5),
  text: z.string().trim().max(1000).optional(),
});
export type ReviewDto = z.infer<typeof reviewSchema>;

export const sendMessageSchema = z.object({
  text: z.string().trim().max(4000).optional(),
  fileId: z.number().int().positive().optional(),
}).refine((v) => !!v.text || !!v.fileId, { message: 'Пустое сообщение' });
export type SendMessageDto = z.infer<typeof sendMessageSchema>;

export const uploadRequestSchema = z.object({
  fileName: z.string().min(1).max(200),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/ogg']),
  size: z.number().int().positive().max(20 * 1024 * 1024),
});
export type UploadRequestDto = z.infer<typeof uploadRequestSchema>;

export const complaintSchema = z.object({
  targetType: z.enum(['request', 'offer', 'company', 'message']),
  targetId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
});
export type ComplaintDto = z.infer<typeof complaintSchema>;

/** Результат ИИ-разбора. Модель обязана вернуть ровно такую структуру. */
export const parseResultSchema = z.object({
  categorySlug: z.string().nullable(),
  title: z.string().max(200),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  regionCode: z.string().nullable(),
  deadline: z.string().nullable(),
  budgetUzs: z.number().nullable(),
  quantity: z.number().nullable(),
  missingFields: z.array(z.string()),
  question: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  lang: z.enum(['ru', 'uz', 'uzc']),
});
export type ParseResult = z.infer<typeof parseResultSchema>;
