import { Prisma } from '../../generated/prisma/client';
import { ProviderHttpError } from '../provider.types';
import {
  KIS_DEFAULT_DOMESTIC_TRADE_TR_ID,
  KIS_DEFAULT_OVERSEAS_DELAYED_TRADE_TR_ID,
  type KisWebSocketParsedMessage,
  type KisWebSocketTradeTick,
} from './kis-websocket.types';
import { normalizeKisUsMarketCode } from './kis-websocket.subscription';

const KIS_DOMESTIC_TRADE_FIELDS = [
  'MKSC_SHRN_ISCD',
  'STCK_CNTG_HOUR',
  'STCK_PRPR',
  'PRDY_VRSS_SIGN',
  'PRDY_VRSS',
  'PRDY_CTRT',
  'WGHN_AVRG_STCK_PRC',
  'STCK_OPRC',
  'STCK_HGPR',
  'STCK_LWPR',
  'ASKP1',
  'BIDP1',
  'CNTG_VOL',
  'ACML_VOL',
  'ACML_TR_PBMN',
  'SELN_CNTG_CSNU',
  'SHNU_CNTG_CSNU',
  'NTBY_CNTG_CSNU',
  'CTTR',
  'SELN_CNTG_SMTN',
  'SHNU_CNTG_SMTN',
  'CCLD_DVSN',
  'SHNU_RATE',
  'PRDY_VOL_VRSS_ACML_VOL_RATE',
  'OPRC_HOUR',
  'OPRC_VRSS_PRPR_SIGN',
  'OPRC_VRSS_PRPR',
  'HGPR_HOUR',
  'HGPR_VRSS_PRPR_SIGN',
  'HGPR_VRSS_PRPR',
  'LWPR_HOUR',
  'LWPR_VRSS_PRPR_SIGN',
  'LWPR_VRSS_PRPR',
  'BSOP_DATE',
  'NEW_MKOP_CLS_CODE',
  'TRHT_YN',
  'ASKP_RSQN1',
  'BIDP_RSQN1',
  'TOTAL_ASKP_RSQN',
  'TOTAL_BIDP_RSQN',
  'VOL_TNRT',
  'PRDY_SMNS_HOUR_ACML_VOL',
  'PRDY_SMNS_HOUR_ACML_VOL_RATE',
  'HOUR_CLS_CODE',
  'MRKT_TRTM_CLS_CODE',
  'VI_STND_PRC',
] as const;

const KIS_OVERSEAS_DELAYED_TRADE_FIELDS = [
  'RSYM',
  'SYMB',
  'ZDIV',
  'TYMD',
  'XYMD',
  'XHMS',
  'KYMD',
  'KHMS',
  'OPEN',
  'HIGH',
  'LOW',
  'LAST',
  'SIGN',
  'DIFF',
  'RATE',
  'PBID',
  'PASK',
  'VBID',
  'VASK',
  'EVOL',
  'TVOL',
  'TAMT',
  'BIVL',
  'ASVL',
  'STRN',
  'MTYP',
] as const;

export function parseKisWebSocketMessage(input: {
  frame: string;
  receivedAt: Date;
}): KisWebSocketParsedMessage {
  const rawFrame = input.frame;
  const frame = rawFrame.trim();
  if (!frame) {
    return failed(
      'INVALID_FRAME',
      'KIS WebSocket frame is empty.',
      null,
      input,
    );
  }

  if (frame.startsWith('{')) {
    return parseJsonAck(frame, input.receivedAt);
  }

  const [encryptedFlag, trId, countText, data] = splitTradeFrame(frame);
  if (!encryptedFlag || !trId || !countText || data === undefined) {
    return failed(
      'INVALID_FRAME',
      'KIS WebSocket frame does not match flag|TR_ID|COUNT|DATA.',
      trId ?? null,
      input,
    );
  }

  if (encryptedFlag === '1') {
    return {
      state: 'skipped',
      reason: 'ENCRYPTED_PAYLOAD_NOT_SUPPORTED',
      trId,
      rawFrame,
      receivedAt: input.receivedAt,
    };
  }

  if (encryptedFlag !== '0') {
    return failed(
      'UNSUPPORTED_ENCRYPTION_FLAG',
      'KIS WebSocket frame encryption flag is unsupported.',
      trId,
      input,
    );
  }

  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count <= 0) {
    return failed(
      'INVALID_RECORD_COUNT',
      'KIS WebSocket frame count must be a positive integer.',
      trId,
      input,
    );
  }

  if (trId === KIS_DEFAULT_DOMESTIC_TRADE_TR_ID) {
    return parseTradeRecords({
      trId,
      count,
      data,
      receivedAt: input.receivedAt,
      rawFrame,
      fieldNames: KIS_DOMESTIC_TRADE_FIELDS,
      parseRecord: parseDomesticTradeRecord,
    });
  }

  if (trId === KIS_DEFAULT_OVERSEAS_DELAYED_TRADE_TR_ID) {
    return parseTradeRecords({
      trId,
      count,
      data,
      receivedAt: input.receivedAt,
      rawFrame,
      fieldNames: KIS_OVERSEAS_DELAYED_TRADE_FIELDS,
      parseRecord: parseOverseasDelayedTradeRecord,
    });
  }

  return {
    state: 'skipped',
    reason: 'UNSUPPORTED_TR_ID',
    trId,
    rawFrame,
    receivedAt: input.receivedAt,
  };
}

