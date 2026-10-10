import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { auditGeneralAccounts } from '../lib/audit-general-accounts';
import {
  planFuturesExecution,
  futuresDecimal,
} from '../../src/futures/futures-math';
import { bankruptcySettlement } from '../../src/futures/futures-settlement';
import {
  roundDecimalHalfUp,
  calculateGrossTargetAmount,
  calculateFeeAmount,
  calculateNetTargetAmount,
} from '../../src/fx/fx-decimal-policy';
import {
  marginCeil,
  futuresPnl,
  futuresMoney,
} from '../../src/futures/futures-math';
import { parseFuturesEntry } from '../../src/futures/futures-limit.service';
import { readGeneralTradeFeeRate } from '../../src/orders/general-trading.config';
import {
  positionRisk,
  crossRisk,
  presentPositionRisk,
  riskStrings,
} from '../../src/futures/futures-risk';
import { conditionalHash } from '../../src/conditional/conditional-policy';
import {
  futuresCommandHash,
  parseFuturesCommand,
} from '../../src/futures/futures-input';
import type { Fixture } from './actor';
import { preflight } from './preflight';
import type { Manifest, Credentials } from './manifest';
import { writeJson, Metrics } from './metrics';
import { AppClient } from './client';
import { hash } from './manifest';
import { resolve } from 'node:path';

type Finding = { code: string; accountId: string; rowId?: string };
const d = (v: any) => new Prisma.Decimal(v ?? '0');
const round = (v: Prisma.Decimal) => roundDecimalHalfUp(v, 8);
/** Reconstructs the exact ledger balance chain, including multiple legs with
 * the SAME timestamp. UUID order is not an economic/transaction order. */
