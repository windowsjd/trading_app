import type {
  ConditionalBuyCapabilitiesDto,
  ConditionalBuyListDto,
  ConditionalBuyOrderDto,
  getConditionalBuyOrders,
} from './conditionalBuyApi';

/**
 * Reads for the account's Conditional BUY list (kept free of the API client
 * so they run under `node --test`).
 *
 * WHY TWO READS. History is `createdAt DESC`, so one page of all rows hides an
 * old watch — or an old watch whose limit order still waits — behind newer
 * ended rows, while the server keeps watching it. The list therefore reads
 * every row the owner can still cancel (`state=open`, every page) and pages
 * the ended history separately (`state=ended`).
 */
export const OPEN_CONDITIONAL_BUY_STATES: readonly string[] = ['watching', 'triggered', 'order_pending'];

export function isOpenConditionalBuy(row: Pick<ConditionalBuyOrderDto, 'state'>) {
  return OPEN_CONDITIONAL_BUY_STATES.includes(row.state);
}

export class ConditionalBuyListContractError extends Error {
  constructor() {
    super('조건주문 목록 응답을 안전하게 표시할 수 없습니다.');
    this.name = 'ConditionalBuyListContractError';
  }
}

export type OpenConditionalBuyOrders = {
  tradingAccountId: string;
  capabilities: ConditionalBuyCapabilitiesDto;
  conditionalOrders: ConditionalBuyOrderDto[];
};

/**
 * Every open row, all pages, before anything is shown. Like the pending-order
 * read, a page that shifted (changed total, duplicate id, broken offsets) or
 * names another account fails the whole read: an incomplete list is never
 * presented as complete, and the next poll retries. A row that ended between
 * the server's filter and its presentation (a linked order that just filled)
 * is simply not open any more; the ended history shows it.
 */
export async function getOpenConditionalBuyOrders(
  accountId: string,
  fetchPage: typeof getConditionalBuyOrders,
  signal?: AbortSignal,
): Promise<OpenConditionalBuyOrders> {
  const conditionalOrders: ConditionalBuyOrderDto[] = [];
  const ids = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  for (;;) {
    const page = await fetchPage(accountId, { state: 'open', limit: 100, offset }, signal);
    const { pagination } = page;
    if (
      page.tradingAccountId !== accountId ||
      !Array.isArray(page.conditionalOrders) ||
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      pagination.offset !== offset ||
      pagination.returned !== page.conditionalOrders.length ||
      (total !== undefined && total !== pagination.total)
    ) throw new ConditionalBuyListContractError();
    total = pagination.total;
    for (const row of page.conditionalOrders) {
      if (!row?.id || ids.has(row.id)) throw new ConditionalBuyListContractError();
      ids.add(row.id);
      if (isOpenConditionalBuy(row)) conditionalOrders.push(row);
    }
    const end = offset + page.conditionalOrders.length;
    const next = pagination.nextOffset;
    if (next === null) {
      if (end !== total) throw new ConditionalBuyListContractError();
      return { tradingAccountId: accountId, capabilities: page.capabilities, conditionalOrders };
    }
    if (!Number.isSafeInteger(next) || next !== end || next <= offset || next >= total)
      throw new ConditionalBuyListContractError();
    offset = next;
  }
}

/** One ended-history page; an open row in it means the filter was not applied. */
export function assertEndedConditionalBuyPage(accountId: string, page: ConditionalBuyListDto) {
  if (
    page.tradingAccountId !== accountId ||
    !Array.isArray(page.conditionalOrders) ||
    page.conditionalOrders.some((row) => !row?.id || isOpenConditionalBuy(row))
  ) throw new ConditionalBuyListContractError();
  return page;
}

/**
 * Loaded ended pages as one list. Ended rows only ever join the history (a
 * row never reopens), so an offset page can repeat a row that a newer ended
 * row pushed down, but never skip one: keep the first copy. A row the open
 * read still shows from an older poll has ended for certain once the history
 * lists it, so it leaves the open list.
 */
export function mergeConditionalBuyLists(
  open: readonly ConditionalBuyOrderDto[],
  endedPages: readonly ConditionalBuyListDto[],
) {
  const ended: ConditionalBuyOrderDto[] = [];
  const endedIds = new Set<string>();
  for (const page of endedPages)
    for (const row of page.conditionalOrders) {
      if (endedIds.has(row.id)) continue;
      endedIds.add(row.id);
      ended.push(row);
    }
  return { open: open.filter((row) => !endedIds.has(row.id)), ended };
}
