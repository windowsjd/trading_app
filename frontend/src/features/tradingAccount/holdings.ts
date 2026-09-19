import Decimal from 'decimal.js';
import type { PositionItemDto } from '../position/api';
import type { getTradingAccountPositions } from './api';

export class HoldingsContractError extends Error {
  constructor() {
    super('보유 내역 응답을 안전하게 표시할 수 없습니다.');
    this.name = 'HoldingsContractError';
  }
}

/** The API excludes closed positions by default. Never turn malformed or
 * negative quantities into an apparently empty account on the display path. */
export function isHeldPosition(position: PositionItemDto): boolean {
  if (
    typeof position.quantity !== 'string' ||
    !/^\d+(\.\d+)?$/.test(position.quantity)
  ) {
    throw new HoldingsContractError();
  }
  return new Decimal(position.quantity).gt(0);
}

/** One atomic query result, using the existing offset contract and maximum
 * page size. No partial list/count is published if a later page fails. */
export async function getAccountHoldings(
  accountId: string,
  fetchPage: typeof getTradingAccountPositions,
) {
  const positions: PositionItemDto[] = [];
  const assetIds = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  for (;;) {
    const page = await fetchPage(accountId, { limit: 100, offset });
    const pagination = page.pagination;
    if (
      page.tradingAccountId !== accountId ||
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      pagination.offset !== offset ||
      pagination.returned !== page.positions.length ||
      (total !== undefined && total !== pagination.total)
    )
      throw new HoldingsContractError();
    total = pagination.total;
    for (const position of page.positions) {
      if (assetIds.has(position.assetId)) throw new HoldingsContractError();
      assetIds.add(position.assetId);
      if (isHeldPosition(position)) positions.push(position);
    }
    const next = pagination.nextOffset;
    const returnedEnd = offset + page.positions.length;
    if (next === null) {
      if (returnedEnd !== total) throw new HoldingsContractError();
      return { tradingAccountId: accountId, positions };
    }
    if (
      !Number.isSafeInteger(next) ||
      next <= offset ||
      next !== returnedEnd ||
      next >= total
    ) {
      throw new HoldingsContractError();
    }
    offset = next;
  }
}
