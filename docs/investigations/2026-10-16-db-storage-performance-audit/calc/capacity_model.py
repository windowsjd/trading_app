#!/usr/bin/env python3
"""Trading Class 전체 DB 용량 모델 (2026-10-16 감사).

표준 라이브러리만 쓴다. 실행: python3 -I capacity_model.py > capacity_model_output.md

값의 출처 표기
  M = 2026-10-15 운영 DB 읽기 전용 실측 (report.md §5, §17)
  D = 실측에서 계산한 값
  G = 가정 (아직 운영되지 않는 기능, 정책 미승인 값)
모든 크기는 인덱스를 포함한 "테이블 총 증가량" 기준이다 (pg_total_relation_size 증가 / 행 수).
"""

MB = 1024 * 1024
GB = 1024 * MB
DAYS_PER_MONTH = 30.4
KRX_SESSION_FACTOR = 249 / 365  # G: 2026 KRX 영업일 수 근사
US_SESSION_FACTOR = 251 / 365   # G: 2026 NYSE 영업일 수 근사

# ---------------------------------------------------------------------------
# 1. 단위 비용 (자산 1개 기준)
# ---------------------------------------------------------------------------
P = {
    # Binance Spot WS ticker -> asset_price_snapshots
    'crypto_rows_day': 14_967 * 24 / 25,  # M: 15:42-16:02Z 창 14,967행/h, 25종목 -> 14,368행/종목/일
    'crypto_row_A': 19.71 * MB / 14_967,  # M: 같은 창 +19.71 MB/h / 14,967행 = 1,381 B/행
    # B: 원문 678 B -> 슬림 120 B(G), note 89 B 제거, (source_type, effective_at) 인덱스 29 B/행 제거
    'crypto_row_B': 1_381 - 678 + 120 - 89 - 29,
    # C: B + 쓰기 throttle 메모리화 후 (asset_id, captured_at) 인덱스 115 B/행 제거
    'crypto_row_C': 1_381 - 678 + 120 - 89 - 29 - 115,
    # KOSCOM 현재가 -> asset_price_snapshots (세션당)
    'krx_price_rows_session': 87_650 / 15,  # M: TABLESAMPLE 추정 79k/99k/85k 세션 평균 / 15종목 = 5,843
    'krx_price_row_A': 695 + 45 + 348,  # M: 행 695 B + 페이지 오버헤드 45 B(D) + 인덱스 348 B/행(D)
    'krx_price_row_B': 695 - 504 + 200 + 45 + 348 - 29,  # G: 슬림 원문 200 B (KOSCOM_PRICE_RAW_SLIM_ENABLED)
    'krx_price_row_C': 695 - 504 + 200 + 45 + 348 - 29 - 115,
    # KOSCOM 호가 -> asset_orderbook_snapshots (세션당)
    'krx_book_rows_session': 115_800 / 15,  # M: 108.5k/114.6k/124.3k 평균 / 15종목 = 7,720
    'krx_book_row_A': 582.8 * MB / 352_366,  # M: 테이블 총량 / 행 수 = 1,734 B
    # 미국주식 (Tiingo 정식 또는 KIS 지연 체결) - 운영 미구현, 전부 가정
    'us_rows_session': 23_400 / 5,  # G: 정규장 6.5 h, 5 s throttle -> 4,680행/종목/세션
    'us_rows_session_ext': 57_600 / 5,  # G: 04:00-20:00 ET 16 h 저장 시 11,520행
    'us_row_A': 1_100, 'us_row_B': 650, 'us_row_C': 560,  # G: 원문 포함/슬림/인덱스 정리
    # 선물 Mark/Last (24 h 보존 정상 상태, 계약 1개)
    'fut_mark_rows_day': 0.97 * 86_400,  # M: 계약당 6 h 21,000행 -> 0.97행/s
    'fut_last_rows_day': 76_008 * 24 / 25,  # M: 76,008행/h / 25계약
    'fut_mark_row_A': 1_510.4 * MB / 2_088_213,  # M: 758 B (팽창 포함)
    'fut_last_row_A': 1_216.6 * MB / 1_665_883,  # M: 766 B
    'fut_mark_row_B': 1_510.4 * MB / 2_088_213 - 334.6 * MB / 2_088_213,  # Mark (instrument_id, effective_at) 제거
    'fut_last_row_B': 1_216.6 * MB / 1_665_883,
    'fut_row_C_factor': 0.93,  # G: uuid(7) 기본값으로 PK 팽창 감소 (PK 94 B/행 -> 약 60 B/행)
    # 캔들 (market_candles)
    'candle_row': 276.3 * MB / 448_285,  # M: 646 B/행
    'crypto_candle_rows_day': 288 + 6 + 1.2,  # 5m 288 + 4h 6 + 1d/1w
    'krx_candle_rows_session': 76 + 2 + 1.2,
    'us_candle_rows_session': 78 + 1.2,
    'index_candle_rows_session': 78 + 1.2,
    # 체크포인트/운영 로그
    'sync_row': 65.4 * MB / 145_248,  # M: 473 B/행
    'sync_rows_crypto_day': 300,  # D: 현재 7.2k/일 ~= 25종목 x 288(재조정) + 예약 동기화
    'sync_rows_stock_session': 10,  # G
    'ops_row': 25.2 * MB / 15_376,  # M: 1.72 KB/행
    'ops_rows_day_base': 3_240,  # M: 135행/h
}


