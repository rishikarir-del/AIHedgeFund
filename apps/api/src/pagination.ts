/**
 * Cursor pagination.
 *
 * CLAUDE.md 17.2 requires cursor pagination for large collections. UUIDv7 ids
 * sort chronologically, so the id itself is a valid cursor and no separate
 * sort column or offset is needed -- which is also why 7.2 asks for UUIDv7
 * rather than v4.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  readonly limit: number;
  readonly after: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function parsePageRequest(query: {
  limit?: string | undefined;
  after?: string | undefined;
}): PageRequest {
  const raw = Number.parseInt(query.limit ?? '', 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { limit, after: query.after ?? null };
}

/**
 * Builds a page from `limit + 1` rows: the extra row proves whether more
 * exist without a second count query.
 */
export function buildPage<T extends { id: string }>(rows: readonly T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}