function splitTradeFrame(
  frame: string,
): [
  encryptedFlag: string | undefined,
  trId: string | undefined,
  countText: string | undefined,
  data: string | undefined,
] {
  const first = frame.indexOf('|');
  const second = first >= 0 ? frame.indexOf('|', first + 1) : -1;
  const third = second >= 0 ? frame.indexOf('|', second + 1) : -1;
  if (first < 0 || second < 0 || third < 0) {
    return [undefined, undefined, undefined, undefined];
  }

  return [
    frame.slice(0, first),
    frame.slice(first + 1, second),
    frame.slice(second + 1, third),
    frame.slice(third + 1),
  ];
}

function parseJsonAck(
  frame: string,
  receivedAt: Date,
): KisWebSocketParsedMessage {
  try {
    const raw = JSON.parse(frame) as {
      header?: { tr_id?: unknown };
      body?: { msg1?: unknown };
    };
    const trId =
      typeof raw.header?.tr_id === 'string' ? raw.header.tr_id : null;
    const message = typeof raw.body?.msg1 === 'string' ? raw.body.msg1 : null;

    return {
      state: 'ack',
      trId,
      message,
      raw,
      receivedAt,
    };
  } catch {
    return failed(
      'INVALID_JSON_ACK',
      'KIS WebSocket JSON ack frame is invalid JSON.',
      null,
      { frame, receivedAt },
    );
  }
}

function parseTradeRecords<
  TFieldName extends readonly string[],
  TTrade extends KisWebSocketTradeTick,
>(input: {
  trId: string;
  count: number;
  data: string;
  receivedAt: Date;
  rawFrame: string;
  fieldNames: TFieldName;
  parseRecord: (input: {
    fields: Record<TFieldName[number], string>;
    receivedAt: Date;
    rawFrame: string;
    recordIndex: number;
    trId: string;
  }) => TTrade;
}): KisWebSocketParsedMessage {
  const values = input.data.split('^');
  const fieldCount = input.fieldNames.length;
  const expected = input.count * fieldCount;

  if (values.length < expected) {
    return failed(
      'INCOMPLETE_TRADE_RECORD',
      'KIS WebSocket trade frame has fewer fields than declared count.',
      input.trId,
      {
        frame: input.rawFrame,
        receivedAt: input.receivedAt,
      },
    );
  }

  try {
    const trades: KisWebSocketTradeTick[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const offset = index * fieldCount;
      const recordValues = values.slice(offset, offset + fieldCount);
      const fields = Object.fromEntries(
        input.fieldNames.map((name, fieldIndex) => [
          name,
          recordValues[fieldIndex] ?? '',
        ]),
      ) as Record<TFieldName[number], string>;

      trades.push(
        input.parseRecord({
          fields,
          receivedAt: input.receivedAt,
          rawFrame: input.rawFrame,
          recordIndex: index,
          trId: input.trId,
        }),
      );
    }

    return {
      state: 'trades',
      trId: input.trId,
      count: input.count,
      trades,
      receivedAt: input.receivedAt,
      rawFrame: input.rawFrame,
    };
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      return failed(error.code, error.message, input.trId, {
        frame: input.rawFrame,
        receivedAt: input.receivedAt,
      });
    }

    throw error;
  }
}

