import type {
  ConditionalSellCapabilitiesDto,
  ConditionalSellListDto,
  ConditionalSellListKind,
  ConditionalSellOrderDto,
  getConditionalSellOrders,
} from './conditionalSellApi';
import { isOpenConditionalSell } from './conditionalSellDisplay.ts';

/**
 * Reads for the account's SELL intents (kept free of the API client so they
 * run under `node --test`). Same contract as the Conditional BUY list: every
 * row the owner can still cancel (`state=open`, every page) is read
 * completely, and the ended history pages separately, so an old live
 * stop-loss never hides behind newer ended rows.
 */
export class ConditionalSellListContractError extends Error {
  constructor() {
    super('매도 설정 목록 응답을 안전하게 표시할 수 없습니다.');
    this.name = 'ConditionalSellListContractError';
  }
}

export type OpenConditionalSellOrders = {
  tradingAccountId: string;
  capabilities: ConditionalSellCapabilitiesDto;
  conditionalOrders: ConditionalSellOrderDto[];
};

/**
 * Every open row of one kind, all pages, before anything is shown. A page
 * that shifted (changed total, duplicate id, broken offsets) or names
 * another account fails the whole read: an incomplete list is never shown
 * as complete, and the next poll retries.
 */
export async function getOpenConditionalSellOrders(
  accountId: string,
  kind: ConditionalSellListKind | undefined,
  fetchPage: typeof getConditionalSellOrders,
  signal?: AbortSignal,
): Promise<OpenConditionalSellOrders> {
  const conditionalOrders: ConditionalSellOrderDto[] = [];
  const ids = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  for (;;) {
    const page = await fetchPage(accountId, { state: 'open', kind, limit: 100, offset }, signal);
    const { pagination } = page;
    if (
      page.tradingAccountId !== accountId ||
      !Array.isArray(page.conditionalOrders) ||
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      pagination.offset !== offset ||
      pagination.returned !== page.conditionalOrders.length ||
      (total !== undefined && total !== pagination.total)
    ) throw new ConditionalSellListContractError();
    total = pagination.total;
    for (const row of page.conditionalOrders) {
      if (!row?.id || ids.has(row.id) || (kind && !matchesKind(row, kind))) throw new ConditionalSellListContractError();
      ids.add(row.id);
      if (isOpenConditionalSell(row)) conditionalOrders.push(row);
    }
    const end = offset + page.conditionalOrders.length;
    const next = pagination.nextOffset;
    if (next === null) {
      if (end !== total) throw new ConditionalSellListContractError();
      return { tradingAccountId: accountId, capabilities: page.capabilities, conditionalOrders };
    }
    if (!Number.isSafeInteger(next) || next !== end || next <= offset || next >= total)
      throw new ConditionalSellListContractError();
    offset = next;
  }
}

function matchesKind(row: Pick<ConditionalSellOrderDto, 'kind'>, kind: ConditionalSellListKind) {
  return kind === 'condition' ? row.kind === 'condition' : row.kind === 'stop_loss' || row.kind === 'take_profit';
}

/** One ended-history page; an open row (or another kind) means the filter was not applied. */
export function assertEndedConditionalSellPage(
  accountId: string,
  kind: ConditionalSellListKind | undefined,
  page: ConditionalSellListDto,
) {
  if (
    page.tradingAccountId !== accountId ||
    !Array.isArray(page.conditionalOrders) ||
    page.conditionalOrders.some((row) => !row?.id || isOpenConditionalSell(row) || (kind && !matchesKind(row, kind)))
  ) throw new ConditionalSellListContractError();
  return page;
}

/**
 * Loaded ended pages as one list (first copy wins); a row the open read
 * still shows from an older poll has ended once the history lists it.
 */
export function mergeConditionalSellLists(
  open: readonly ConditionalSellOrderDto[],
  endedPages: readonly ConditionalSellListDto[],
) {
  const ended: ConditionalSellOrderDto[] = [];
  const endedIds = new Set<string>();
  for (const page of endedPages)
    for (const row of page.conditionalOrders) {
      if (endedIds.has(row.id)) continue;
      endedIds.add(row.id);
      ended.push(row);
    }
  return { open: open.filter((row) => !endedIds.has(row.id)), ended };
}
