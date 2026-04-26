import { z } from 'zod';

export const PageRequestSchema = z.object({
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

export interface PageResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  total?: number;
  hasNext: boolean;
}

export function createPageResponseSchema<T extends z.ZodType>(
  itemSchema: T,
): z.ZodType<PageResponse<z.infer<T>>> {
  return z.object({
    data: z.array(itemSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0).optional(),
    hasNext: z.boolean(),
  });
}

export const CursorPageRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type CursorPageRequest = z.infer<typeof CursorPageRequestSchema>;

export interface CursorPageResponse<T> {
  data: T[];
  nextCursor?: string;
  hasNext: boolean;
}

export function createCursorPageResponseSchema<T extends z.ZodType>(
  itemSchema: T,
): z.ZodType<CursorPageResponse<z.infer<T>>> {
  return z.object({
    data: z.array(itemSchema),
    nextCursor: z.string().optional(),
    hasNext: z.boolean(),
  });
}