export function ledgerChain(
  rows: Array<{
    amount: any;
    direction: string;
    balanceAfter: any;
    occurredAt: Date;
  }>,
  final: any,
) {
  let balance = d('0');
  const times = [...new Set(rows.map((r) => +r.occurredAt))].sort(
    (a, b) => a - b,
  );
  for (const time of times) {
    const pending = rows.filter((r) => +r.occurredAt === time);
    while (pending.length) {
      const index = pending.findIndex((r) =>
        d(r.balanceAfter)
          .sub(r.direction === 'credit' ? d(r.amount) : d(r.amount).neg())
          .eq(balance),
      );
      if (index < 0) return false;
      const [row] = pending.splice(index, 1);
      if (d(row.amount).lt(0)) return false;
      balance = d(row.balanceAfter);
    }
  }
  return balance.eq(final);
}
export async function audit(
  m: Manifest,
  c: Credentials,
  fixture: Fixture,
  out: string,
) {
  await preflight(m, c);
  if (fixture.runId !== m.runId || fixture.actors.length !== m.users)
    throw new Error('AUDIT_FIXTURE_SCOPE_MISMATCH');
  process.env.DATABASE_URL = c.databaseUrl;
  const db = new PrismaService();
  await db.$connect();
  const findings: Finding[] = [];
  const add = (code: string, accountId: string, rowId?: string) =>
    findings.push({ code, accountId, rowId });
  const latency = new Metrics();
  latency.phase = 'post-run';
  const valuations = new Map<string, any>();
  const equal = (
    a: any,
    b: any,
    code: string,
    account: string,
    row?: string,
  ) => {
    if (!d(a).eq(d(b))) add(code, account, row);
  };
  let examinedOrders = 0,
    examinedExecutions = 0,
    examinedLedgers = 0,
    liquidationAccounts = 0;
  try {
    // Normal authenticated reads, after actions drain. Use the exact immutable
    // Mark evidence returned by the API; never compare a later moving price.
    for (const actor of fixture.actors) {
      const client = new AppClient(m, c, actor.email, new Metrics());
      await client.login();
      valuations.set(
        actor.accountId,
        await client.get(
          `/trading-accounts/${actor.accountId}/futures/positions`,
        ),
      );
    }
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const general = await auditGeneralAccounts(
          tx as unknown as PrismaClient,
        );
        for (const f of general.findings)
          add(f.code, f.tradingAccountId ?? 'general-aggregate');
        const allowed = new Set(fixture.actors.map((a) => a.accountId));
        const actual = await tx.tradingAccount.findMany({
          select: { id: true },
        });
        if (
          actual.length !== allowed.size ||
          actual.some((a) => !allowed.has(a.id))
        )
          add('FOREIGN_ACCOUNT_IN_TEST_DB', 'database');
        for (const actor of fixture.actors) {
          const id = actor.accountId;
          const account = await tx.tradingAccount.findUniqueOrThrow({
            where: { id },
            include: { seasonParticipant: { include: { season: true } } },
          });
          if (
            account.userId !== actor.userId ||
            account.mode !== actor.mode ||
            (account.mode === 'season'
              ? account.seasonParticipant?.userId !== actor.userId
              : account.seasonParticipant !== null)
          )
            add('ACCOUNT_OWNERSHIP_SCOPE', id);
          const wallets = await tx.cashWallet.findMany({
            where: { tradingAccountId: id },
          });
          if (
            wallets.length !== 4 ||
            new Set(wallets.map((w) => `${w.walletScope}/${w.currencyCode}`))
              .size !== 4 ||
            wallets.some(
              (w) => w.walletScope !== 'securities' && w.currencyCode !== 'USD',
            )
          )
            add('CANONICAL_WALLETS', id);
          const ledger = await tx.walletTransaction.findMany({
            where: { tradingAccountId: id },
          });
          examinedLedgers += ledger.length;
          const orders = await tx.order.findMany({
            where: { tradingAccountId: id },
            include: {
              quote: true,
              assetPriceSnapshot: true,
              fxRateSnapshot: true,
            },
            orderBy: [{ executedAt: 'asc' }, { createdAt: 'asc' }],
          });
          examinedOrders += orders.length;
          const entries = await tx.futuresLimitOrder.findMany({
            where: { tradingAccountId: id },
          });
          const groups = await tx.protectionGroup.findMany({
            where: { tradingAccountId: id },
            include: { children: true, legs: true },
          });
          const positionRows = await tx.position.findMany({
            where: { tradingAccountId: id },
          });
          for (const wallet of wallets) {
            const rows = ledger.filter((l) => l.walletId === wallet.id);
            if (!ledgerChain(rows, wallet.balanceAmount))
              add('WALLET_LEDGER_BALANCE_CHAIN', id, wallet.id);
            if (rows.some((l) => l.currencyCode !== wallet.currencyCode))
              add('LEDGER_CURRENCY_SCOPE', id, wallet.id);
            let reservation = orders
              .filter(
                (o) =>
                  o.status === 'submitted' &&
                  o.side === 'buy' &&
                  o.currencyCode === wallet.currencyCode &&
                  o.cashWalletScope === wallet.walletScope,
              )
              .reduce((s, o) => s.add(o.reservedAmount ?? 0), d(0));
            if (wallet.walletScope === 'crypto_futures')
              reservation = reservation.add(
                entries
                  .filter((e) => e.status === 'submitted')
                  .reduce((s, e) => s.add(e.reservedAmount), d(0)),
              );
            equal(
              wallet.reservedAmount,
              reservation,
              'WALLET_RESERVATION',
              id,
              wallet.id,
            );
            if (
              wallet.balanceAmount.lt(0) ||
              wallet.reservedAmount.lt(0) ||
              wallet.reservedAmount.gt(wallet.balanceAmount)
            )
              add('INVALID_AVAILABLE_CASH', id, wallet.id);
          }
          if (ledger.some((l) => !wallets.some((w) => w.id === l.walletId)))
            add('LEDGER_ACCOUNT_SCOPE', id);
          const grants = ledger.filter((l) => l.txType === 'initial_grant');
          if (
            grants.length !== 1 ||
            !grants[0].amount.eq(account.initialCapitalKrw) ||
            grants[0].direction !== 'credit'
          )
            add('INITIAL_GRANT', id);
          const seenKeys = new Set<string>();
          const positionState = new Map<
            string,
            {
              quantity: Prisma.Decimal;
              averageCost: Prisma.Decimal;
              pnl: Prisma.Decimal;
              pnlKrw: Prisma.Decimal;
            }
          >();
          for (const order of orders) {
            if (order.idempotencyKey) {
              if (seenKeys.has(order.idempotencyKey))
                add('DUPLICATE_SPOT_COMMAND', id, order.id);
              seenKeys.add(order.idempotencyKey);
              if (!order.requestHash || !order.responsePayloadJson)
                add('SPOT_IDEMPOTENCY_EVIDENCE', id, order.id);
            }
            // Conditional children have their own committed execution linkage.
            const child = groups
              .flatMap((g) => g.children)
              .find((ch) => ch.orderId === order.id);
            if (!order.quote && !child)
              add('SPOT_MISSING_QUOTE_OR_CHILD', id, order.id);
            if (
              order.quote &&
              (order.quote.tradingAccountId !== id ||
                order.quote.assetId !== order.assetId ||
                order.quote.cashWalletScope !== order.cashWalletScope)
            )
              add('SPOT_QUOTE_SCOPE', id, order.id);
            if (
              order.status !== 'submitted' &&
              order.orderType === 'limit' &&
              !order.reservationReleasedAt
            )
              add('SPOT_TERMINAL_RESERVATION_NOT_RELEASED', id, order.id);
            const legs = ledger.filter(
              (l) => l.referenceType === 'order' && l.referenceId === order.id,
            );
            if (order.status !== 'executed') {
              if (legs.length) add('NON_EXECUTED_SPOT_LEDGER', id, order.id);
              continue;
            }
            if (order.executedAt)
              latency.time(
                `acceptedToFill.spot.${order.orderType}`,
                Math.max(0, +order.executedAt - +order.createdAt),
              );
            const qty = order.executedQuantity ?? order.quantity;
            if (
              qty.lte(0) ||
              qty.gt(order.quantity) ||
              !order.executedPrice ||
              !order.grossAmount ||
              !order.feeAmount ||
              !order.netAmount ||
              !order.executedAt
            ) {
              add('SPOT_EXECUTION_EVIDENCE', id, order.id);
              continue;
            }
            if (order.executedQuantity && order.canceledQuantity)
              equal(
                order.executedQuantity.add(order.canceledQuantity),
                order.quantity,
                'SPOT_QUANTITY_CONSERVATION',
                id,
                order.id,
              );
            const fee = order.reservationFeeRate ?? order.quote?.quotedFeeRate;
            if (fee === undefined || fee === null)
              add('SPOT_FEE_PIN_MISSING', id, order.id);
            else
              equal(
                order.feeAmount,
                round(order.grossAmount.mul(fee)),
                'SPOT_FEE',
                id,
                order.id,
              );
            if (!order.executionEvidence)
              equal(
                order.grossAmount,
                round(qty.mul(order.executedPrice)),
                'SPOT_GROSS',
                id,
                order.id,
              );
            equal(
              order.netAmount,
              order.side === 'buy'
                ? order.grossAmount.add(order.feeAmount)
                : order.grossAmount.sub(order.feeAmount),
              'SPOT_NET',
              id,
              order.id,
            );
            if (
              legs.length !== 1 ||
              legs[0].txType !==
                (order.side === 'buy' ? 'order_buy' : 'order_sell') ||
              legs[0].direction !==
                (order.side === 'buy' ? 'debit' : 'credit') ||
              !legs[0].amount.eq(order.netAmount) ||
              wallets.find((w) => w.id === legs[0]?.walletId)?.walletScope !==
                order.cashWalletScope
            )
              add('SPOT_LEDGER_LEGS_DUPLICATE_OR_MISSING', id, order.id);
            const state = positionState.get(order.assetId) ?? {
              quantity: d(0),
              averageCost: d(0),
              pnl: d(0),
              pnlKrw: d(0),
            };
            if (order.side === 'buy') {
              state.averageCost = round(
                state.averageCost
                  .mul(state.quantity)
                  .add(order.netAmount)
                  .div(state.quantity.add(qty)),
              );
              state.quantity = round(state.quantity.add(qty));
            } else {
              const pnl = round(
                order.netAmount.sub(round(state.averageCost.mul(qty))),
              );
              state.pnl = round(state.pnl.add(pnl));
              state.pnlKrw = round(
                state.pnlKrw.add(
                  order.currencyCode === 'KRW'
                    ? pnl
                    : round(pnl.mul(order.fxRateSnapshot?.rate ?? 0)),
                ),
              );
              state.quantity = round(state.quantity.sub(qty));
              if (state.quantity.lt(0))
                add('SPOT_NEGATIVE_POSITION_RECONSTRUCTION', id, order.id);
            }
            positionState.set(order.assetId, state);
          }
          for (const position of positionRows) {
            const state = positionState.get(position.assetId);
            if (!state) {
              add('POSITION_WITHOUT_EXECUTION', id, position.id);
              continue;
            }
            equal(
              position.quantity,
              state.quantity,
              'SPOT_POSITION_QUANTITY',
              id,
              position.id,
            );
            equal(
              position.averageCost,
              state.averageCost,
              'SPOT_AVERAGE_COST',
              id,
              position.id,
            );
            equal(
              position.realizedPnl,
              state.pnl,
              'SPOT_REALIZED_PNL',
              id,
              position.id,
            );
            equal(
              position.realizedPnlKrw,
              state.pnlKrw,
              'SPOT_REALIZED_PNL_KRW',
              id,
              position.id,
            );
            const reserved = orders
              .filter(
                (o) =>
                  o.status === 'submitted' &&
                  o.side === 'sell' &&
                  o.assetId === position.assetId,
              )
              .reduce((s, o) => s.add(o.reservedQuantity ?? 0), d(0));
            // Registration reserves nothing; only a triggered Limit child
            // appears in submitted SELL orders (the existing reservation rule).
            equal(
              position.reservedQuantity,
              reserved,
              'SPOT_POSITION_RESERVATION',
              id,
              position.id,
            );
          }
          for (const assetId of positionState.keys())
            if (!positionRows.some((p) => p.assetId === assetId))
              add('MISSING_SPOT_POSITION', id, assetId);
          const futures = await tx.futuresPosition.findMany({
            where: { tradingAccountId: id },
            include: {
              executions: {
                include: { lastPriceSnapshot: true },
                orderBy: [{ executedAt: 'asc' }, { createdAt: 'asc' }],
              },
              liquidationClose: { include: { liquidation: true } },
            },
          });
          const commands = await tx.futuresExecuteRequest.findMany({
            where: { tradingAccountId: id },
          });
          const api = valuations.get(id),
            fee =
              account.mode === 'season'
                ? account.seasonParticipant!.season.tradeFeeRate
                : readGeneralTradeFeeRate({});
          const crossRows: ReturnType<typeof positionRisk>[] = [];
          let isolated = d(0);
          for (const p of futures.filter((p) => p.status === 'open')) {
            const presented = api.positions.find((row: any) => row.id === p.id);
            if (
              !presented?.markEvidence ||
              !presented.markPrice ||
              !presented.risk
            ) {
              add('MARK_VALUATION_EVIDENCE_UNAVAILABLE', id, p.id);
              continue;
            }
            const mark = await tx.futuresMarkSnapshot.findUnique({
              where: { id: presented.markEvidence.snapshotId },
            });
            if (
              !mark ||
              mark.instrumentId !== p.instrumentId ||
              !mark.price.eq(presented.markPrice)
            ) {
              add('MARK_VALUATION_SCOPE', id, p.id);
              continue;
            }
            const risk = positionRisk(p, mark.price, fee);
            equal(
              presented.markUnrealizedPnl,
              risk.unrealizedPnl,
              'MARK_UNREALIZED_PNL',
              id,
              p.id,
            );
            if (
              hash(presented.risk) !== hash(presentPositionRisk(p, risk, fee))
            )
              add('MARK_RISK_METRICS', id, p.id);
            if (p.marginMode === 'cross') crossRows.push(risk);
            else isolated = isolated.add(p.isolatedMargin);
          }
          const futuresWallet = wallets.find(
            (w) => w.walletScope === 'crypto_futures',
          )!;
          const cross = crossRisk(futuresWallet, isolated, crossRows);
          equal(
            api.collateral.balanceAmount,
            futuresWallet.balanceAmount,
            'FUTURES_COLLATERAL_BALANCE',
            id,
          );
          equal(
            api.collateral.totalMarginUsed,
            isolated,
            'FUTURES_COLLATERAL_MARGIN',
            id,
          );
          equal(
            api.collateral.freeCollateral,
            cross.crossFreeCollateral,
            'FUTURES_FREE_COLLATERAL',
            id,
          );
          if (hash(api.cross.metrics) !== hash(riskStrings(cross)))
            add('CROSS_MARK_RISK_METRICS', id);
          for (const p of futures) {
            let state: any = null;
            for (const e of p.executions) {
              examinedExecutions++;
              const command = {
                instrumentId: e.instrumentId,
                positionId: e.operation === 'open' ? null : p.id,
                operation: e.operation,
                direction: e.direction,
                quantity: e.quantity.toFixed(8),
                leverage: e.leverage,
                marginMode: e.marginMode,
                idempotencyKey: 'audit-command',
              };
              const plan = planFuturesExecution(
                command,
                state,
                e.executionPrice,
                e.feeRate,
              );
              equal(e.notional, plan.notional, 'FUTURES_NOTIONAL', id, e.id);
              equal(e.feeAmount, plan.feeAmount, 'FUTURES_FEE', id, e.id);
              equal(
                e.realizedPnl,
                plan.realizedPnl,
                'FUTURES_REALIZED_PNL',
                id,
                e.id,
              );
              equal(
                e.positionQuantityAfter,
                plan.quantity,
                'FUTURES_QUANTITY_AFTER',
                id,
                e.id,
              );
              equal(
                e.averageEntryPriceAfter,
                plan.averageEntryPrice,
                'FUTURES_AVERAGE_AFTER',
                id,
                e.id,
              );
              equal(
                e.isolatedMarginAfter,
                plan.isolatedMargin,
                'FUTURES_MARGIN_AFTER',
                id,
                e.id,
              );
              if (
                !e.lastPriceSnapshot ||
                e.lastPriceSnapshot.instrumentId !== e.instrumentId ||
                !e.lastPriceSnapshot.price.eq(e.executionPrice) ||
                e.priceSourceName !== e.lastPriceSnapshot.source ||
                +e.priceCapturedAt !== +e.lastPriceSnapshot.capturedAt ||
                +e.priceEffectiveAt !== +e.lastPriceSnapshot.effectiveAt
              )
                add('FUTURES_LAST_EXECUTION_EVIDENCE', id, e.id);
              const linked = commands.filter((c) => c.executionId === e.id),
                entry = entries.find((l) => l.executionId === e.id),
                child = groups
                  .flatMap((g) => g.children)
                  .find((ch) => ch.futuresExecutionId === e.id);
              // Conditional executions also persist the normal durable execute
              // request with key protection:<child.id>. It is one financial
              // commit with TWO ownership links, not two executions.
              if (
                entry
                  ? linked.length !== 0 || !!child
                  : linked.length !== 1 ||
                    (child &&
                      (linked[0]?.idempotencyKey !== `protection:${child.id}` ||
                        child.status !== 'filled'))
              )
                add('FUTURES_COMMAND_EXECUTION_LINK', id, e.id);
              if (linked.length === 1) {
                const parsed = parseFuturesCommand({
                  ...command,
                  positionId: command.positionId ?? undefined,
                  idempotencyKey: linked[0].idempotencyKey,
                });
                if (futuresCommandHash(id, parsed) !== linked[0].requestHash)
                  add('FUTURES_IDEMPOTENCY_HASH', id, e.id);
              }
              const legs = ledger.filter(
                (l) =>
                  l.referenceType === 'futures_execution' &&
                  l.referenceId === e.id,
              );
              const expected = plan.realizedPnl.eq(0) ? 1 : 2;
              if (
                legs.length !== expected ||
                legs.filter(
                  (l) =>
                    l.txType === 'fee' &&
                    l.direction === 'debit' &&
                    l.amount.eq(e.feeAmount),
                ).length !== 1 ||
                (!e.realizedPnl.eq(0) &&
                  legs.filter(
                    (l) =>
                      l.txType === 'futures_pnl' &&
                      l.direction ===
                        (e.realizedPnl.gt(0) ? 'credit' : 'debit') &&
                      l.amount.eq(e.realizedPnl.abs()),
                  ).length !== 1)
              )
                add('FUTURES_LEDGER_DUPLICATE_OR_MISSING', id, e.id);
              state = {
                id: p.id,
                direction: p.direction,
                marginMode: p.marginMode,
                leverage: p.leverage,
                quantity: plan.quantity,
                averageEntryPrice: plan.averageEntryPrice,
                entryNotional: plan.entryNotional,
                isolatedMargin: plan.isolatedMargin,
                realizedPnl: plan.cumulativeRealizedPnl,
              };
            }
            if (!state) {
              add('FUTURES_POSITION_WITHOUT_EXECUTION', id, p.id);
              continue;
            }
            if (p.liquidationClose) {
              liquidationAccounts++;
              if (
                p.status !== 'closed' ||
                !p.quantity.eq(0) ||
                !p.isolatedMargin.eq(0)
              )
                add('LIQUIDATION_TERMINAL_POSITION', id, p.id);
              equal(
                p.realizedPnl,
                d(state.realizedPnl).add(p.liquidationClose.realizedPnl),
                'LIQUIDATION_POSITION_PNL',
                id,
                p.id,
              );
            } else {
              for (const field of [
                'quantity',
                'averageEntryPrice',
                'entryNotional',
                'isolatedMargin',
                'realizedPnl',
              ] as const)
                equal(
                  p[field],
                  state[field],
                  `FUTURES_POSITION_${field}`,
                  id,
                  p.id,
                );
              if ((p.status === 'closed') !== p.quantity.eq(0))
                add('FUTURES_LIFETIME_STATUS', id, p.id);
            }
            if (p.marginMode === 'cross' && !p.isolatedMargin.eq(0))
              add('CROSS_ISOLATED_MARGIN', id, p.id);
          }
          for (const entry of entries) {
            if ((entry.status === 'executed') !== !!entry.executionId)
              add('FUTURES_LIMIT_EXECUTION_LINK', id, entry.id);
            // Pending entries have no committed execution payload. Create replay
            // returns presentFuturesEntry(currentRow), by the existing contract.
            if (
              !entry.requestHash ||
              (entry.status === 'executed' && !entry.responsePayloadJson)
            )
              add('FUTURES_LIMIT_IDEMPOTENCY', id, entry.id);
            const attached = groups
              .find((g) => g.parentFuturesOrderId === entry.id)
              ?.legs.map((l) => ({
                kind: l.kind,
                triggerPrice: l.triggerPrice.toFixed(8),
                childOrderType: l.childOrderType,
                ...(l.childLimitPrice
                  ? { childLimitPrice: l.childLimitPrice.toFixed(8) }
                  : {}),
              }));
            const request = parseFuturesEntry({
              instrumentId: entry.instrumentId,
              direction: entry.direction,
              marginMode: entry.marginMode,
              leverage: entry.leverage,
              quantity: entry.quantity.toFixed(8),
              limitPrice: entry.limitPrice.toFixed(8),
              idempotencyKey: entry.idempotencyKey,
              ...(attached?.length ? { attachedProtection: attached } : {}),
            });
            if (
              conditionalHash({ accountId: id, ...request }) !==
              entry.requestHash
            )
              add('FUTURES_LIMIT_REQUEST_HASH', id, entry.id);
            const fee =
              futures
                .find((p) =>
                  p.executions.some((e) => e.id === entry.executionId),
                )
                ?.executions.find((e) => e.id === entry.executionId)?.feeRate ??
              (account.mode === 'season'
                ? account.seasonParticipant!.season.tradeFeeRate
                : readGeneralTradeFeeRate({}));
            const plan = planFuturesExecution(
              request,
              null,
              futuresDecimal(entry.limitPrice),
              fee,
            );
            const execution = futures
              .flatMap((p) => p.executions)
              .find((e) => e.id === entry.executionId);
            if (execution)
              latency.time(
                'acceptedToFill.futures.limit',
                Math.max(0, +execution.executedAt - +entry.createdAt),
              );
            equal(
              entry.reservedAmount,
              marginCeil(
                futuresDecimal(entry.quantity)
                  .mul(entry.limitPrice)
                  .div(entry.leverage),
              ).add(plan.feeAmount),
              'FUTURES_LIMIT_RESERVATION_FORMULA',
              id,
              entry.id,
            );
          }
          const liquidations = await tx.futuresLiquidation.findMany({
            where: { tradingAccountId: id },
            include: {
              closes: { include: { markSnapshot: true, position: true } },
            },
          });
          for (const l of liquidations) {
            const settlement = bankruptcySettlement(
              futuresDecimal(l.collateralAvailable),
              futuresDecimal(l.realizedPnl),
              futuresDecimal(l.feeAmount),
            );
            equal(
              l.settledCash,
              settlement.settledCash,
              'LIQUIDATION_SETTLED_CASH',
              id,
              l.id,
            );
            equal(
              l.walletBalanceAfter,
              l.walletBalanceBefore.add(settlement.settledCash),
              'LIQUIDATION_WALLET_DELTA',
              id,
              l.id,
            );
            equal(
              l.realizedPnl,
              l.closes.reduce((s, r) => s.add(r.realizedPnl), d(0)),
              'LIQUIDATION_PNL_SUM',
              id,
              l.id,
            );
            equal(
              l.feeAmount,
              l.closes.reduce((s, r) => s.add(r.feeAmount), d(0)),
              'LIQUIDATION_FEE_SUM',
              id,
              l.id,
            );
            for (const close of l.closes) {
              if (
                close.markSnapshot.instrumentId !== close.instrumentId ||
                !close.executionPrice.eq(close.markSnapshot.price) ||
                close.tradingAccountId !== id
              )
                add('LIQUIDATION_MARK_EVIDENCE', id, close.id);
              equal(
                close.realizedPnl,
                futuresPnl(
                  close.direction,
                  close.position.averageEntryPrice,
                  close.executionPrice,
                  close.quantity,
                ),
                'LIQUIDATION_CLOSE_PNL',
                id,
                close.id,
              );
              equal(
                close.feeAmount,
                futuresMoney(
                  futuresDecimal(close.quantity)
                    .mul(close.executionPrice)
                    .mul(close.feeRate),
                ),
                'LIQUIDATION_CLOSE_FEE',
                id,
                close.id,
              );
            }
            const legs = ledger.filter(
              (row) =>
                row.referenceType === 'futures_liquidation' &&
                row.referenceId === l.id,
            );
            const expectedLegs =
              (settlement.settledPnl.eq(0) ? 0 : 1) +
              (settlement.settledFee.eq(0) ? 0 : 1);
            if (
              legs.length !== expectedLegs ||
              (!settlement.settledPnl.eq(0) &&
                legs.filter(
                  (row) =>
                    row.txType === 'futures_pnl' &&
                    row.direction ===
                      (settlement.settledPnl.gt(0) ? 'credit' : 'debit') &&
                    row.amount.eq(settlement.settledPnl.abs()),
                ).length !== 1) ||
              (!settlement.settledFee.eq(0) &&
                legs.filter(
                  (row) =>
                    row.txType === 'fee' &&
                    row.direction === 'debit' &&
                    row.amount.eq(settlement.settledFee),
                ).length !== 1)
            )
              add('LIQUIDATION_LEDGER_LEGS', id, l.id);
            equal(
              l.settledPnl,
              settlement.settledPnl,
              'LIQUIDATION_SETTLED_PNL',
              id,
              l.id,
            );
            equal(
              l.settledFee,
              settlement.settledFee,
              'LIQUIDATION_SETTLED_FEE',
              id,
              l.id,
            );
            equal(
              l.bankruptcyShortfall,
              settlement.bankruptcyShortfall,
              'LIQUIDATION_SHORTFALL',
              id,
              l.id,
            );
          }
          const transfers = await tx.walletTransfer.findMany({
            where: { tradingAccountId: id },
          });
          for (const t of transfers) {
            const legs = ledger.filter(
              (l) =>
                l.referenceType === 'wallet_transfer' && l.referenceId === t.id,
            );
            if (
              legs.length !== 2 ||
              legs.filter(
                (l) =>
                  l.walletId === t.sourceWalletId &&
                  l.direction === 'debit' &&
                  l.amount.eq(t.amount),
              ).length !== 1 ||
              legs.filter(
                (l) =>
                  l.walletId === t.destinationWalletId &&
                  l.direction === 'credit' &&
                  l.amount.eq(t.amount),
              ).length !== 1
            )
              add('TRANSFER_LEDGER_SCOPE', id, t.id);
          }
          const exchanges = await tx.exchangeTransaction.findMany({
            where: { tradingAccountId: id },
            include: { fxRateSnapshot: true },
          });
          const composites = await tx.walletTransferExecuteRequest.findMany({
            where: { tradingAccountId: id },
          });
          for (const x of exchanges) {
            equal(
              x.grossTargetAmount,
              calculateGrossTargetAmount({
                fromCurrency: x.fromCurrency,
                toCurrency: x.toCurrency,
                sourceAmount: x.sourceAmount,
                appliedRate: x.appliedRate,
              }),
              'FX_GROSS',
              id,
              x.id,
            );
            equal(
              x.feeAmount,
              calculateFeeAmount({
                grossTargetAmount: x.grossTargetAmount,
                feeRate: x.feeRate,
              }),
              'FX_FEE',
              id,
              x.id,
            );
            equal(
              x.netTargetAmount,
              calculateNetTargetAmount({
                grossTargetAmount: x.grossTargetAmount,
                feeAmount: x.feeAmount,
              }),
              'FX_NET',
              id,
              x.id,
            );
            if (
              !x.fxRateSnapshot ||
              !x.appliedRate.eq(x.fxRateSnapshot.rate) ||
              x.feeCurrency !== x.toCurrency
            )
              add('FX_PINNING', id, x.id);
            const legs = ledger.filter(
              (l) =>
                l.referenceType === 'exchange_transaction' &&
                l.referenceId === x.id,
            );
            if (
              legs.length !== 2 ||
              legs.filter(
                (l) =>
                  l.currencyCode === x.fromCurrency &&
                  l.direction === 'debit' &&
                  l.amount.eq(x.sourceAmount),
              ).length !== 1 ||
              legs.filter(
                (l) =>
                  l.currencyCode === x.toCurrency &&
                  l.direction === 'credit' &&
                  l.amount.eq(x.netTargetAmount),
              ).length !== 1
            )
              add('FX_LEDGER_DUPLICATE_OR_MISSING', id, x.id);
          }
          for (const command of composites)
            if (
              exchanges.filter((x) => x.id === command.exchangeTransactionId)
                .length !== 1 ||
              transfers.filter((t) => t.id === command.walletTransferId)
                .length !== 1 ||
              !command.requestHash ||
              !command.responsePayloadJson
            )
              add('COMPOSITE_COMMAND_LINK', id, command.id);
          const executedIds = new Set(
            futures.flatMap((p) => p.executions.map((e) => e.id)),
          );
          if (commands.some((c) => !executedIds.has(c.executionId)))
            add('ORPHAN_FUTURES_COMMAND', id);
          for (const l of ledger) {
            const known =
              l.referenceType === 'general_account_open'
                ? l.referenceId === id && account.mode !== 'season'
                : l.referenceType === 'season_join'
                  ? l.referenceId === account.seasonParticipant?.id &&
                    account.mode === 'season'
                  : l.referenceType === 'order'
                    ? orders.some(
                        (o) =>
                          o.id === l.referenceId && o.status === 'executed',
                      )
                    : l.referenceType === 'futures_execution'
                      ? executedIds.has(l.referenceId ?? '')
                      : l.referenceType === 'wallet_transfer'
                        ? transfers.some((t) => t.id === l.referenceId)
                        : l.referenceType === 'exchange_transaction'
                          ? exchanges.some((x) => x.id === l.referenceId)
                          : l.referenceType === 'futures_liquidation'
                            ? liquidations.some((x) => x.id === l.referenceId)
                            : false;
            if (!known) add('LEDGER_ORPHAN_OR_UNEXPECTED_EVENT', id, l.id);
          }
          for (const group of groups) {
            if (
              group.tradingAccountId !== id ||
              group.children.some(
                (ch) => !group.legs.some((leg) => leg.id === ch.legId),
              )
            )
              add('PROTECTION_SCOPE', id, group.id);
            if (
              group.children.filter((ch) => ch.status === 'filled').length > 1
            )
              add('OCO_DUPLICATE_COMMIT', id, group.id);
            for (const child of group.children) {
              const execution = futures
                .flatMap((p) => p.executions)
                .find((e) => e.id === child.futuresExecutionId);
              const order = orders.find((o) => o.id === child.orderId);
              const executedAt = execution?.executedAt ?? order?.executedAt;
              if (executedAt)
                latency.time(
                  'conditional.triggeredToCommit',
                  Math.max(0, +executedAt - +child.triggeredAt),
                );
            }
          }
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 180000,
      },
    );
    const result = {
      at: new Date().toISOString(),
      verdict: findings.length ? 'CORRECTNESS FAIL' : 'CORRECTNESS PASS',
      accounts: fixture.actors.length,
      examinedOrders,
      examinedExecutions,
      examinedLedgers,
      liquidationAccounts,
      findings,
      arithmetic:
        'Existing Prisma Decimal and Futures calculation policy; exact equality, no floating point tolerance',
    };
    writeJson(resolve(out, 'audit.json'), result);
    writeJson(resolve(out, 'financial-latencies.json'), {
      ...latency.summary(),
      scope:
        'All fixture history, including preparation; accepted/create to database execution timestamp, separate from HTTP response and first market-eligibility time',
    });
    return result;
  } catch (e) {
    writeJson(resolve(out, 'audit.json'), {
      verdict: 'CORRECTNESS INCOMPLETE',
      reason: e instanceof Error ? e.name : 'AUDIT_ERROR',
      findings,
    });
    throw e;
  } finally {
    await db.$disconnect();
  }
}
