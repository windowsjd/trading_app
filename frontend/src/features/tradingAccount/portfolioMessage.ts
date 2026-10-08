import type { TradingAccountPortfolioDto } from './api.ts';

export type PortfolioNotice = {
  title: string;
  message: string;
};

const PRICE_UNAVAILABLE_CODES = new Set([
  'FUTURES_MARK_UNAVAILABLE',
  'FUTURES_MARK_STALE',
  'ASSET_PRICE_UNAVAILABLE',
  'FX_RATE_UNAVAILABLE',
  'FX_RATE_STALE',
]);

export const PRICE_UNAVAILABLE_NOTICE: PortfolioNotice = {
  title: '일부 시세 조회 불가',
  message:
    '일부 보유 종목의 시세를 확인할 수 없어 총 자산과 수익률을 계산할 수 없습니다. 현금 잔액과 보유 종목은 지갑에서 확인할 수 있습니다.',
};

const GENERIC_UNAVAILABLE_NOTICE: PortfolioNotice = {
  title: '일부 계정 정보 조회 불가',
  message:
    '총 자산과 수익률을 계산할 수 없습니다. 현금 잔액과 보유 종목은 지갑에서 별도로 확인할 수 있습니다.',
};

/** Maps backend codes to stable user copy; raw exception messages stay internal. */
export function getPortfolioNotice(
  portfolio: TradingAccountPortfolioDto,
): PortfolioNotice | null {
  if (portfolio.state === 'available' && portfolio.sectionErrors.length === 0) {
    return null;
  }

  if (portfolio.finalResult) {
    return portfolio.finalResult.state === 'available' ? {
      title: '최종 자산 비중 조회 불가',
      message: '최종 자산과 수익률은 확정값입니다. 자산 비중의 저장된 세부 내역을 불러오지 못했습니다.',
    } : {
      title: '최종 결과 조회 불가',
      message: '저장된 시즌 최종 결과를 불러오지 못했습니다. 현재 시세로 다시 계산하지 않습니다.',
    };
  }

  const codes = [
    portfolio.reason,
    ...portfolio.sectionErrors.map((error) => error.code),
  ];
  return codes.some((code) => code && PRICE_UNAVAILABLE_CODES.has(code))
    ? PRICE_UNAVAILABLE_NOTICE
    : GENERIC_UNAVAILABLE_NOTICE;
}
