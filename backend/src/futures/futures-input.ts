import { HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  Prisma,
  type FuturesDirection,
  type FuturesOperation,
} from '../generated/prisma/client';
import { futuresError } from './futures-error';

export type FuturesExecuteBody = {
  instrumentId?: unknown;
  positionId?: unknown;
  operation?: unknown;
  direction?: unknown;
  quantity?: unknown;
  leverage?: unknown;
  marginMode?: unknown;
  idempotencyKey?: unknown;
};
export type FuturesCommand = {
  instrumentId: string;
  positionId: string | null;
  operation: FuturesOperation;
  direction: FuturesDirection;
  quantity: string;
  leverage: number;
  marginMode?: 'isolated' | 'cross';
  idempotencyKey: string;
};

export function assertFuturesLeverage(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100
  )
    futuresError(
      'INVALID_FUTURES_LEVERAGE',
      'Leverage must be an integer from 1 through 100.',
      HttpStatus.BAD_REQUEST,
    );
}

export function parseFuturesCommand(body: FuturesExecuteBody): FuturesCommand {
  const allowed = [
    'instrumentId',
    'positionId',
    'operation',
    'direction',
    'quantity',
    'leverage',
    'marginMode',
    'idempotencyKey',
  ];
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    invalid();
  assertFuturesLeverage(body.leverage);
  if (
    body.marginMode !== undefined &&
    !['isolated', 'cross'].includes(body.marginMode as string)
  )
    invalid();
  const text = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';
  const instrumentId = text(body.instrumentId);
  const positionId = text(body.positionId) || null;
  const idempotencyKey = text(body.idempotencyKey);
  const quantity = text(body.quantity);
  if (
    !instrumentId ||
    instrumentId.length > 200 ||
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    typeof body.operation !== 'string' ||
    !['open', 'increase', 'reduce', 'close'].includes(body.operation) ||
    typeof body.direction !== 'string' ||
    !['long', 'short'].includes(body.direction) ||
    !/^\d{1,16}(\.\d{1,8})?$/.test(quantity) ||
    new Prisma.Decimal(quantity).lte(0) ||
    (body.operation === 'open'
      ? body.positionId !== undefined
      : !positionId || positionId.length > 200)
  )
    invalid();
  return {
    instrumentId,
    positionId,
    idempotencyKey,
    operation: body.operation as FuturesOperation,
    direction: body.direction as FuturesDirection,
    quantity: new Prisma.Decimal(quantity).toFixed(8),
    leverage: body.leverage,
    marginMode: (body.marginMode ?? 'isolated') as 'isolated' | 'cross',
  };
}

export function futuresCommandHash(accountId: string, command: FuturesCommand) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 'futures-execute:v1',
        accountId,
        instrumentId: command.instrumentId,
        positionId: command.positionId,
        operation: command.operation,
        direction: command.direction,
        quantity: command.quantity,
        leverage: command.leverage,
        // Preserve the exact F1 isolated hash, including committed replay.
        ...(command.marginMode === 'cross' ? { marginMode: 'cross' } : {}),
      }),
    )
    .digest('hex');
}

function invalid(): never {
  futuresError(
    'INVALID_FUTURES_COMMAND',
    'Check the instrument, operation, direction, quantity, leverage and position.',
    HttpStatus.BAD_REQUEST,
  );
}