def per_asset_daily_mb(kind, scen):
    """자산 1개가 달력일 1일에 추가하는 MB(보존 없이). 선물은 제외(정상 상태 크기로 따로 계산)."""
    if kind == 'crypto':
        snap = P['crypto_rows_day'] * P[f'crypto_row_{scen}']
        candle = P['crypto_candle_rows_day'] * P['candle_row']
        sync = P['sync_rows_crypto_day'] * P['sync_row']
        return (snap + candle + sync) / MB
    if kind == 'krx':
        price = P['krx_price_rows_session'] * P[f'krx_price_row_{scen}']
        book = P['krx_book_rows_session'] * P['krx_book_row_A'] if scen == 'A' else 0
        candle = P['krx_candle_rows_session'] * P['candle_row']
        sync = P['sync_rows_stock_session'] * P['sync_row']
        return (price + book + candle + sync) / MB * KRX_SESSION_FACTOR
    if kind == 'us':
        snap = P['us_rows_session'] * P[f'us_row_{scen}']
        candle = P['us_candle_rows_session'] * P['candle_row']
        sync = P['sync_rows_stock_session'] * P['sync_row']
        return (snap + candle + sync) / MB * US_SESSION_FACTOR
    if kind == 'index':  # G: 지수는 체결 스냅샷을 저장하지 않고 캔들만 저장
        return P['index_candle_rows_session'] * P['candle_row'] / MB * US_SESSION_FACTOR
    raise ValueError(kind)


def futures_steady_gb(n, scen):
    mark = P['fut_mark_rows_day'] * (P['fut_mark_row_B'] if scen in 'BC' else P['fut_mark_row_A'])
    last = P['fut_last_rows_day'] * P['fut_last_row_A']
    total = (mark + last) * n / GB
    return total * (P['fut_row_C_factor'] if scen == 'C' else 1)


# ---------------------------------------------------------------------------
# 2. 단계별 종목 구성
# ---------------------------------------------------------------------------
PHASES = [
    # name, krx, us, crypto, futures, krx_etf, us_etf, index
    ('현재 운영', 15, 0, 25, 25, 0, 0, 0),
    ('국내 70', 70, 0, 25, 25, 0, 0, 0),
    ('국내 100', 100, 0, 25, 25, 0, 0, 0),
    ('미국 100 (가정)', 15, 100, 25, 25, 0, 0, 0),
    ('현물 100', 15, 0, 100, 25, 0, 0, 0),
    ('선물 100', 15, 0, 25, 100, 0, 0, 0),
    ('ETF 30 + 지수 10', 15, 0, 25, 25, 15, 15, 10),
    ('전체 동시 운영', 100, 100, 100, 100, 15, 15, 10),
]

S0_GB = 8_457_590_451 / GB  # M: pg_database_size 2026-10-15 15:35Z
FUT0_GB = (1_510.4 + 1_216.6) / 1024  # M: 현재 선물 두 테이블
OPS_DAILY_MB = P['ops_rows_day_base'] * P['ops_row'] / MB
WAL_HEADROOM_GB = 1.5  # D: max_wal_size 1,280 MB + 아카이브 지연 여유


def daily_growth_mb(ph, scen):
    _, krx, us, crypto, _fut, ketf, uetf, idx = ph
    total = (crypto * per_asset_daily_mb('crypto', scen)
             + (krx + ketf) * per_asset_daily_mb('krx', scen)
             + (us + uetf) * per_asset_daily_mb('us', scen)
             + idx * per_asset_daily_mb('index', scen))
    return total + OPS_DAILY_MB


def c_steady_gb(ph, retention_days):
    """시나리오 C 정상 상태 논리 데이터량 (보존 기간 R일, 캔들 5m 45일/4h 180일, 로그 30일)."""
    _, krx, us, crypto, fut, ketf, uetf, idx = ph
    snap = (crypto * P['crypto_rows_day'] * P['crypto_row_C'] * retention_days
            + (krx + ketf) * P['krx_price_rows_session'] * P['krx_price_row_C'] * retention_days * KRX_SESSION_FACTOR
            + (us + uetf) * P['us_rows_session'] * P['us_row_C'] * retention_days * US_SESSION_FACTOR) / GB
    candles = (crypto * (288 * 45 + 6 * 180 + 1.2 * 365) + (krx + ketf) * (76 * 45 * KRX_SESSION_FACTOR + 2 * 180 + 365)
               + (us + uetf + idx) * (78 * 45 * US_SESSION_FACTOR + 365)) * P['candle_row'] / GB
    sync = (crypto * P['sync_rows_crypto_day'] + (krx + ketf + us + uetf) * P['sync_rows_stock_session']) * 7 * P['sync_row'] / GB
    ops = OPS_DAILY_MB * 30 / 1024
    evidence = 0.05  # G: 참조 행·일별 마지막 행·시즌 경계 행 (현재 규모에서 수십 MB)
    return snap + candles + sync + ops + evidence + futures_steady_gb(fut, 'C')


