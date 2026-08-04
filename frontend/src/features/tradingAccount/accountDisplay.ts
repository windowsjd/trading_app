import type { TradingAccountDto, TradingAccountStatus } from './api';

/**
 * How an account is NAMED to a person (작업 9 §B-3).
 *
 * A raw UUID is never shown. It is not a name, it carries no information a user
 * can act on, and two of them side by side are indistinguishable — which is
 * exactly the failure this whole work item is about avoiding.
 */

export type AccountDisplay = {
  /** Primary line: "일반 투자" or the season's own name. */
  title: string;
  /** Secondary line: mode meaning, or the season period/participation. */
  subtitle: string | null;
  statusLabel: string;
  statusTone: 'active' | 'suspended' | 'closed';
  /** What the account's return rate MEANS, spelled out rather than implied. */
  returnRateLabel: string;
};

const STATUS_LABEL: Record<TradingAccountStatus, string> = {
  active: '운영 중',
  suspended: '일시정지',
  closed: '종료',
};

const SEASON_STATUS_LABEL: Record<string, string> = {
  upcoming: '시작 전',
  active: '진행 중',
  ended: '종료됨',
  settled: '정산 완료',
};

const PARTICIPANT_STATUS_LABEL: Record<string, string> = {
  registered: '참가 등록',
  active: '참가 중',
  excluded: '참가 제외',
  finished: '참가 종료',
  rewarded: '보상 지급 완료',
};

type DisplayInput = Pick<
  TradingAccountDto,
  'mode' | 'status' | 'season' | 'openedAt' | 'closedAt'
>;

export function getAccountDisplay(account: DisplayInput): AccountDisplay {
  const statusLabel = STATUS_LABEL[account.status] ?? account.status;
  const statusTone = account.status;

  if (account.mode === 'general') {
    return {
      title: '일반 투자',
      subtitle: '시즌과 무관한 상시 계정',
      statusLabel,
      statusTone,
      // TWR: the ad-funded inflow is a deposit, not a gain, and the label says so.
      returnRateLabel: '시간가중 수익률',
    };
  }

  const season = account.season;
  const seasonStatus = season
    ? (SEASON_STATUS_LABEL[season.seasonStatus] ?? season.seasonStatus)
    : null;
  const participantStatus = season
    ? (PARTICIPANT_STATUS_LABEL[season.participantStatus] ??
      season.participantStatus)
    : null;

  return {
    title: season?.seasonName ?? '시즌 계정',
    subtitle:
      seasonStatus && participantStatus
        ? `${seasonStatus} · ${participantStatus}`
        : seasonStatus,
    statusLabel,
    statusTone,
    returnRateLabel: '시즌 수익률 (초기자본 대비)',
  };
}

/**
 * The label for a `returnRateMethod` a RESPONSE reported.
 *
 * Read from the payload rather than inferred from the selected account's mode:
 * the two must agree, and if they ever do not, the response is the fact.
 */
export function getReturnRateMethodLabel(
  method: 'time_weighted' | 'initial_capital' | null | undefined,
): string {
  if (method === 'time_weighted') return '시간가중 수익률';
  if (method === 'initial_capital') return '시즌 수익률 (초기자본 대비)';
  return '수익률';
}