function parseDomesticTradeRecord(input: {
  fields: Record<(typeof KIS_DOMESTIC_TRADE_FIELDS)[number], string>;
  receivedAt: Date;
  rawFrame: string;
  recordIndex: number;
  trId: string;
}): KisWebSocketTradeTick {
  const symbol = input.fields.MKSC_SHRN_ISCD.trim().toUpperCase();
  const price = toPositiveDecimalString(input.fields.STCK_PRPR, 'STCK_PRPR');
  const sourceTimestamp = parseKstTimestamp(
    input.fields.BSOP_DATE,
    input.fields.STCK_CNTG_HOUR,
  );

  if (!/^\d{6}$/u.test(symbol)) {
    throw new ProviderHttpError(
      'kis',
      'INVALID_KIS_DOMESTIC_SYMBOL',
      'KIS domestic trade symbol must be a 6-digit stock code.',
    );
  }

  return {
    kind: 'domestic_krx_realtime_trade',
    trId: input.trId,
    providerSymbol: symbol,
    symbol,
    price,
    sourceTimestamp,
    receivedAt: input.receivedAt,
    rawFrame: input.rawFrame,
    rawFields: input.fields,
    recordIndex: input.recordIndex,
    marketCode: 'KRX',
  };
}

function parseOverseasDelayedTradeRecord(input: {
  fields: Record<(typeof KIS_OVERSEAS_DELAYED_TRADE_FIELDS)[number], string>;
  receivedAt: Date;
  rawFrame: string;
  recordIndex: number;
  trId: string;
}): KisWebSocketTradeTick {
  const providerSymbol = input.fields.RSYM.trim().toUpperCase();
  const symbol = input.fields.SYMB.trim().toUpperCase();
  const marketCode =
    normalizeKisUsMarketCode(input.fields.MTYP) ??
    normalizeKisUsMarketCode(providerSymbol.slice(1, 4));
  const price = parseOverseasDelayedLastPrice(
    input.fields.LAST,
    input.fields.ZDIV,
  );
  const sourceTimestamp = parseKstTimestamp(
    normalizeKisDate(input.fields.KYMD),
    input.fields.KHMS,
  );

  if (!symbol) {
    throw new ProviderHttpError(
      'kis',
      'INVALID_KIS_OVERSEAS_SYMBOL',
      'KIS overseas delayed trade symbol is missing.',
    );
  }

  return {
    kind: 'us_delayed_trade',
    trId: input.trId,
    providerSymbol,
    symbol,
    price,
    sourceTimestamp,
    receivedAt: input.receivedAt,
    rawFrame: input.rawFrame,
    rawFields: input.fields,
    recordIndex: input.recordIndex,
    marketCode,
  };
}

function parseOverseasDelayedLastPrice(last: string, zdiv: string): string {
  const raw = last.trim();
  if (raw.includes('.')) {
    return toPositiveDecimalString(raw, 'LAST');
  }

  const decimals = Number(zdiv.trim());
  const divisor =
    Number.isSafeInteger(decimals) && decimals > 0
      ? new Prisma.Decimal(10).pow(decimals)
      : new Prisma.Decimal(1);

  try {
    return toPositiveDecimalString(
      new Prisma.Decimal(raw).div(divisor),
      'LAST',
    );
  } catch {
    throw new ProviderHttpError(
      'kis',
      'INVALID_DECIMAL',
      'LAST must be a positive decimal.',
    );
  }
}

function toPositiveDecimalString(
  value: string | Prisma.Decimal,
  fieldName: string,
): string {
  try {
    const decimal =
      value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    if (!decimal.isFinite() || decimal.lte(0)) {
      throw new Error();
    }

    return decimal.toFixed(8);
  } catch {
    throw new ProviderHttpError(
      'kis',
      'INVALID_DECIMAL',
      `${fieldName} must be a positive decimal.`,
    );
  }
}

function normalizeKisDate(dateText: string): string {
  const value = dateText.trim();
  if (/^\d{6}$/u.test(value)) {
    return `20${value}`;
  }

  return value;
}

function parseKstTimestamp(dateText: string, timeText: string): Date | null {
  const date = dateText.trim();
  const time = timeText.trim();
  if (!/^\d{8}$/u.test(date) || !/^\d{6}$/u.test(time)) {
    return null;
  }

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
}

function failed(
  reason: string,
  message: string,
  trId: string | null,
  input: { frame: string; receivedAt: Date },
): KisWebSocketParsedMessage {
  return {
    state: 'failed',
    reason,
    message,
    trId,
    rawFrame: input.frame,
    receivedAt: input.receivedAt,
  };
}