def fmt(x, d=1):
    return f'{x:,.{d}f}'


def disk_verdict(size_gb):
    out = []
    for cap in (50, 100, 150, 200):
        use = (size_gb + WAL_HEADROOM_GB) / cap
        out.append('초과' if use >= 1 else ('위험' if use >= 0.8 else ('주의' if use >= 0.6 else '적정')))
    return ' / '.join(out)


def main():
    print('# 용량 모델 출력 (calc/capacity_model.py)\n')
    print('모든 값은 모델값이다. 입력의 출처(M/D/G)는 스크립트 주석에 있다.\n')
    print('## 1. 자산 1개 단위 비용 (달력일 1일 평균, MB, 보존 없음)\n')
    print('| 유형 | A 현재 구조 | B 저위험 | C 권장(보존 전) |')
    print('|---|---:|---:|---:|')
    for k, label in (('crypto', '암호화폐 현물 1종목'), ('krx', '국내주식/국내 ETF 1종목'), ('us', '미국주식/미국 ETF 1종목 (G)'), ('index', '지수 1개 (캔들만, G)')):
        print(f'| {label} | {fmt(per_asset_daily_mb(k, "A"), 2)} | {fmt(per_asset_daily_mb(k, "B"), 2)} | {fmt(per_asset_daily_mb(k, "C"), 2)} |')
    print(f'| 선물 1계약 (24 h 정상 상태 크기, MB) | {fmt(futures_steady_gb(1, "A") * 1024, 1)} | {fmt(futures_steady_gb(1, "B") * 1024, 1)} | {fmt(futures_steady_gb(1, "C") * 1024, 1)} |')
    print()
    print('## 2. 단계별 증가량과 예상 용량 (현재 DB 8.46 GB에서 시작)\n')
    print('A·B는 가격 스냅샷 보존이 없어 계속 증가한다. C는 보존 R=14일 정상 상태(논리 데이터량)다.')
    print('디스크 판정은 50/100/150/200 GB 순서이며 WAL 여유 1.5 GB를 더해 60%·80%·100% 기준으로 표시한다.\n')
    print('| 단계 | 시나리오 | 일 증가 GB | 월 증가 GB | 3개월 GB | 6개월 GB | 12개월 GB | 선물 정상 GB | 디스크 50/100/150/200 (12개월) |')
    print('|---|---|---:|---:|---:|---:|---:|---:|---|')
    for ph in PHASES:
        for scen in ('A', 'B'):
            d = daily_growth_mb(ph, scen) / 1024
            fut = futures_steady_gb(ph[4], scen)
            base = S0_GB + (fut - FUT0_GB)
            sizes = [base + d * DAYS_PER_MONTH * m for m in (3, 6, 12)]
            print(f'| {ph[0]} | {scen} | {fmt(d, 2)} | {fmt(d * DAYS_PER_MONTH, 1)} | {fmt(sizes[0])} | {fmt(sizes[1])} | {fmt(sizes[2])} | {fmt(fut)} | {disk_verdict(sizes[2])} |')
        st = c_steady_gb(ph, 14)
        print(f'| {ph[0]} | C (R=14) | 정상 상태 | 정상 상태 | {fmt(st)} | {fmt(st)} | {fmt(st)} | {fmt(futures_steady_gb(ph[4], "C"))} | {disk_verdict(st)} |')
    print()
    print('## 3. 시나리오 C 보존 기간 민감도 (정상 상태 GB)\n')
    print('| 단계 | R=3일 | R=7일 | R=14일 | R=30일 |')
    print('|---|---:|---:|---:|---:|')
    for ph in PHASES:
        print(f'| {ph[0]} | ' + ' | '.join(fmt(c_steady_gb(ph, r)) for r in (3, 7, 14, 30)) + ' |')
    print()
    print('## 4. 현재 50 GB 디스크 소진 시점 (현재 구성, 시나리오별)\n')
    for scen in ('A', 'B'):
        d = daily_growth_mb(PHASES[0], scen) / 1024
        free = 50 - WAL_HEADROOM_GB - S0_GB
        print(f'- {scen}: 일 {fmt(d, 2)} GB 증가 -> 약 {fmt(free / d, 0)}일 후 50 GB 도달 (80% 도달은 약 {fmt((40 - WAL_HEADROOM_GB - S0_GB) / d, 0)}일)')
    print(f'- C: 정상 상태 {fmt(c_steady_gb(PHASES[0], 14))} GB (R=14) -> 50 GB로 장기 운영 가능')
    print()
    print('## 5. 미국주식 저장 시간 민감도 (G)\n')
    for scen in ('A', 'C'):
        reg = P['us_rows_session'] * P[f'us_row_{scen}'] * 100 / GB
        ext = P['us_rows_session_ext'] * P[f'us_row_{scen}'] * 100 / GB
        print(f'- {scen}: 100종목 정규장만 {fmt(reg, 2)} GB/세션, 장전·장후 포함 {fmt(ext, 2)} GB/세션')


if __name__ == '__main__':
    main()
