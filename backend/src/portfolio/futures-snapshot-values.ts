import type { PortfolioValuationResult } from './portfolio-valuation.policy';

/** The same signed component/evidence accompanies every F3 snapshot writer. */
export function futuresSnapshotValues(
  valuation: Partial<PortfolioValuationResult>,
) {
  return {
    futuresUnrealizedPnlUsd: valuation.futuresUnrealizedPnlUsd ?? '0.00000000',
    futuresUnrealizedPnlKrw: valuation.futuresUnrealizedPnlKrw ?? '0.00000000',
    futuresValuationJson: valuation.futuresValuationJson ?? { positions: [] },
  };
}
