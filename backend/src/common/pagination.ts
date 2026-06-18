export type Pagination = {
  limit: number;
  offset: number;
  total: number;
  returned: number;
  nextOffset: number | null;
};

export function buildPagination(input: {
  limit: number;
  offset: number;
  total: number;
  returned: number;
}): Pagination {
  const nextOffset = input.offset + input.returned;

  return {
    limit: input.limit,
    offset: input.offset,
    total: input.total,
    returned: input.returned,
    nextOffset: nextOffset < input.total ? nextOffset : null,
  };
}
