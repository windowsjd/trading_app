# Binance 현물·선물 각 100종목 확대 및 호가 이력 14일 보존

2026-10-16 KST. `main` 작업 트리에서 구현했다. **커밋·push·운영 DB 변경·Migration 실행·Render 배포·운영 환경변수 변경은 하지 않았다.** 모든 DB 검증은 로컬 전용 PostgreSQL 16/17과 Redis에서 했고, 실데이터 검증은 Binance 공개 API·WebSocket만 사용했다.

## 요약

| 항목 | 결과 |
| --- | --- |
| 조사 기간 | 2026-01-01T00:00Z 포함 ~ 2026-10-16T00:00Z 미포함, 완료 UTC 일봉 288개 (**2026 YTD, 연환산 없음**) |
| 전수 조사 | 현물 USDT 511개, USDⓈ-M USDT 무기한 525개 모두 완전 집계(누락·중복 0). 요청 1,055건 전부 HTTP 200, 최대 used weight 126/min |
| 독립 검증 | Python Decimal 재계산으로 1,036개 합계·일봉·순위·정책 판정·최종 목록 전부 일치. 상위 3종목씩 분할 재조회 6/6 일치 |
| 현물 최종 | 기존 25 유지 + 신규 75 = **100** (적격 396개 중 정책 순위 상위). 경계 MARSCOIN(100위) vs MUBARAK, 차이 10,234,511.53 USDT |
| 선물 최종 | 기존 25 유지 + 신규 75 = **100** (적격 351개). 경계 SAGA(100위) vs BICO, 차이 84,541,744.98 USDT |
| Futures-only | 21개(HYPE + 신규 20). 기존 Futures-only PUMP/AAVE/BCH/FIL은 현물 순위로 선정되어 현물로 전환(같은 Asset ID) |
| 호가 이력 | 현물·선물 각 별도 테이블, (분, 상품) 기본키 1개, 60초당 최대 1행, 기존 WebSocket만 사용, 기본 OFF |
| 14일 보존 | 전용 Ops 작업, 5분 주기, 분 단위로 336시간이 지난 행만 삭제, PG16/PG17 통합 검증 PASS |
| 운영 활성화 | **로컬 구현·검증 완료, 운영 활성화는 승인 대기.** 50 GB 디스크로는 100+100 운영이 안전하지 않다(§13). |
| 검증 | 단위 325 suites / 5,312 tests PASS. 금융 DB 53/54 PASS(1개는 재실행 PASS, 환경 flake). E2E 409/409. CI Futures fixture 100+100 CORRECTNESS PASS. 호가 이력 PG16/PG17 통합 PASS. 실 Binance 77분 soak(OFF 15분 + ON 62분)에서 실시간 지연·CPU 변화 없음 |
| 주의 | 얇은 신규 현물 상당수가 기존 10초 execute 신선도 기준을 자주 넘는다(49/100종목이 1 % 초과). 백필은 REST 예산을 나눠 써야 한다. 24시간 연속 검증은 하지 않았다(§16) |


## 1. 작업 기준 Git SHA 및 조사 범위

- 시작 시 로컬 `HEAD` = `origin/main` = `ead934cd2d8941987436f8a89f4ce85f5b1ab24b`(랭킹 탭 개선), 작업 트리 clean. 새 브랜치·워크트리를 만들지 않았다.
- 기존 워크트리(`trading-app-claude`, `trading-app-futures-verify`, `trading-app-long-4h-candles`, `/tmp` prunable 6개)와 브랜치는 건드리지 않았다. 다른 세션의 로컬 PostgreSQL/Redis(55479, 55611, 56611 등)도 사용하지 않고 이 세션 전용 PG17 55951, PG16 55952, Redis 56951(조사 전용)/56952(soak)/56953(테스트)을 띄웠다.
- 조사 범위: Spot/Futures 카탈로그·정책, Asset·FuturesInstrument 등록, Spot ticker/depth10/kline, Futures Last(aggTrade)/Mark/depth10/ticker, REST coordinator, 캔들 백필·동기화, 주문·체결·지정가·TP/SL·조건부·청산·정산, 홈·마켓·지갑·포트폴리오·랭킹, 기존 스냅샷·보존 작업, 25 고정 가정, 다중 서버 소유권, `/readiness`·운영 알림, 로드 테스트 하네스·CI fixture.

## 2. 실제 코드 구조와 기존 가설의 차이

| 가설 | 실제 |
| --- | --- |
| Spot 25 / Futures 25, 독립 목록 | 맞음. Spot `BINANCE_FIXED_ASSET_UNIVERSE`, Futures `BINANCE_FUTURES_SYMBOLS`. Futures-only는 Futures−Spot 차집합으로 계산되고 이름 목록 `BINANCE_FUTURES_ONLY_ASSETS`만 수동이었다. |
| 선정 스크립트·테스트가 25 전제 | 맞음. 테스트 12개 suite(30 test), 등록 CLI의 `spot.length !== 25` 차단, catalog smoke의 고정 요약값, 로드 하네스 문서. 추가로 Spot 시드 트랜잭션이 Prisma 기본 5초 timeout이라 75건 원격 생성 시 실패 위험이 있었다. |
| 현물 가격 = Spot ticker WS | 맞음. 운영은 standalone 모드(2026-10-11 Render 설정 기록: `BINANCE_WEBSOCKET_STREAMING_ENABLED=true`, live-candle Binance OFF). ticker+depth10을 한 소켓에 구독(100종목 = 200 streams). |
| 선물 Last/Mark 분리 | 맞음. Last `@aggTrade`(체결·트리거·시즌 종료), Mark `@markPrice@1s`(평가·위험·청산), 각자 소켓. 호가·24h ticker는 표시 전용 별도 소켓 2개. |
| 호가는 메모리 + Redis Pub/Sub, DB 이력 없음 | 맞음. KOSCOM/KIS 호가만 `asset_orderbook_snapshots`에 저장(보존 정책 없음, 읽는 곳 없음). |
| 현물 가격 14일 보존 구현, 운영 활성화 별도 | 맞음(`ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED` 기본 false). 100종목에서는 이 보존을 켜지 않으면 가격 스냅샷만 하루 약 1.9 GB 증가한다(§13). |
| 선물 Mark/Last 24시간 보존 | 맞음. 100계약에서도 각 보존 작업의 삭제 용량(분당 최대 10,000행)이 유입보다 크다(실측 Mark 6,000, Last 약 3,200행/분). |
| 다중 서버 | Spot standalone 소켓과 Futures 수집기는 인스턴스마다 연결한다(live-candle 경로만 Redis 소유 lease). 호가 이력은 (분, 상품) 기본키로 중복을 막았다. |
| Spot depth 대상 갱신 | 가설에 없던 사실: Spot depth10 대상은 **소켓 연결 시점**에 DB에서 읽는다. Spot 시드 후 서비스 재시작 1회가 필요하다(ticker 가격은 매핑 TTL 30초 안에 반영). Futures는 30초 주기로 대상을 다시 읽어 스스로 재구독한다. |

## 3. 현물 전체 조사 결과 및 순수 TOP 100

- 출처: 공식 Spot `GET /api/v3/klines?interval=1d&limit=1000`(weight 2), `GET /api/v3/exchangeInfo`, 분류는 Binance 공식 공개 asset metadata(`/bapi/asset/v2/public/asset/asset/get-all-asset`).
- 후보: `quoteAsset=USDT`, `status=TRADING`, 기존 `hasSpotPermission`(isSpotTradingAllowed / permissions / permissionSets) — **511개**. 전부 첫 일봉부터 2026-10-15까지 빈 날 없음, 중복 없음.
- 합계: 전체 1,884,010,272,548.36556349 USDT. 정책 적격 396개, 제외 115개.
- 수집 2026-10-16T06:36:41Z~06:53:39Z, 최종 exchangeInfo 재검증 포함. 원본 해시: [result.json](evidence/research/result.json) `hashes`, 개별 일봉 SHA-256은 CSV의 `payloadSha256`.

판정: "기존 유지" = 기존 25, "신규 선정" = 이번 75, "적격·미선정" = 정책은 충족하나 75개 밖, "제외" = 정책 제외.

| 순위 | 심볼 | 이름 | YTD 거래대금 (USDT) | 일봉 | 판정 |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | USDCUSDT | USDC | 528,038,262,418.95 | 288 | 제외: 스테이블코인 |
| 2 | BTCUSDT | Bitcoin | 381,126,869,350.55 | 288 | 기존 유지 |
| 3 | ETHUSDT | Ethereum | 221,066,329,839.68 | 288 | 기존 유지 |
| 4 | SOLUSDT | Solana | 71,900,897,201.88 | 288 | 기존 유지 |
| 5 | XRPUSDT | XRP | 48,354,506,941.46 | 288 | 기존 유지 |
| 6 | USD1USDT | World Liberty Financial USD | 48,274,193,876.81 | 288 | 제외: 스테이블코인 |
| 7 | ZECUSDT | Zcash | 37,178,340,722.15 | 288 | 기존 유지 |
| 8 | BNBUSDT | BNB | 27,653,299,103.68 | 288 | 기존 유지 |
| 9 | DOGEUSDT | Dogecoin | 22,903,913,938.85 | 288 | 기존 유지 |
| 10 | NEARUSDT | NEAR Protocol | 15,318,106,124.12 | 288 | 기존 유지 |
| 11 | SUIUSDT | Sui | 14,267,649,689.04 | 288 | 기존 유지 |
| 12 | FDUSDUSDT | First Digital USD | 12,354,704,566.06 | 288 | 제외: 스테이블코인 |
| 13 | PAXGUSDT | PAX Gold | 11,770,267,970.94 | 288 | 제외: 상품가격 연동 |
| 14 | TRXUSDT | TRON | 10,913,400,902.10 | 288 | 기존 유지 |
| 15 | PEPEUSDT | Pepe | 10,493,872,309.10 | 288 | 기존 유지 |
| 16 | NIGHTUSDT | Midnight | 10,061,241,426.26 | 219 | 기존 유지 |
| 17 | ADAUSDT | Cardano | 10,039,665,262.14 | 288 | 기존 유지 |
| 18 | TAOUSDT | Bittensor | 9,849,304,842.47 | 288 | 기존 유지 |
| 19 | RLUSDUSDT | Ripple USD | 9,600,141,040.17 | 267 | 제외: 스테이블코인 |
| 20 | WLDUSDT | Worldcoin | 9,297,602,512.96 | 288 | 기존 유지 |
| 21 | LINKUSDT | ChainLink | 7,823,747,447.88 | 288 | 기존 유지 |
| 22 | UNIUSDT | Uniswap | 7,512,063,138.42 | 288 | 기존 유지 |
| 23 | ENAUSDT | Ethena | 7,284,982,045.94 | 288 | 기존 유지 |
| 24 | AVAXUSDT | Avalanche | 7,170,880,075.60 | 288 | 기존 유지 |
| 25 | XAUTUSDT | Tether Gold | 6,443,950,747.97 | 204 | 제외: 상품가격 연동 |
| 26 | LTCUSDT | Litecoin | 6,038,007,183.27 | 288 | 기존 유지 |
| 27 | UUSDT | United Stables | 5,837,730,888.24 | 276 | 제외: 스테이블코인 |
| 28 | EURUSDT | Euro | 5,641,549,909.38 | 288 | 제외: 법정화폐 |
| 29 | XLMUSDT | Stellar Lumens | 5,527,833,131.61 | 288 | 기존 유지 |
| 30 | CHIPUSDT | USD.AI | 5,380,396,062.74 | 178 | 기존 유지 |
| 31 | PUMPUSDT | Pump.Fun | 5,220,843,190.90 | 288 | 신규 선정 |
| 32 | TRUMPUSDT | OFFICIAL TRUMP | 4,837,925,359.87 | 288 | 기존 유지 |
| 33 | ASTERUSDT | Aster | 4,745,839,119.30 | 288 | 기존 유지 |
| 34 | XPLUSDT | Plasma | 4,740,341,803.90 | 288 | 신규 선정 |
| 35 | AAVEUSDT | Aave | 4,679,395,456.31 | 288 | 신규 선정 |
| 36 | BCHUSDT | Bitcoin Cash | 4,588,698,627.72 | 288 | 신규 선정 |
| 37 | DASHUSDT | Dash | 4,430,142,859.55 | 288 | 신규 선정 |
| 38 | 币安人生USDT | 币安人生 | 4,396,623,114.19 | 282 | 기존 유지 |
| 39 | REUSDT | Re | 4,146,464,049.42 | 120 | 신규 선정 |
| 40 | SENTUSDT | Sentient | 4,094,137,365.75 | 267 | 신규 선정 |
| 41 | ONDOUSDT | Ondo | 3,873,588,828.76 | 288 | 신규 선정 |
| 42 | FETUSDT | Artificial Superintelligence Alliance | 3,825,746,462.81 | 288 | 신규 선정 |
| 43 | PENGUUSDT | Pudgy Penguins | 3,550,873,773.97 | 288 | 신규 선정 |
| 44 | HBARUSDT | Hedera Hashgraph | 3,513,328,780.54 | 288 | 신규 선정 |
| 45 | FILUSDT | Filecoin | 3,330,545,564.74 | 288 | 신규 선정 |
| 46 | ARBUSDT | Arbitrum | 3,253,179,412.38 | 288 | 신규 선정 |
| 47 | ZAMAUSDT | ZAMA | 3,189,902,484.39 | 256 | 신규 선정 |
| 48 | WLFIUSDT | World Liberty Financial | 2,972,239,933.22 | 288 | 신규 선정 |
| 49 | FOGOUSDT | FOGO | 2,754,326,450.33 | 274 | 신규 선정 |
| 50 | ICPUSDT | Internet Computer | 2,753,018,932.71 | 288 | 신규 선정 |
| 51 | SNDKBUSDT | SanDisk (bStocks) | 2,726,794,341.80 | 127 | 제외: 토큰화 주식·ETF |
| 52 | DOTUSDT | Polkadot | 2,681,620,849.43 | 288 | 신규 선정 |
| 53 | KITEUSDT | KITE | 2,523,037,852.14 | 288 | 신규 선정 |
| 54 | SPCXBUSDT | SpaceX (bStocks) | 2,503,385,717.94 | 126 | 제외: 토큰화 주식·ETF |
| 55 | OPNUSDT | OPINION | 2,499,532,829.16 | 225 | 신규 선정 |
| 56 | APTUSDT | Aptos | 2,338,111,129.97 | 288 | 신규 선정 |
| 57 | VIRTUALUSDT | Virtuals Protocol | 2,287,451,131.14 | 288 | 신규 선정 |
| 58 | ALLOUSDT | Allora | 2,260,909,774.17 | 288 | 신규 선정 |
| 59 | INJUSDT | Injective | 2,240,028,770.97 | 288 | 신규 선정 |
| 60 | ZROUSDT | LayerZero | 2,217,929,243.05 | 288 | 신규 선정 |
| 61 | RENDERUSDT | Render | 2,084,849,140.63 | 288 | 신규 선정 |
| 62 | BONKUSDT | Bonk | 1,974,991,082.19 | 288 | 신규 선정 |
| 63 | SHIBUSDT | SHIBA INU | 1,926,522,829.48 | 288 | 신규 선정 |
| 64 | BANKUSDT | Lorenzo Protocol | 1,912,390,485.27 | 288 | 신규 선정 |
| 65 | GIGGLEUSDT | Giggle Fund | 1,882,565,800.11 | 288 | 신규 선정 |
| 66 | DEXEUSDT | DeXe | 1,863,670,061.83 | 288 | 신규 선정 |
| 67 | POLUSDT | Polygon Ecosystem Token | 1,850,643,658.11 | 288 | 신규 선정 |
| 68 | QNTUSDT | Quant | 1,835,986,758.11 | 288 | 신규 선정 |
| 69 | XUSDUSDT | XUSD | 1,777,554,717.51 | 288 | 제외: 스테이블코인 |
| 70 | BARDUSDT | Lombard | 1,723,100,022.55 | 288 | 신규 선정 |
| 71 | WIFUSDT | Dogwifhat | 1,693,680,011.24 | 288 | 신규 선정 |
| 72 | TUTUSDT | Tutorial | 1,664,932,676.30 | 288 | 신규 선정 |
| 73 | AXSUSDT | Axie Infinity | 1,647,427,502.94 | 288 | 신규 선정 |
| 74 | MEGAUSDT | MEGA | 1,603,524,398.92 | 169 | 신규 선정 |
| 75 | SEIUSDT | Sei | 1,597,000,749.20 | 288 | 신규 선정 |
| 76 | ENSOUSDT | Enso | 1,573,152,461.99 | 288 | 신규 선정 |
| 77 | BREVUSDT | Brevis | 1,560,272,452.95 | 283 | 신규 선정 |
| 78 | ORDIUSDT | ORDI | 1,538,058,804.37 | 288 | 신규 선정 |
| 79 | STRKUSDT | Starknet Token | 1,528,742,275.15 | 288 | 신규 선정 |
| 80 | STOUSDT | StakeStone | 1,524,079,807.03 | 288 | 신규 선정 |
| 81 | ZENUSDT | Horizen | 1,521,255,397.31 | 288 | 신규 선정 |
| 82 | SAHARAUSDT | Sahara AI | 1,503,960,108.28 | 288 | 신규 선정 |
| 83 | OPUSDT | Optimism | 1,488,003,414.21 | 288 | 신규 선정 |
| 84 | BABYUSDT | Babylon | 1,447,733,289.66 | 288 | 신규 선정 |
| 85 | BIOUSDT | Bio Protocol | 1,439,382,819.25 | 288 | 신규 선정 |
| 86 | ROBOUSDT | Fabric Protocol | 1,406,290,104.80 | 226 | 신규 선정 |
| 87 | CHZUSDT | Chiliz | 1,401,458,305.60 | 288 | 신규 선정 |
| 88 | TIAUSDT | Celestia | 1,375,670,569.92 | 288 | 신규 선정 |
| 89 | SPKUSDT | Spark | 1,325,679,071.12 | 288 | 신규 선정 |
| 90 | GRAMUSDT | Gram | 1,321,583,450.99 | 106 | 신규 선정 |
| 91 | CRCLBUSDT | Circle Internet Group (bStocks) | 1,306,621,982.02 | 127 | 제외: 토큰화 주식·ETF |
| 92 | PYTHUSDT | Pyth Network | 1,298,782,281.99 | 288 | 신규 선정 |
| 93 | LUNCUSDT | Terra Classic | 1,275,522,461.43 | 288 | 신규 선정 |
| 94 | PENDLEUSDT | Pendle | 1,269,314,920.44 | 288 | 신규 선정 |
| 95 | CRVUSDT | Curve | 1,262,350,876.24 | 288 | 신규 선정 |
| 96 | PROMUSDT | Prometeus | 1,246,395,296.10 | 288 | 신규 선정 |
| 97 | PLUMEUSDT | PLUME | 1,223,656,266.14 | 288 | 신규 선정 |
| 98 | ETHFIUSDT | ether.fi | 1,221,746,066.92 | 288 | 신규 선정 |
| 99 | AEROUSDT | Aerodrome | 1,212,896,918.73 | 91 | 신규 선정 |
| 100 | SAGAUSDT | Saga | 1,194,646,928.87 | 288 | 신규 선정 |

## 4. 선물 전체 조사 결과 및 순수 TOP 100

- 출처: 공식 USDⓈ-M `GET /fapi/v1/klines?interval=1d&limit=499`(weight 2), `GET /fapi/v1/exchangeInfo`. Mark·OI·24h 거래대금으로 대체하지 않았다.
- 후보: `PERPETUAL`·`TRADING`·`quoteAsset=USDT`·`marginAsset=USDT` **525개**(COIN 523, INDEX 2). 상장일(`onboardDate`) 이후 빈 날 없음.
- 합계 10,589,602,041,164.04648778 USDT. 정책 적격 351개, 제외 174개. COIN만의 TOP 100은 [result.json](evidence/research/result.json) `futures.binanceTop100Coin`(INDEX 2개는 100위 밖이라 목록 동일).

| 순위 | 심볼 | 이름 | YTD 거래대금 (USDT) | 일봉 | 판정 |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | BTCUSDT | Bitcoin | 3,353,259,068,826.82 | 288 | 기존 유지 |
| 2 | ETHUSDT | Ethereum | 2,693,065,373,139.55 | 288 | 기존 유지 |
| 3 | SOLUSDT | Solana | 574,112,119,433.31 | 288 | 기존 유지 |
| 4 | ZECUSDT | Zcash | 279,893,971,457.95 | 288 | 기존 유지 |
| 5 | XRPUSDT | XRP | 251,220,263,641.94 | 288 | 기존 유지 |
| 6 | HYPEUSDT | Hyperliquid | 185,028,758,089.00 | 288 | 기존 유지 |
| 7 | DOGEUSDT | Dogecoin | 148,428,817,660.70 | 288 | 기존 유지 |
| 8 | BNBUSDT | BNB | 109,401,285,625.56 | 288 | 기존 유지 |
| 9 | 1000PEPEUSDT | 1000PEPE | 86,708,850,291.13 | 288 | 제외: 동일 심볼 현물 없음 |
| 10 | SUIUSDT | Sui | 68,181,096,158.52 | 288 | 기존 유지 |
| 11 | NEARUSDT | NEAR Protocol | 67,412,389,059.15 | 288 | 기존 유지 |
| 12 | RIVERUSDT | RIVER | 63,185,036,617.80 | 288 | 제외: 동일 심볼 현물 없음 |
| 13 | ADAUSDT | Cardano | 56,814,656,219.13 | 288 | 기존 유지 |
| 14 | LABUSDT | LAB | 52,619,548,802.47 | 288 | 제외: 동일 심볼 현물 없음 |
| 15 | WLDUSDT | Worldcoin | 52,146,695,143.15 | 288 | 기존 유지 |
| 16 | TAOUSDT | Bittensor | 48,393,460,835.57 | 288 | 기존 유지 |
| 17 | ENAUSDT | Ethena | 45,821,906,822.12 | 288 | 기존 유지 |
| 18 | PAXGUSDT | PAX Gold | 41,827,465,136.59 | 288 | 제외: 상품가격 연동 |
| 19 | LINKUSDT | ChainLink | 39,934,418,247.86 | 288 | 기존 유지 |
| 20 | AVAXUSDT | Avalanche | 38,585,343,531.40 | 288 | 기존 유지 |
| 21 | RAVEUSDT | RAVE | 37,417,356,782.71 | 288 | 제외: 동일 심볼 현물 없음 |
| 22 | UNIUSDT | Uniswap | 37,218,363,086.34 | 288 | 기존 유지 |
| 23 | PUMPUSDT | Pump.Fun | 36,904,545,670.51 | 288 | 기존 유지 |
| 24 | BCHUSDT | Bitcoin Cash | 35,300,826,192.32 | 288 | 기존 유지 |
| 25 | TRUMPUSDT | OFFICIAL TRUMP | 33,777,575,225.62 | 288 | 기존 유지 |
| 26 | SIRENUSDT | SIREN | 32,713,961,420.66 | 288 | 제외: 동일 심볼 현물 없음 |
| 27 | FILUSDT | Filecoin | 31,629,465,650.37 | 288 | 기존 유지 |
| 28 | PIPPINUSDT | PIPPIN | 27,988,983,851.15 | 288 | 제외: 동일 심볼 현물 없음 |
| 29 | AAVEUSDT | Aave | 27,852,383,882.26 | 288 | 기존 유지 |
| 30 | LTCUSDT | Litecoin | 25,525,065,329.04 | 288 | 기존 유지 |
| 31 | ASTERUSDT | Aster | 24,016,442,924.61 | 288 | 기존 유지 |
| 32 | XLMUSDT | Stellar Lumens | 23,602,958,251.05 | 288 | 기존 유지 |
| 33 | DASHUSDT | Dash | 23,216,494,565.95 | 288 | 신규 선정 |
| 34 | ONDOUSDT | Ondo | 23,139,858,057.31 | 288 | 신규 선정 |
| 35 | DOTUSDT | Polkadot | 22,553,226,751.19 | 288 | 신규 선정 |
| 36 | AKEUSDT | AKE | 21,940,473,101.77 | 288 | 제외: 동일 심볼 현물 없음 |
| 37 | BEATUSDT | BEAT | 21,382,952,514.02 | 288 | 제외: 동일 심볼 현물 없음 |
| 38 | ARBUSDT | Arbitrum | 19,945,256,589.60 | 288 | 신규 선정 |
| 39 | BANKUSDT | Lorenzo Protocol | 18,918,996,461.84 | 288 | 신규 선정 |
| 40 | PENGUUSDT | Pudgy Penguins | 18,068,806,699.69 | 288 | 신규 선정 |
| 41 | 币安人生USDT | 币安人生 | 17,383,191,273.34 | 288 | 제외: 계약 identity 정책 |
| 42 | AXSUSDT | Axie Infinity | 17,020,033,376.43 | 288 | 신규 선정 |
| 43 | XMRUSDT | Monero | 16,845,858,655.29 | 288 | 제외: 동일 심볼 현물 없음 |
| 44 | XPLUSDT | Plasma | 16,070,105,154.40 | 288 | 신규 선정 |
| 45 | LITUSDT | Litentry | 16,004,673,851.79 | 288 | 제외: 동일 심볼 현물 없음 |
| 46 | BSBUSDT | BSB | 15,908,290,021.40 | 205 | 제외: 동일 심볼 현물 없음 |
| 47 | FARTCOINUSDT | Fartcoin | 15,894,657,993.52 | 288 | 제외: 동일 심볼 현물 없음 |
| 48 | WLFIUSDT | World Liberty Financial | 14,868,932,823.16 | 288 | 신규 선정 |
| 49 | BTWUSDT | BTW | 14,683,204,062.30 | 134 | 제외: 동일 심볼 현물 없음 |
| 50 | VVVUSDT | VVV | 14,548,723,512.60 | 288 | 제외: 동일 심볼 현물 없음 |
| 51 | TRXUSDT | TRON | 14,282,940,328.89 | 288 | 신규 선정 |
| 52 | 1000SHIBUSDT | 1000SHIB | 14,233,323,389.20 | 288 | 제외: 동일 심볼 현물 없음 |
| 53 | VELVETUSDT | VELVET | 13,861,568,387.08 | 288 | 제외: 동일 심볼 현물 없음 |
| 54 | QNTUSDT | Quant | 13,703,479,098.85 | 288 | 신규 선정 |
| 55 | INJUSDT | Injective | 13,466,486,142.29 | 288 | 신규 선정 |
| 56 | WIFUSDT | Dogwifhat | 13,140,414,578.30 | 288 | 신규 선정 |
| 57 | POWERUSDT | POWER | 12,987,521,071.62 | 288 | 제외: 동일 심볼 현물 없음 |
| 58 | HUSDT | H | 12,910,015,077.76 | 288 | 제외: 동일 심볼 현물 없음 |
| 59 | SKYAIUSDT | SKYAI | 12,813,932,147.49 | 288 | 제외: 동일 심볼 현물 없음 |
| 60 | FETUSDT | Artificial Superintelligence Alliance | 12,794,068,863.75 | 288 | 신규 선정 |
| 61 | HBARUSDT | Hedera Hashgraph | 12,051,867,969.73 | 288 | 신규 선정 |
| 62 | 1000BONKUSDT | 1000BONK | 11,899,968,054.54 | 288 | 제외: 동일 심볼 현물 없음 |
| 63 | ENSOUSDT | Enso | 11,804,634,934.18 | 288 | 신규 선정 |
| 64 | CHIPUSDT | USD.AI | 11,764,745,902.53 | 183 | 신규 선정 |
| 65 | APTUSDT | Aptos | 11,704,337,049.04 | 288 | 신규 선정 |
| 66 | BULLAUSDT | BULLA | 11,573,160,227.85 | 288 | 제외: 동일 심볼 현물 없음 |
| 67 | ALLOUSDT | Allora | 11,534,033,813.20 | 288 | 신규 선정 |
| 68 | VIRTUALUSDT | Virtuals Protocol | 11,182,320,078.43 | 288 | 신규 선정 |
| 69 | STOUSDT | StakeStone | 10,905,550,352.81 | 288 | 신규 선정 |
| 70 | ICPUSDT | Internet Computer | 10,883,980,774.71 | 288 | 신규 선정 |
| 71 | LSKUSDT | Lisk | 10,871,271,226.58 | 288 | 신규 선정 |
| 72 | OPUSDT | Optimism | 10,810,857,578.34 | 288 | 신규 선정 |
| 73 | DEXEUSDT | DeXe | 10,651,452,888.46 | 288 | 신규 선정 |
| 74 | 龙虾USDT | 龙虾 | 10,318,378,028.09 | 219 | 제외: 계약 identity 정책 |
| 75 | CRVUSDT | Curve | 10,248,239,313.57 | 288 | 신규 선정 |
| 76 | ORDIUSDT | ORDI | 9,983,600,723.01 | 288 | 신규 선정 |
| 77 | ESPORTSUSDT | ESPORTS | 9,980,837,875.86 | 288 | 제외: 동일 심볼 현물 없음 |
| 78 | ZROUSDT | LayerZero | 9,730,347,879.31 | 288 | 신규 선정 |
| 79 | TUTUSDT | Tutorial | 9,675,205,660.75 | 288 | 신규 선정 |
| 80 | BERAUSDT | BERACHAIN | 9,565,597,460.50 | 288 | 신규 선정 |
| 81 | BRUSDT | Bedrock | 9,426,554,262.03 | 288 | 제외: 동일 심볼 현물 없음 |
| 82 | REUSDT | Re | 9,425,740,638.56 | 120 | 신규 선정 |
| 83 | USELESSUSDT | USELESS | 9,351,949,265.25 | 288 | 제외: 동일 심볼 현물 없음 |
| 84 | SYNUSDT | Synapse | 9,271,794,081.58 | 288 | 신규 선정 |
| 85 | STRKUSDT | Starknet Token | 9,076,833,842.47 | 288 | 신규 선정 |
| 86 | TIAUSDT | Celestia | 9,050,639,152.13 | 288 | 신규 선정 |
| 87 | UBUSDT | UB | 8,866,663,486.68 | 288 | 제외: 동일 심볼 현물 없음 |
| 88 | ETCUSDT | Ethereum Classic | 8,656,669,085.69 | 288 | 신규 선정 |
| 89 | SANDUSDT | The Sandbox | 8,553,965,098.75 | 288 | 신규 선정 |
| 90 | ACEUSDT | Fusionist | 8,386,280,523.81 | 288 | 신규 선정 |
| 91 | RENDERUSDT | Render | 8,338,588,220.01 | 288 | 신규 선정 |
| 92 | JTOUSDT | JITO | 8,261,758,335.87 | 288 | 신규 선정 |
| 93 | BILLUSDT | BILL | 8,201,980,670.39 | 162 | 제외: 동일 심볼 현물 없음 |
| 94 | PLAYUSDT | PLAY | 8,032,807,121.69 | 288 | 제외: 동일 심볼 현물 없음 |
| 95 | BTRUSDT | BTR | 7,988,242,605.95 | 288 | 제외: 동일 심볼 현물 없음 |
| 96 | DUSKUSDT | Dusk | 7,826,015,499.79 | 288 | 신규 선정 |
| 97 | CYSUSDT | CYS | 7,812,038,295.41 | 288 | 제외: 동일 심볼 현물 없음 |
| 98 | ORCAUSDT | Orca | 7,781,196,046.51 | 288 | 신규 선정 |
| 99 | XAUTUSDT | Tether Gold | 7,770,604,021.98 | 204 | 제외: 상품가격 연동 |
| 100 | BLESSUSDT | BLESS | 7,672,050,830.12 | 288 | 제외: 동일 심볼 현물 없음 |

## 5. 상품 정책에 따른 제외 목록과 이유

기존 정책을 그대로 적용했다(2026-09 Spot, 2026-10-11 Futures 조사와 같은 규칙, 같은 공식 분류). 밈·DeFi·L1/L2·AI라는 이유로 제외하지 않았다. 전체 개별 사유는 [spot-all-candidates.csv](evidence/research/spot-all-candidates.csv), [futures-all-contracts.csv](evidence/research/futures-all-contracts.csv).

#### 현물: 제외 115개 (사유별)

| 사유 | 개수 | Binance 순위 상위 예시 (YTD 거래대금 USDT) |
| --- | ---: | --- |
| 토큰화 주식·ETF(레버리지 ETF 포함, bStocks) | 95 | SNDKBUSDT#51 (2,726,794,342), SPCXBUSDT#54 (2,503,385,718), CRCLBUSDT#91 (1,306,621,982), MUBUSDT#113 (1,047,218,217), SKHYBUSDT#159 (713,641,139), SOXLBUSDT#165 (688,304,671), MSTRBUSDT#181 (621,907,069), SNXXBUSDT#225 (439,091,056) … |
| 스테이블코인(디페그 설계 포함) | 14 | USDCUSDT#1 (528,038,262,419), USD1USDT#6 (48,274,193,877), FDUSDUSDT#12 (12,354,704,566), RLUSDUSDT#19 (9,600,141,040), UUSDT#27 (5,837,730,888), XUSDUSDT#69 (1,777,554,718), BFUSDUSDT#103 (1,180,221,593), USDEUSDT#106 (1,159,688,332) … |
| 래핑·스테이킹 표현(WBTC/WBETH/BNSOL) | 3 | WBTCUSDT#101 (1,191,028,328), WBETHUSDT#206 (546,981,623), BNSOLUSDT#275 (322,914,538) |
| 금 등 상품가격 연동 | 2 | PAXGUSDT#13 (11,770,267,971), XAUTUSDT#25 (6,443,950,748) |
| 법정화폐 | 1 | EURUSDT#28 (5,641,549,909) |

#### 선물: 제외 174개 (사유별)

| 사유 | 개수 | Binance 순위 상위 예시 (YTD 거래대금 USDT) |
| --- | ---: | --- |
| 같은 심볼·baseAsset의 TRADING 현물 없음(1000x 승수 포함) | 163 | 1000PEPEUSDT#9 (86,708,850,291), RIVERUSDT#12 (63,185,036,618), LABUSDT#14 (52,619,548,802), RAVEUSDT#21 (37,417,356,783), SIRENUSDT#26 (32,713,961,421), PIPPINUSDT#28 (27,988,983,851), AKEUSDT#36 (21,940,473,102), BEATUSDT#37 (21,382,952,514) … |
| 계약 identity 정책 불충족(INDEX/비ASCII 등) | 7 | 币安人生USDT#41 (17,383,191,273), 龙虾USDT#74 (10,318,378,028), 牛来USDT#153 (5,312,817,924), 我踏马来了USDT#179 (4,274,005,338), BTCDOMUSDT#421 (1,093,062,366), 哈基米USDT#516 (397,964,316), ALLUSDT#523 (294,627,841) |
| 금 등 상품가격 연동 | 2 | PAXGUSDT#18 (41,827,465,137), XAUTUSDT#99 (7,770,604,022) |
| 스테이블코인(디페그 설계 포함) | 2 | USDCUSDT#398 (1,314,967,100), USTCUSDT#490 (630,849,410) |

신규 선정 75+75개는 제가 하나씩 이름과 Binance 분류 태그를 다시 확인했다. 래핑·스테이킹 표현 자체가 아닌 프로토콜의 거버넌스 토큰(LDO, ETHFI, BARD, STO, BABY, EIGEN), RWA 플랫폼 토큰(ONDO, PLUME, EDEN), 스테이블코인 발행사의 거버넌스 토큰(WLFI, CHIP, RE, LUNC)은 기존 정책상 일반 암호화폐로 유지했다. 기존 25+25개는 모두 현재 TRADING이고 정책을 충족한다.

## 6. 현물 최종 100개 (기존 25 + 신규 75)

정책 순위 = 적격 후보 중 순위(기존 25 포함), Binance 순위 = 전체 USDT 현물 중 순위. 신규 75는 정책 순위 순서 그대로 추가했다(PUMP 23위 … MARSCOIN 100위).

| # | 구분 | 심볼 | 이름 | 정책 순위 | Binance 순위 | YTD 거래대금 (USDT) | 표시 소수 |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: |
| 1 | 기존 | BTCUSDT | Bitcoin | 1 | 2 | 381,126,869,350.55 | 2 |
| 2 | 기존 | ETHUSDT | Ethereum | 2 | 3 | 221,066,329,839.68 | 2 |
| 3 | 기존 | BNBUSDT | BNB | 6 | 8 | 27,653,299,103.68 | 2 |
| 4 | 기존 | XRPUSDT | XRP | 4 | 5 | 48,354,506,941.46 | 4 |
| 5 | 기존 | SOLUSDT | Solana | 3 | 4 | 71,900,897,201.88 | 2 |
| 6 | 기존 | TRXUSDT | TRON | 10 | 14 | 10,913,400,902.10 | 4 |
| 7 | 기존 | DOGEUSDT | Dogecoin | 7 | 9 | 22,903,913,938.85 | 5 |
| 8 | 기존 | ZECUSDT | Zcash | 5 | 7 | 37,178,340,722.15 | 2 |
| 9 | 기존 | XLMUSDT | Stellar Lumens | 21 | 29 | 5,527,833,131.61 | 4 |
| 10 | 기존 | LINKUSDT | ChainLink | 16 | 21 | 7,823,747,447.88 | 3 |
| 11 | 기존 | SUIUSDT | Sui | 9 | 11 | 14,267,649,689.04 | 4 |
| 12 | 기존 | NIGHTUSDT | Midnight | 12 | 16 | 10,061,241,426.26 | 5 |
| 13 | 기존 | NEARUSDT | NEAR Protocol | 8 | 10 | 15,318,106,124.12 | 3 |
| 14 | 기존 | PEPEUSDT | Pepe | 11 | 15 | 10,493,872,309.10 | 8 |
| 15 | 기존 | ADAUSDT | Cardano | 13 | 17 | 10,039,665,262.14 | 4 |
| 16 | 기존 | TAOUSDT | Bittensor | 14 | 18 | 9,849,304,842.47 | 1 |
| 17 | 기존 | WLDUSDT | Worldcoin | 15 | 20 | 9,297,602,512.96 | 4 |
| 18 | 기존 | ENAUSDT | Ethena | 18 | 23 | 7,284,982,045.94 | 4 |
| 19 | 기존 | AVAXUSDT | Avalanche | 19 | 24 | 7,170,880,075.60 | 3 |
| 20 | 기존 | UNIUSDT | Uniswap | 17 | 22 | 7,512,063,138.42 | 3 |
| 21 | 기존 | CHIPUSDT | USD.AI | 22 | 30 | 5,380,396,062.74 | 5 |
| 22 | 기존 | LTCUSDT | Litecoin | 20 | 26 | 6,038,007,183.27 | 2 |
| 23 | 기존 | ASTERUSDT | Aster | 25 | 33 | 4,745,839,119.30 | 4 |
| 24 | 기존 | 币安人生USDT | 币安人生 | 30 | 38 | 4,396,623,114.19 | 4 |
| 25 | 기존 | TRUMPUSDT | OFFICIAL TRUMP | 24 | 32 | 4,837,925,359.87 | 3 |
| 26 | 신규 | PUMPUSDT | Pump.Fun | 23 | 31 | 5,220,843,190.90 | 6 |
| 27 | 신규 | XPLUSDT | Plasma | 26 | 34 | 4,740,341,803.90 | 5 |
| 28 | 신규 | AAVEUSDT | Aave | 27 | 35 | 4,679,395,456.31 | 2 |
| 29 | 신규 | BCHUSDT | Bitcoin Cash | 28 | 36 | 4,588,698,627.72 | 1 |
| 30 | 신규 | DASHUSDT | Dash | 29 | 37 | 4,430,142,859.55 | 2 |
| 31 | 신규 | REUSDT | Re | 31 | 39 | 4,146,464,049.42 | 4 |
| 32 | 신규 | SENTUSDT | Sentient | 32 | 40 | 4,094,137,365.75 | 5 |
| 33 | 신규 | ONDOUSDT | Ondo | 33 | 41 | 3,873,588,828.76 | 4 |
| 34 | 신규 | FETUSDT | Artificial Superintelligence Alliance | 34 | 42 | 3,825,746,462.81 | 4 |
| 35 | 신규 | PENGUUSDT | Pudgy Penguins | 35 | 43 | 3,550,873,773.97 | 6 |
| 36 | 신규 | HBARUSDT | Hedera Hashgraph | 36 | 44 | 3,513,328,780.54 | 5 |
| 37 | 신규 | FILUSDT | Filecoin | 37 | 45 | 3,330,545,564.74 | 4 |
| 38 | 신규 | ARBUSDT | Arbitrum | 38 | 46 | 3,253,179,412.38 | 4 |
| 39 | 신규 | ZAMAUSDT | ZAMA | 39 | 47 | 3,189,902,484.39 | 5 |
| 40 | 신규 | WLFIUSDT | World Liberty Financial | 40 | 48 | 2,972,239,933.22 | 4 |
| 41 | 신규 | FOGOUSDT | FOGO | 41 | 49 | 2,754,326,450.33 | 5 |
| 42 | 신규 | ICPUSDT | Internet Computer | 42 | 50 | 2,753,018,932.71 | 3 |
| 43 | 신규 | DOTUSDT | Polkadot | 43 | 52 | 2,681,620,849.43 | 3 |
| 44 | 신규 | KITEUSDT | KITE | 44 | 53 | 2,523,037,852.14 | 4 |
| 45 | 신규 | OPNUSDT | OPINION | 45 | 55 | 2,499,532,829.16 | 4 |
| 46 | 신규 | APTUSDT | Aptos | 46 | 56 | 2,338,111,129.97 | 4 |
| 47 | 신규 | VIRTUALUSDT | Virtuals Protocol | 47 | 57 | 2,287,451,131.14 | 4 |
| 48 | 신규 | ALLOUSDT | Allora | 48 | 58 | 2,260,909,774.17 | 4 |
| 49 | 신규 | INJUSDT | Injective | 49 | 59 | 2,240,028,770.97 | 3 |
| 50 | 신규 | ZROUSDT | LayerZero | 50 | 60 | 2,217,929,243.05 | 3 |
| 51 | 신규 | RENDERUSDT | Render | 51 | 61 | 2,084,849,140.63 | 3 |
| 52 | 신규 | BONKUSDT | Bonk | 52 | 62 | 1,974,991,082.19 | 8 |
| 53 | 신규 | SHIBUSDT | SHIBA INU | 53 | 63 | 1,926,522,829.48 | 8 |
| 54 | 신규 | BANKUSDT | Lorenzo Protocol | 54 | 64 | 1,912,390,485.27 | 4 |
| 55 | 신규 | GIGGLEUSDT | Giggle Fund | 55 | 65 | 1,882,565,800.11 | 2 |
| 56 | 신규 | DEXEUSDT | DeXe | 56 | 66 | 1,863,670,061.83 | 3 |
| 57 | 신규 | POLUSDT | Polygon Ecosystem Token | 57 | 67 | 1,850,643,658.11 | 5 |
| 58 | 신규 | QNTUSDT | Quant | 58 | 68 | 1,835,986,758.11 | 2 |
| 59 | 신규 | BARDUSDT | Lombard | 59 | 70 | 1,723,100,022.55 | 4 |
| 60 | 신규 | WIFUSDT | Dogwifhat | 60 | 71 | 1,693,680,011.24 | 4 |
| 61 | 신규 | TUTUSDT | Tutorial | 61 | 72 | 1,664,932,676.30 | 5 |
| 62 | 신규 | AXSUSDT | Axie Infinity | 62 | 73 | 1,647,427,502.94 | 3 |
| 63 | 신규 | MEGAUSDT | MEGA | 63 | 74 | 1,603,524,398.92 | 5 |
| 64 | 신규 | SEIUSDT | Sei | 64 | 75 | 1,597,000,749.20 | 5 |
| 65 | 신규 | ENSOUSDT | Enso | 65 | 76 | 1,573,152,461.99 | 3 |
| 66 | 신규 | BREVUSDT | Brevis | 66 | 77 | 1,560,272,452.95 | 4 |
| 67 | 신규 | ORDIUSDT | ORDI | 67 | 78 | 1,538,058,804.37 | 3 |
| 68 | 신규 | STRKUSDT | Starknet Token | 68 | 79 | 1,528,742,275.15 | 5 |
| 69 | 신규 | STOUSDT | StakeStone | 69 | 80 | 1,524,079,807.03 | 4 |
| 70 | 신규 | ZENUSDT | Horizen | 70 | 81 | 1,521,255,397.31 | 3 |
| 71 | 신규 | SAHARAUSDT | Sahara AI | 71 | 82 | 1,503,960,108.28 | 5 |
| 72 | 신규 | OPUSDT | Optimism | 72 | 83 | 1,488,003,414.21 | 4 |
| 73 | 신규 | BABYUSDT | Babylon | 73 | 84 | 1,447,733,289.66 | 5 |
| 74 | 신규 | BIOUSDT | Bio Protocol | 74 | 85 | 1,439,382,819.25 | 5 |
| 75 | 신규 | ROBOUSDT | Fabric Protocol | 75 | 86 | 1,406,290,104.80 | 5 |
| 76 | 신규 | CHZUSDT | Chiliz | 76 | 87 | 1,401,458,305.60 | 5 |
| 77 | 신규 | TIAUSDT | Celestia | 77 | 88 | 1,375,670,569.92 | 4 |
| 78 | 신규 | SPKUSDT | Spark | 78 | 89 | 1,325,679,071.12 | 6 |
| 79 | 신규 | GRAMUSDT | Gram | 79 | 90 | 1,321,583,450.99 | 3 |
| 80 | 신규 | PYTHUSDT | Pyth Network | 80 | 92 | 1,298,782,281.99 | 5 |
| 81 | 신규 | LUNCUSDT | Terra Classic | 81 | 93 | 1,275,522,461.43 | 8 |
| 82 | 신규 | PENDLEUSDT | Pendle | 82 | 94 | 1,269,314,920.44 | 3 |
| 83 | 신규 | CRVUSDT | Curve | 83 | 95 | 1,262,350,876.24 | 4 |
| 84 | 신규 | PROMUSDT | Prometeus | 84 | 96 | 1,246,395,296.10 | 3 |
| 85 | 신규 | PLUMEUSDT | PLUME | 85 | 97 | 1,223,656,266.14 | 5 |
| 86 | 신규 | ETHFIUSDT | ether.fi | 86 | 98 | 1,221,746,066.92 | 4 |
| 87 | 신규 | AEROUSDT | Aerodrome | 87 | 99 | 1,212,896,918.73 | 4 |
| 88 | 신규 | SAGAUSDT | Saga | 88 | 100 | 1,194,646,928.87 | 5 |
| 89 | 신규 | ACEUSDT | Fusionist | 89 | 102 | 1,185,997,433.22 | 4 |
| 90 | 신규 | CAKEUSDT | PancakeSwap | 90 | 104 | 1,176,208,074.63 | 3 |
| 91 | 신규 | HOMEUSDT | Defi App | 91 | 105 | 1,165,136,650.12 | 5 |
| 92 | 신규 | SYNUSDT | Synapse | 92 | 107 | 1,141,674,995.74 | 5 |
| 93 | 신규 | ZKPUSDT | zkPass | 93 | 108 | 1,110,306,891.48 | 4 |
| 94 | 신규 | LDOUSDT | Lido DAO | 94 | 109 | 1,106,904,936.63 | 4 |
| 95 | 신규 | JTOUSDT | JITO | 95 | 110 | 1,105,533,037.12 | 4 |
| 96 | 신규 | EIGENUSDT | EigenLayer | 96 | 111 | 1,090,925,239.57 | 4 |
| 97 | 신규 | ALGOUSDT | Algorand | 97 | 112 | 1,060,824,379.50 | 4 |
| 98 | 신규 | ARUSDT | Arweave | 98 | 114 | 1,046,172,126.61 | 3 |
| 99 | 신규 | BERAUSDT | BERACHAIN | 99 | 115 | 1,040,393,253.94 | 4 |
| 100 | 신규 | MARSCOINUSDT | MarsCoin | 100 | 116 | 1,030,805,408.78 | 4 |

## 7. 선물 최종 100개 (기존 25 + 신규 75)

기초자산 "Futures-only" 21개는 현물 100에 없어 Futures 전용 Asset으로 등록된다(§8).

| # | 구분 | 심볼 | 이름 | 정책 순위 | Binance 순위 | YTD 거래대금 (USDT) | 표시 소수 | 기초자산 |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 기존 | BTCUSDT | Bitcoin | 1 | 1 | 3,353,259,068,826.82 | 1 | 현물 공유 |
| 2 | 기존 | ETHUSDT | Ethereum | 2 | 2 | 2,693,065,373,139.55 | 2 | 현물 공유 |
| 3 | 기존 | SOLUSDT | Solana | 3 | 3 | 574,112,119,433.31 | 2 | 현물 공유 |
| 4 | 기존 | ZECUSDT | Zcash | 4 | 4 | 279,893,971,457.95 | 2 | 현물 공유 |
| 5 | 기존 | XRPUSDT | XRP | 5 | 5 | 251,220,263,641.94 | 4 | 현물 공유 |
| 6 | 기존 | HYPEUSDT | Hyperliquid | 6 | 6 | 185,028,758,089.00 | 3 | Futures-only |
| 7 | 기존 | DOGEUSDT | Dogecoin | 7 | 7 | 148,428,817,660.70 | 5 | 현물 공유 |
| 8 | 기존 | BNBUSDT | BNB | 8 | 8 | 109,401,285,625.56 | 2 | 현물 공유 |
| 9 | 기존 | SUIUSDT | Sui | 9 | 10 | 68,181,096,158.52 | 4 | 현물 공유 |
| 10 | 기존 | NEARUSDT | NEAR Protocol | 10 | 11 | 67,412,389,059.15 | 3 | 현물 공유 |
| 11 | 기존 | ADAUSDT | Cardano | 11 | 13 | 56,814,656,219.13 | 4 | 현물 공유 |
| 12 | 기존 | WLDUSDT | Worldcoin | 12 | 15 | 52,146,695,143.15 | 4 | 현물 공유 |
| 13 | 기존 | TAOUSDT | Bittensor | 13 | 16 | 48,393,460,835.57 | 2 | 현물 공유 |
| 14 | 기존 | ENAUSDT | Ethena | 14 | 17 | 45,821,906,822.12 | 5 | 현물 공유 |
| 15 | 기존 | LINKUSDT | ChainLink | 15 | 19 | 39,934,418,247.86 | 3 | 현물 공유 |
| 16 | 기존 | AVAXUSDT | Avalanche | 16 | 20 | 38,585,343,531.40 | 3 | 현물 공유 |
| 17 | 기존 | UNIUSDT | Uniswap | 17 | 22 | 37,218,363,086.34 | 3 | 현물 공유 |
| 18 | 기존 | PUMPUSDT | Pump.Fun | 18 | 23 | 36,904,545,670.51 | 6 | 현물 공유 |
| 19 | 기존 | BCHUSDT | Bitcoin Cash | 19 | 24 | 35,300,826,192.32 | 2 | 현물 공유 |
| 20 | 기존 | TRUMPUSDT | OFFICIAL TRUMP | 20 | 25 | 33,777,575,225.62 | 3 | 현물 공유 |
| 21 | 기존 | FILUSDT | Filecoin | 21 | 27 | 31,629,465,650.37 | 4 | 현물 공유 |
| 22 | 기존 | AAVEUSDT | Aave | 22 | 29 | 27,852,383,882.26 | 2 | 현물 공유 |
| 23 | 기존 | LTCUSDT | Litecoin | 23 | 30 | 25,525,065,329.04 | 2 | 현물 공유 |
| 24 | 기존 | ASTERUSDT | Aster | 24 | 31 | 24,016,442,924.61 | 4 | 현물 공유 |
| 25 | 기존 | XLMUSDT | Stellar Lumens | 25 | 32 | 23,602,958,251.05 | 5 | 현물 공유 |
| 26 | 신규 | DASHUSDT | Dash | 26 | 33 | 23,216,494,565.95 | 2 | 현물 공유 |
| 27 | 신규 | ONDOUSDT | Ondo | 27 | 34 | 23,139,858,057.31 | 4 | 현물 공유 |
| 28 | 신규 | DOTUSDT | Polkadot | 28 | 35 | 22,553,226,751.19 | 4 | 현물 공유 |
| 29 | 신규 | ARBUSDT | Arbitrum | 29 | 38 | 19,945,256,589.60 | 5 | 현물 공유 |
| 30 | 신규 | BANKUSDT | Lorenzo Protocol | 30 | 39 | 18,918,996,461.84 | 5 | 현물 공유 |
| 31 | 신규 | PENGUUSDT | Pudgy Penguins | 31 | 40 | 18,068,806,699.69 | 6 | 현물 공유 |
| 32 | 신규 | AXSUSDT | Axie Infinity | 32 | 42 | 17,020,033,376.43 | 4 | 현물 공유 |
| 33 | 신규 | XPLUSDT | Plasma | 33 | 44 | 16,070,105,154.40 | 5 | 현물 공유 |
| 34 | 신규 | WLFIUSDT | World Liberty Financial | 34 | 48 | 14,868,932,823.16 | 5 | 현물 공유 |
| 35 | 신규 | TRXUSDT | TRON | 35 | 51 | 14,282,940,328.89 | 5 | 현물 공유 |
| 36 | 신규 | QNTUSDT | Quant | 36 | 54 | 13,703,479,098.85 | 2 | 현물 공유 |
| 37 | 신규 | INJUSDT | Injective | 37 | 55 | 13,466,486,142.29 | 3 | 현물 공유 |
| 38 | 신규 | WIFUSDT | Dogwifhat | 38 | 56 | 13,140,414,578.30 | 4 | 현물 공유 |
| 39 | 신규 | FETUSDT | Artificial Superintelligence Alliance | 39 | 60 | 12,794,068,863.75 | 4 | 현물 공유 |
| 40 | 신규 | HBARUSDT | Hedera Hashgraph | 40 | 61 | 12,051,867,969.73 | 5 | 현물 공유 |
| 41 | 신규 | ENSOUSDT | Enso | 41 | 63 | 11,804,634,934.18 | 4 | 현물 공유 |
| 42 | 신규 | CHIPUSDT | USD.AI | 42 | 64 | 11,764,745,902.53 | 5 | 현물 공유 |
| 43 | 신규 | APTUSDT | Aptos | 43 | 65 | 11,704,337,049.04 | 4 | 현물 공유 |
| 44 | 신규 | ALLOUSDT | Allora | 44 | 67 | 11,534,033,813.20 | 5 | 현물 공유 |
| 45 | 신규 | VIRTUALUSDT | Virtuals Protocol | 45 | 68 | 11,182,320,078.43 | 4 | 현물 공유 |
| 46 | 신규 | STOUSDT | StakeStone | 46 | 69 | 10,905,550,352.81 | 5 | 현물 공유 |
| 47 | 신규 | ICPUSDT | Internet Computer | 47 | 70 | 10,883,980,774.71 | 3 | 현물 공유 |
| 48 | 신규 | LSKUSDT | Lisk | 48 | 71 | 10,871,271,226.58 | 5 | Futures-only |
| 49 | 신규 | OPUSDT | Optimism | 49 | 72 | 10,810,857,578.34 | 5 | 현물 공유 |
| 50 | 신규 | DEXEUSDT | DeXe | 50 | 73 | 10,651,452,888.46 | 3 | 현물 공유 |
| 51 | 신규 | CRVUSDT | Curve | 51 | 75 | 10,248,239,313.57 | 4 | 현물 공유 |
| 52 | 신규 | ORDIUSDT | ORDI | 52 | 76 | 9,983,600,723.01 | 3 | 현물 공유 |
| 53 | 신규 | ZROUSDT | LayerZero | 53 | 78 | 9,730,347,879.31 | 4 | 현물 공유 |
| 54 | 신규 | TUTUSDT | Tutorial | 54 | 79 | 9,675,205,660.75 | 5 | 현물 공유 |
| 55 | 신규 | BERAUSDT | BERACHAIN | 55 | 80 | 9,565,597,460.50 | 4 | 현물 공유 |
| 56 | 신규 | REUSDT | Re | 56 | 82 | 9,425,740,638.56 | 4 | 현물 공유 |
| 57 | 신규 | SYNUSDT | Synapse | 57 | 84 | 9,271,794,081.58 | 5 | 현물 공유 |
| 58 | 신규 | STRKUSDT | Starknet Token | 58 | 85 | 9,076,833,842.47 | 5 | 현물 공유 |
| 59 | 신규 | TIAUSDT | Celestia | 59 | 86 | 9,050,639,152.13 | 4 | 현물 공유 |
| 60 | 신규 | ETCUSDT | Ethereum Classic | 60 | 88 | 8,656,669,085.69 | 3 | Futures-only |
| 61 | 신규 | SANDUSDT | The Sandbox | 61 | 89 | 8,553,965,098.75 | 5 | Futures-only |
| 62 | 신규 | ACEUSDT | Fusionist | 62 | 90 | 8,386,280,523.81 | 5 | 현물 공유 |
| 63 | 신규 | RENDERUSDT | Render | 63 | 91 | 8,338,588,220.01 | 3 | 현물 공유 |
| 64 | 신규 | JTOUSDT | JITO | 64 | 92 | 8,261,758,335.87 | 4 | 현물 공유 |
| 65 | 신규 | DUSKUSDT | Dusk | 65 | 96 | 7,826,015,499.79 | 5 | Futures-only |
| 66 | 신규 | ORCAUSDT | Orca | 66 | 98 | 7,781,196,046.51 | 3 | Futures-only |
| 67 | 신규 | NOMUSDT | Nomina | 67 | 102 | 7,561,574,511.64 | 6 | Futures-only |
| 68 | 신규 | KITEUSDT | KITE | 68 | 103 | 7,541,660,442.25 | 5 | 현물 공유 |
| 69 | 신규 | GIGGLEUSDT | Giggle Fund | 69 | 104 | 7,526,618,091.24 | 2 | 현물 공유 |
| 70 | 신규 | BIOUSDT | Bio Protocol | 70 | 105 | 7,398,912,332.18 | 5 | 현물 공유 |
| 71 | 신규 | SAHARAUSDT | Sahara AI | 71 | 107 | 7,074,675,866.31 | 6 | 현물 공유 |
| 72 | 신규 | MOVRUSDT | Moonriver | 72 | 111 | 6,776,486,511.69 | 4 | Futures-only |
| 73 | 신규 | SENTUSDT | Sentient | 73 | 112 | 6,766,932,705.27 | 5 | 현물 공유 |
| 74 | 신규 | POLUSDT | Polygon Ecosystem Token | 74 | 113 | 6,760,483,401.45 | 5 | 현물 공유 |
| 75 | 신규 | SEIUSDT | Sei | 75 | 114 | 6,742,962,644.84 | 5 | 현물 공유 |
| 76 | 신규 | HOMEUSDT | Defi App | 76 | 116 | 6,670,952,568.16 | 6 | 현물 공유 |
| 77 | 신규 | HEIUSDT | Heima | 77 | 120 | 6,519,423,137.63 | 5 | Futures-only |
| 78 | 신규 | GALAUSDT | Gala | 78 | 121 | 6,499,565,133.18 | 6 | Futures-only |
| 79 | 신규 | ATOMUSDT | Cosmos | 79 | 122 | 6,433,142,503.17 | 3 | Futures-only |
| 80 | 신규 | OPNUSDT | OPINION | 80 | 123 | 6,425,907,023.81 | 5 | 현물 공유 |
| 81 | 신규 | ZENUSDT | Horizen | 81 | 124 | 6,379,516,570.13 | 3 | 현물 공유 |
| 82 | 신규 | ENJUSDT | Enjin Coin | 82 | 125 | 6,379,111,821.28 | 5 | Futures-only |
| 83 | 신규 | CHZUSDT | Chiliz | 83 | 126 | 6,349,403,749.80 | 5 | 현물 공유 |
| 84 | 신규 | LDOUSDT | Lido DAO | 84 | 130 | 6,237,216,165.60 | 4 | 현물 공유 |
| 85 | 신규 | ZAMAUSDT | ZAMA | 85 | 131 | 6,218,167,787.78 | 5 | 현물 공유 |
| 86 | 신규 | KAITOUSDT | Kaito | 86 | 132 | 6,178,756,843.19 | 4 | Futures-only |
| 87 | 신규 | ESPUSDT | Espresso | 87 | 133 | 6,115,543,079.85 | 5 | Futures-only |
| 88 | 신규 | PROMUSDT | Prometeus | 88 | 135 | 6,067,157,041.92 | 3 | 현물 공유 |
| 89 | 신규 | EDENUSDT | OpenEden | 89 | 137 | 5,808,174,701.67 | 5 | Futures-only |
| 90 | 신규 | NILUSDT | Nillion | 90 | 138 | 5,799,772,829.10 | 5 | Futures-only |
| 91 | 신규 | PIXELUSDT | Pixels | 91 | 139 | 5,799,139,080.80 | 6 | Futures-only |
| 92 | 신규 | ONGUSDT | Ontology Gas | 92 | 140 | 5,783,775,625.98 | 5 | Futures-only |
| 93 | 신규 | MARSCOINUSDT | MarsCoin | 93 | 141 | 5,750,680,117.61 | 5 | 현물 공유 |
| 94 | 신규 | ALGOUSDT | Algorand | 94 | 142 | 5,731,235,534.03 | 5 | 현물 공유 |
| 95 | 신규 | 0GUSDT | 0G | 95 | 144 | 5,600,019,973.04 | 4 | Futures-only |
| 96 | 신규 | ETHFIUSDT | ether.fi | 96 | 145 | 5,599,390,775.86 | 4 | 현물 공유 |
| 97 | 신규 | PENDLEUSDT | Pendle | 97 | 146 | 5,595,586,497.56 | 4 | 현물 공유 |
| 98 | 신규 | ZBTUSDT | Zerobase | 98 | 147 | 5,586,916,604.24 | 5 | Futures-only |
| 99 | 신규 | ONTUSDT | Ontology | 99 | 148 | 5,453,724,582.18 | 5 | Futures-only |
| 100 | 신규 | SAGAUSDT | Saga | 100 | 149 | 5,434,224,403.11 | 5 | 현물 공유 |

## 8. Futures-only 기초자산 처리 결과

- 선물 100개 중 79개는 현물 100개와 같은 Asset을 기초자산으로 공유한다. 21개는 현물 목록에 없어 기존 Futures-only 구조를 그대로 쓴다: HYPE(기존), LSK, ETC, SAND, DUSK, ORCA, NOM, MOVR, HEI, GALA, ATOM, ENJ, KAITO, ESP, EDEN, NIL, PIXEL, ONG, 0G, ZBT, ONT.
- `BINANCE_FUTURES_ONLY_ASSETS`(공식 이름)와 계산된 `BINANCE_FUTURES_ONLY_SYMBOLS`가 일치함을 테스트로 고정했다. Futures-only 자산은 기존 `SPOT_ASSET_WHERE`·상세/가격/캔들 404·Spot quote/주문/WS 거부·Spot 수집 대상 제외를 그대로 받는다(21개 각각 테스트).
- 기존 Futures-only였던 PUMP/AAVE/BCH/FIL은 현물 YTD 순위(정책 23·27·28·37위)로 선정되어 현물이 되었다. 새 행을 만들지 않고 기존 Asset ID·이름·계약을 재사용한다(시드 계획: 생성 71, 유지 29). 자동 공개가 아니라 현물 순위에 따른 선정이며, 배포 즉시 현물 목록에 나타나므로 이 4개의 현물 캔들 백필을 배포 직후 실행해야 한다(§16).
- 심볼·승수·단위가 다른 계약(1000PEPE, 1000SHIB, 1000BONK, 1000LUNC 등)은 매핑하지 않고 제외했다. 비ASCII 계약(币安人生 등)은 현행 Futures identity·DB CHECK 정책상 제외했다.
- 기존 등록 상품 중 거래 불가 상태인 것은 없다.

## 9. 변경 파일과 변경 이유

**카탈로그(종목 확대)**

| 파일 | 변경 이유 |
| --- | --- |
| `backend/src/providers/binance/binance-fixed-asset-universe.ts` | Spot 신규 75개 항목 추가(tickSize·표시 소수·baseAsset·공식 이름). 기존 25개 객체는 바이트 동일 |
| `backend/src/providers/binance/binance-product-catalog.ts` | Futures 신규 75개, Futures-only 이름 목록 21개(계산 목록과 일치), FAPI 표시 소수 100개(기존 25개 값 동일) |
| `backend/artifacts/binance-crypto-100-2026/selection.json` | 테스트가 대조하는 동결 선정 결과(조사 result.json의 SHA-256 포함) |
| `backend/scripts/research-binance-crypto-100-2026.ts` · `.test.ts` | 공개 GET 허용목록·1초 순차·공유 coordinator 조사 + 캐시 재현 분석(기존 25+25를 동결 입력으로 사용) 및 단위 테스트 7개 |
| `backend/scripts/verify-binance-crypto-100-2026.py` | 표준 라이브러리 Decimal 독립 검산(전 후보·순위·정책·최종 목록) |
| `backend/scripts/provision-futures-instruments.ts` | `spot.length !== 25` 차단을 universe 크기 기준으로, 트랜잭션 timeout 30 → 120초(약 200문) |
| `backend/scripts/lib/asset-universe-apply.ts` | Spot 시드 트랜잭션에 120초 timeout(Prisma 기본 5초로는 원격 71건 생성 실패 위험) |
| `backend/scripts/binance-fixed-universe-smoke.ts` | 100개를 URL 스트림 대신 운영과 같은 SUBSCRIBE 1회로 검증, 문구 |
| `backend/scripts/futures-product-catalog-smoke.ts` | 요약 수치를 카탈로그에서 계산, Cross 경로를 PUMP 대신 Futures-only 두 번째 계약으로 |
| `backend/scripts/futures-integration.ts`, `backend/scripts/load-test/README.md` | 25 전제 주석·문서 |
| 테스트: `binance-fixed-asset-universe.spec`, `binance-product-catalog.spec`, `binance-tick-size.spec`, `binance-order-book.service.spec`, `provider-config.service.spec`, `provider-target-resolver.service.spec`, `market-candle-sync.service.spec`, `market-candle-futures.spec`, `assets.service.spec`, `orders.service.spec`, `scripts/lib/seed-binance-fixed-universe.spec`, `scripts/lib/futures-provision-plan.spec` | 25/5 고정값을 카탈로그·동결 artifact 기준으로. Futures-only 검증은 21개 전부로 확대, 현물 전환 4개는 현물로 검증, 운영 업그레이드(25+5 → 100+100) 계획 시나리오 추가. 검증을 줄이거나 skip한 것은 없다 |

**호가 이력(신규 기능)**

| 파일 | 변경 이유 |
| --- | --- |
| `backend/prisma/schema.prisma`, `backend/prisma/migrations/20261016200000_add_crypto_order_book_history/migration.sql`, `backend/src/generated/prisma/**` | 테이블 2개(기본키만), CHECK 3종씩, FK, `OpsJobName.crypto_order_book_retention`. 생성 클라이언트 재생성(CI가 커밋 일치를 확인) |
| `backend/src/providers/crypto-order-book-history.config.ts` | 엄격 플래그 2개(기본 OFF, 보존은 기록 플래그를 따름)와 고정 정책값 |
| `backend/src/providers/crypto-order-book-history.service.ts` | 60초 샘플러·기록기·진단 |
| `backend/src/providers/crypto-order-book-retention.worker.ts` | 14일 보존 Ops 작업 |
| `backend/src/providers/binance/binance-order-book.service.ts`, `backend/src/futures/futures-market-data-ingestion.service.ts` | 수용된 호가를 publish 예약 뒤 샘플러에 전달(선택적 주입, 1줄) |
| `backend/src/providers/providers.module.ts`, `backend/src/ops/ops.module.ts`, `backend/src/ops/ops-config.ts`, `backend/src/common/env-validation.ts` | DI 등록, 범용 스케줄러 맵에서 전용 작업으로 제외, 시작 시 플래그 검증 |
| `backend/src/app.service.ts` | `/readiness` `cryptoOrderBookHistory`, 알림 3종, `DB_DISK_FULL` 연결 |
| 테스트: `crypto-order-book-history.service.spec`(15), `crypto-order-book-retention.worker.spec`(10), `app.service.spec`(+1), `crypto-order-book-history.integration.spec` + `scripts/crypto-order-book-history-integration.ts` | 샘플링·중복·장애·보존·계획 검증. 통합 테스트는 CI의 PG16·PG17 작업에 추가(`.github/workflows/ci.yml`) |
| `backend/.env.example`, `backend/docs/crypto-order-book-history-contract.md`, `backend/docs/database-operations-monitoring.md`, `backend/docs/order-book-api-contract.md`, `backend/docs/futures-market-data-contract.md`, `backend/docs/README.md` | 계약·운영 문서 |

**문서(현행 수치 갱신)**: `backend/docs/binance-crypto-100-2026-ytd.md`(신규, 선정·등록 순서·롤백), `assets-api-contract.md`, `futures-api-contract.md`, `policy-decisions.md`, `provider-ingestion-foundation.md`, `long-range-4h-candles.md`, `binance-rest-limits.md`.

**조사 기록**: 이 보고서, `evidence/research/`(원본 캐시 `raw-cache.tar.xz` 11 MB 포함), `evidence/format-bench/`, `evidence/soak/`, `calc/`, `repro/`.

프론트엔드는 변경하지 않았다. 심볼·개수 하드코딩이 없고, 신규 심볼(0GUSDT 포함)은 기존 정규식·표시 로직을 통과한다. Spot 호가는 Han을 허용하고, Futures 호가는 ASCII만 허용하며 Futures 카탈로그에도 Han이 없다.

## 10. WebSocket·REST 수집 구조 및 호출 예산

| 연결 (인스턴스당, 개수 변화 없음) | 구독 | 100+100 실측 수신량 |
| --- | --- | --- |
| Spot standalone `/stream` (운영 모드) | 100 `@ticker` + 100 `@depth10` = 200 streams, SUBSCRIBE 1회 | 약 136 frames/s (ticker 59/s, depth 77/s) |
| (live-candle 모드일 때) | 100 × (kline_5m+ticker+depth10) = 300 streams, 상한 min(200, 341) 종목 | 미측정(운영 모드 아님) |
| USDⓈ-M `/public` | 100 `@depth10@500ms` | 154 frames/s, 97 KB/s |
| USDⓈ-M `/market` (시장 통계) | 100 `@ticker` | 33 frames/s |
| USDⓈ-M `/market` (Mark) | 100 `@markPrice@1s` | 97 frames/s |
| USDⓈ-M `/market` (Last) | 100 `@aggTrade` | 180 frames/s |

- 연결당 스트림 수는 공식 한도(Spot 1024, USDⓈ-M 문서상 1024 또는 구버전 200) 이내다. 사용자별 Binance 연결은 없다.
- 호가 이력은 새 연결·구독·REST를 추가하지 않는다. REST 예산은 [binance-rest-limits.md](../../../backend/docs/binance-rest-limits.md)의 100+100 추정과 같다(평균 약 240/min, 바쁜 분 440~940, 최악 1,340~1,540 > 1,200은 기존 coordinator가 거부·이연). 운영 예산 1,200 설정을 권장 그대로 유지한다.
- 신규 자산 초기 백필은 기존 coordinator가 2 슬롯·분당 예산 안에서만 실행한다(Spot 5m/1d/1w 약 2,600 weight, 4h 200, USDⓈ-M 4h ≤ 400). 로컬 실측: 4h는 Spot 100 calls, USDⓈ-M 199 calls로 한 번에 끝났다. 5m은 분당 예산을 넘으므로 배치로 나눠 실행해야 한다. 예산을 다 쓰는 동안에는 Futures Last의 REST 재확인이 거부된다(§16-3).

## 11. 호가 60초 DB 저장의 실제 구현 방식

계약 문서: [crypto-order-book-history-contract.md](../../../backend/docs/crypto-order-book-history-contract.md).

- **수집**: 기존 `BinanceOrderBookService.handleFrame`(Spot 두 소유자 공용)과 `FuturesMarketDataIngestion.acceptDepth`가 기존 파서·정렬·중복·시퀀스 검사를 통과시킨 호가만, Redis publish를 예약한 **뒤** `CryptoOrderBookHistoryService.offerSpot/offerFutures`에 넘긴다. 메모리 O(1) 처리이며 await 없음. 새 소켓·REST 없음.
- **샘플링 규칙**: 상품·UTC 분마다 최신 유효 호가 1개. 유효 = 양쪽 1~10단계, 최우선 매수 < 최우선 매도, 수량 > 0, 시퀀스 0~int64, USDⓈ-M은 공급자 시각(T)과 수신 시각 차 ≤ 5초. 분이 끝날 때 그 호가가 분 종료 시점 기준 5초(앱 `ORDER_BOOK_STALE_MS`) 이내에 받은 것일 때만 저장한다. 끊긴 스트림은 저장하지 않고, 오래된 호가를 새 분으로 다시 저장하지 않으며, 시계가 뒤로 가서 이미 닫은 분의 호가가 오면 버린다(`late`). Spot 부분 호가에는 공급자 시각이 없어 만들지 않는다.
- **저장**: 1초 타이머가 닫힌 분을 테이블당 `INSERT … ON CONFLICT DO NOTHING` 1문(트랜잭션 + `statement_timeout 5s`, 10초 timeout)으로 쓴다. 대기열은 상품당 최대 1분: DB 장애 중 다음 분이 오면 이전 미기록 분을 대체(`superseded`)해 쌓이지 않는다. 실패 시 2초→60초 백오프, CHECK 거부 행은 단독 기록 후 계수(`rejected`), 종료 시 닫힌 분만 1회 기록.
- **식별·중복 방지**: `crypto_spot_order_book_snapshots`(asset_id FK) / `futures_order_book_snapshots`(instrument_id FK). 같은 심볼도 다른 테이블·다른 ID. 기본키 `(bucket_start_at, product)`가 유일한 인덱스로, 재연결·재시작·다중 서버의 같은 분 두 번째 쓰기를 막는다(먼저 쓴 서버가 이김).
- **열**: `bucket_start_at`(=date_trunc('minute', captured_at), CHECK), `captured_at`(서버 수신 = 실시간 이벤트 capturedAt), `effective_at`(선물만, 공급자 T), `sequence`(lastUpdateId / u), `bids`·`asks`(`json` `[[price, quantity], …]`, 1~10단계 CHECK, 원문 문자열 그대로), `created_at`(DB 기록 시각). 원본 프레임 전체·top-of-book 중복 열은 두지 않았다.
- **형식 결정**: 실제 Binance 호가로 4개 형식을 측정했다([row-format-comparison.json](evidence/format-bench/row-format-comparison.json)). `json` 쌍 배열은 문자열을 바이트 그대로 보존하면서 두 테이블 평균이 가장 작았다. 기본키를 분 우선으로 두면 인덱스가 118.5 → 82.8 B/행으로 줄고, 보존 삭제가 같은 인덱스의 앞부분을 지운다.
- **KOSCOM 분리**: KOSCOM/KIS 호가 테이블·보존 정책은 변경하지 않았다. 금융 원장·주문 테이블 변경 없음.
- **플래그**: `CRYPTO_ORDER_BOOK_HISTORY_ENABLED`(엄격 true/false, 기본 false). 끄면 수집기에서 즉시 반환한다.
- **진단**: `/readiness` `data.cryptoOrderBookHistory.recorder`(추적 상품, 대기 행, 계수, 마지막 기록, 연속 실패, 마지막 실패 종류). 알림 `CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING`(3회 연속 실패), `DB_DISK_FULL`. 로그 `crypto_order_book_history_persist_failed`/`db_disk_full`(종류별 분당 1회).

## 12. 호가 14일 보존 및 삭제 검증 결과

- **구현**: `CryptoOrderBookRetentionWorker`(OpsModule, Ops job `crypto_order_book_retention`, lock `crypto_order_book_retention:current`). 5분마다(프로세스 분의 :45, 기존 :00/:15/:30과 분리) 한 인스턴스만 실행. DB 시각 기준 cutoff = now − 336 h, **삭제 기준 = 분 단위 내림(cutoff)**: 분 전체가 336시간보다 오래된 행만 지운다. 1,000행 배치(기본키 순서 + `FOR UPDATE SKIP LOCKED` + 행 주소 삭제), 배치마다 트랜잭션·5초 statement timeout·lease 갱신, 실행당 20,000행·60초 상한. 두 테이블 외에는 이름조차 쓰지 않는다. `ops_job_runs`에 테이블별 삭제 수, 상한 도달, `oldestRemaining`(지연 확인), 실패 종류 기록. `/readiness` 알림 `CRYPTO_ORDER_BOOK_RETENTION_FAILING`/`_BACKLOG`.
- **플래그**: `CRYPTO_ORDER_BOOK_RETENTION_ENABLED`(미설정 시 기록 플래그를 따름; 기록을 끈 뒤에도 단독으로 켜서 14일간 비울 수 있음).

**검증 결과** — [scripts/crypto-order-book-history-integration.ts](../../../backend/scripts/crypto-order-book-history-integration.ts). 새 `*_test` DB에서 실행했고 CI의 PG16·PG17 작업에도 추가했다.

| 사례 | 결과 (PG17.10 / PG16.14 모두 PASS) |
| --- | --- |
| 서버 2대 동시 기록(100 Spot + 100 USDⓈ-M, 같은 분) | 정확히 200행. 한쪽 200 inserted, 다른 쪽 200 duplicates |
| 서버 재시작(같은 분 재제출) | 0 inserted, 100 duplicates, 행 수 불변 |
| 동일 심볼 현물·선물 분리 | 공유 기초자산 1개에 대해 Spot 행 1(asset_id) + Futures 행 1(instrument_id) |
| 정확한 값 | `bids::text`/`asks::text`가 제출 문자열과 바이트 동일(0.000038100 / 123456789.00000000 등). bucket = date_trunc(분), created_at ≥ captured_at, 선물 captured−effective 정확히 100 ms |
| CHECK 거부 | 분 불일치·빈 쪽·11단계 직접 삽입이 SQLSTATE 23514(`data_rejected`)로 거부 |
| 60초 규칙(실 DB) | 1초 간격 150초 → 첫 분 1행(최신 sequence), 종료 10초 전 끊긴 둘째 분 0행(stale 1), 열린 셋째 분 미기록 |
| DB 저장 실패 | 테이블 ACCESS EXCLUSIVE 잠금 중 기록 → 5초 statement timeout으로 제한, 그동안 호가 제출 계속, 대기 1행 유지, 해제·백오프 후 기록 |
| 14일 경계 | 실행 후 `bucket_start_at < deleteBefore` 0행. 경계 이후 분(마지막 5분 + 이후 전부)은 모두 그대로 |
| 상한·백로그 | 25,000+3,600+3,600 오래된 행 → 첫 실행 정확히 20,000 삭제(`batchLimitReached`) |
| 중복 실행 | 같은 시각 2개 워커 → lease로 1개만 실행, 다른 하나 `undefined`(행·기록 없음) |
| 실패·복구 | 선물 테이블 잠금 중 실행 → 현물 배치는 커밋, 선물 배치 statement timeout → `ops_job_runs` failed(`failureKind=statement_timeout`), 다음 실행 succeeded(3,600 삭제), 재실행 0 삭제 |
| 다른 테이블 보호 | 20일 지난 KOSCOM `asset_orderbook_snapshots`·`asset_price_snapshots` 행 그대로 |
| 실행 계획 | PostgreSQL 기본·운영 비용 설정 모두 `Index Scan …_pkey` → `LockRows` → `Limit` → `Tid Scan`(ModifyTable). Seq Scan·Sort·Hash 없음 |

단위 테스트: `crypto-order-book-retention.worker.spec.ts` 10개(배치·lease·상한·백로그 알림·실패 3회 알림과 복구·lease 상실·비활성 시 무동작·분 단위 경계·SQL이 두 테이블만 지정). soak에서는 5분 주기 실행이 `ops_job_runs`에 succeeded로 쌓였고(삭제 0, `oldestRemaining` = soak 시작 분), 알림 없음. **실제 14일 경과 후 운영 삭제는 관찰하지 않았다.** 경계·대량 삭제는 위 통합 테스트로 검증했다.

## 13. 호가 데이터 예상 저장량과 DB 필요 용량

측정과 모델 모두 로컬 PostgreSQL 17 기준이다. 운영 Render PG17과 설정이 달라 WAL·FPI 수치는 지표로만 쓴다. 모델 [calc/capacity_model_crypto100.py](calc/capacity_model_crypto100.py)는 P1 모델의 운영 실측 상수를 그대로 쓰고 이번 실측을 더한다. 출력은 [capacity_model_crypto100_output.md](calc/capacity_model_crypto100_output.md)에 있다.

**호가 이력만 (100 + 100)**

| 항목 | 값 |
| --- | --- |
| 최대 기록량 | 200상품 × 1,440분 = **288,000행/일**, 14일 **4,032,000행** |
| 실측 저장률 | soak 62분(history ON) 12,200 상품·분 중 11,927행 = **97.8 %**. 60분 구간 기준 현물 96.0 %, 선물 99.5 %. 누락은 분 종료 시 5초 넘게 갱신이 없던 얇은 호가(예: BREV, BANK, FOGO, 币安人生)다. 이와 별개로 WSL 시계가 뒤로 간 순간에 들어온 호가 169건은 `late`로 버렸다(운영 NTP 환경에서는 거의 0 예상) |
| 행 크기(기본키 포함, 실측) | 현물 **870 B**, 선물 **673 B**(soak 실데이터 5,857 / 6,070행. 튜플 평균 737 / 546 B, PK 인덱스 약 92 B/행). 10만 행 형식 벤치는 875 B / 630 B |
| 일간 / 14일 | **0.222 GB/일**, 14일 3.11 GB + dead tuple·여유 15 % = **3.58 GB** |
| WAL | 삽입만 약 **0.24 GB/일**(행당 현물 948 B, 선물 738 B). 삭제는 같은 양을 매일 지우며, 기록량은 행 수에 비례하는 작은 delete 레코드다 |
| 기록 부하 | 분당 테이블별 INSERT 1문(약 100행, 현물 약 88 KB). 보존은 5분마다 약 1,000행 삭제 |

**기존 가격·선물 스냅샷과 합산 (GB, 정상 상태; 가격 14일 보존 ON 가정)**

| 단계 | 가격 스냅샷 raw full / slim | Mark+Last 24 h | 캔들 | 호가 이력 | 합계 full / slim |
| --- | ---: | ---: | ---: | ---: | ---: |
| 이전 (KRX 15 / Spot 25 / USDⓈ-M 25) | 9.0 / 7.0 | 3.0 | 0.25 | 0 | 12.4 / 10.4 |
| **이번 (KRX 15 / Spot 100 / USDⓈ-M 100)** | 33.0 / 25.0 | 11.8 | 0.93 | 3.58 | **49.5 / 41.5** |

100+100 로컬 실측 유입량은 다음과 같다. 가격 스냅샷은 현물 1종목당 0.155행/초로 하루 134만 행, 보존 전 하루 1.85 GB다. Mark는 계약당 1.0행/초, Last는 0.54행/초로 둘이 하루 1,328만 행이다.

증가 요인의 대부분은 호가 이력이 아니다. **현물 100종목의 가격 스냅샷**과 **선물 Mark/Last**가 차지한다. 가격 14일 보존을 켜지 않으면 현물 100종목만으로 하루 약 1.9~2.0 GB가 늘어난다.

**디스크 판단과 권장 수치** (WAL 여유 1.3 GB 포함 사용률)

| 디스크 | 정상 상태(full / slim) | 12개월 후, KOSCOM 호가 무기한 | 12개월 후, KOSCOM 호가도 14일 보존 |
| --- | ---: | ---: | ---: |
| 50 GB(현재) | 102 % / 86 % | 222 % / 206 % | 126 % / 110 % |
| 100 GB | 51 % / 43 % | 111 % / 103 % | 63 % / 55 % |
| 150 GB | 34 % / 29 % | 74 % / 69 % | 42 % / 37 % |
| 200 GB | 25 % / 21 % | 55 % / 51 % | 32 % / 28 % |

- **현재 50 GB로는 100+100 운영이 안전하지 않다.** 정상 상태만으로 80 % 경고선을 넘는다.
- 권장: 등록 전에 **최소 100 GB로 증설**하고 가격 스냅샷 14일 보존과 raw slim을 켠다. 정상 상태는 약 43~51 %가 된다.
- KOSCOM 호가 보존(별도 미승인 정책)을 정하지 않으면 100 GB는 약 6~7개월 뒤 80 %에 닿는다. 12개월을 추가 조치 없이 운영하려면 **150~200 GB**가 필요하다.
- 호가 이력 활성화만의 추가분은 약 3.6 GB(정상 상태)와 0.24 GB/일 WAL이다.
- 수치는 P1과 같은 가정(15 % dead tuple, Render 50 GB)을 쓴 모델이다. 실제 배포 뒤 24시간 증가량은 `/readiness` `databaseStorage`와 Render 디스크 지표로 다시 확인해야 한다.

## 14. 금융·화면 회귀 검증 결과

**금융 불변조건**: 가격 출처·Last/Mark 역할·신선도·수수료·체결 산식·보유/평균단가·레버리지·증거금·청산·지정가·조건부·TP/SL·지갑·원장·시즌 정산·랭킹 코드는 변경하지 않았다. 호가 이력 테이블은 어떤 금융 경로도 읽지 않는다(코드상 읽는 곳 없음, 보존 SQL은 두 테이블만 지정).

| 검증 | 범위 | 결과 |
| --- | --- | --- |
| CI 금융 DB 목록(Limit order 28 suite) — 스위트마다 새 PG16 DB, CI와 같은 opt-in | 현물 시장가·지정가·매칭·예약·멱등·수수료 고정·거래 시각, FX, 지갑 이체, **선물 진입·증가·감소·종료(futures), 위험·강제청산(futures-risk, isolated-boundary), F3/F3.1 평가·시즌 종료, 선물 지정가·조건부 진입, 조건부 BUY/SELL·독립 TP/SL·LOC**, 평가 일관성, MVP 흐름 | **27/28 PASS**. `wallet-fx-transfer` 1회 FAIL(적용 환율 1400 ≠ 1401, 크립토 카탈로그와 무관한 FX 이체) → 단독 새 DB 재실행 PASS. 알려진 WSL 시계 역행 증상으로 분류 |
| CI 금융 DB 목록(Core account 25 suite) | 자산 거래 가능성(**Futures-only 현물 차단**), 계정·지갑 scope, 일반/초보 계정, 일반 거래·FX, 포트폴리오·KRX 종가, 스냅샷 감사, **랭킹·시즌 정산 경합·최종 랭킹 자격**, 친구, 시즌 참가, 인증, Ops lock | **25/25 PASS** |
| Futures 가격 안전성(CI 별도 DB) | Last/Mark 신선도·Last 보존 | PASS |
| **CI Futures release fixture 로컬 재현 (100+100)** | 10계정 실제 HTTP/WS 준비(현물 매수·매도·지정가, 선물 진입·지정가), 전체 정확 Decimal 감사, catalog smoke | prepare·최종 감사 모두 **CORRECTNESS PASS, 10계정, findings 0**. catalog smoke **PASS**: Spot 목록 100·Futures 카탈로그 100 정확 일치, Futures-only 21개 각각 검색/상세/가격/캔들 404, 현물 quote 거부 84, WS 거부 63, Last/Mark 21, 시장가 체결 84(open·replay·increase·reduce·close), 지정가 생성·취소 21, 외부 provider 접근 0. 단 이 호스트의 시계 감시 단계는 설계상 실패하므로 제외했다 |
| Canonical E2E (env 파일 없는 복사본, 무환경변수) | 전체 HTTP 계약 | **409/409 PASS** |
| 화면 API (soak 실서버, 실 Binance) | 실제 가입·로그인·일반 계정 | Spot 목록 `/assets?assetType=crypto&limit=100` 100개 전부 가격·표시 소수(34 ms, 144 KB). Futures 카탈로그 100개 전부 Last·Mark(7~12 ms, 114 KB). 앱 WS `asset_order_book`(신규 MARSCOINUSDT)·`futures_order_book`(신규 0GUSDT) 10+10 수신 |
| 현물 비노출 | 단위·통합 | Futures-only 21개 모두 목록·검색·상세·가격·캔들·quote·주문·Spot 수집·캔들 backfill 차단(단위 21×3 suite + Core assets-tradability + catalog smoke) |
| 계정 전환·종목 교체 혼입 | 기존 동작 | 프론트 변경 없음. 기존 구독 ID(자산·계약 분리)와 테스트 유지 |
| 캔들 백필 절차 (실 Binance, 로컬 DB) | 신규 Spot 75 | 1d/1w 75/75, 5m 75/75(35일 756,028행, 배치 실행), 전일 확정 일봉 확인. 장기 4h: Spot 100 시리즈 57,243행, USDⓈ-M 100 시리즈 57,394행, 실패 0. 429/418 0 |
| 등록 절차 (실 Binance 검증, 로컬 DB) | 시드·등록 CLI | Spot 시드 100/100 provider 검증 후 적용·검증. Futures 등록 assets create 21 / maintain 79, instruments create 100, blockers 0 |

### 성능 측정 (로컬 실서버 + 실 Binance, 100 + 100)

실행 방식: `dist/src/main.js`를 env 파일 없는 디렉터리에서 실행했다(standalone Spot 모드, Futures Last/Mark/시장 데이터 ON, 스케줄러 OFF). A는 호가 이력 OFF 15분, B는 ON 62분이다. 지표는 이벤트 루프 probe(15초), readiness·Redis 구독·DB 샘플(60초)로 모았다. 비교는 B의 처음 30분(다른 작업이 없던 구간)으로 했다. 원자료: [evidence/soak/](evidence/soak/).

| 지표 | A: OFF | B: ON (30분) | B 전체 62분 / 비고 |
| --- | ---: | ---: | --- |
| 수신 frame | Spot 약 136/s, USDⓈ-M 약 464/s | 동일 | Spot 62분 514,719 frames, 처리 실패 0 |
| Redis 호가 팬아웃 | Spot 4,537 / Futures 9,250 건/분 | 4,546 / 9,238 | 100/100 상품 모두 매 분 수신 |
| 실시간 전달 지연 (수신→Redis 구독자) p50 / p99 / 최대 | 0 / 1 / 3 ms | 0 / 1 / 4 ms | 같은 호스트 기준. 호가 이력에 의한 증가 없음 |
| CPU (1 core 대비) 평균 / p95 / 최대 | 23.3 / 28.0 / 38.4 % | 22.3 / 24.8 / 33.8 % | 22.4 / 25.1 / 33.8 % |
| RSS | 367 → 431 MB | 374 → 413 MB | 약 413~420 MB에서 정체(누수 징후 없음) |
| 이벤트 루프 지연 p99 (10 ms 타이머 초과분) | 1.8 ms | 1.5 ms | 최대 1회 28.9 ms |
| Spot 재연결 | 0 | 0 | 0 |
| Mark 신선도 | stale 0 | stale 0 | 100계약 1행/초, 최대 공백 1.01초(의도한 비활성 31초 제외) |
| Last 공백 | — | — | 평시 최대 7.1초. 백필로 REST 예산을 다 쓴 구간에서는 89.7초(§16-3) |
| 현물 가격 스냅샷 | — | — | 중앙값 5.2초 간격(5초 throttle). 얇은 종목은 ticker가 없어 최대 220초(§16-2) |
| 호가 이력 기록 | 0 | 분당 약 196행 | 62분 11,927행. 분당 INSERT 2문 |
| 호가 이력 행·인덱스 | — | — | 현물 870 B/행(PK 92 B), 선물 673 B/행 |
| WAL | 10.3 MB/분 | 10.8 MB/분 | 차이 약 0.4 MB/분(노이즈 포함). 이력 자체 추정치는 0.17 MB/분. 이후 구간은 캔들 백필로 증가 |
| 보존 작업 | — | 5분마다 성공(삭제 0) | soak 13회 모두 succeeded, 평균 7.2 ms·최대 11 ms(삭제 대상 없음). 대량 삭제는 통합 테스트: 상한 20,000행 1회 + 복구 3,600행 |
| 재구독 | — | — | Futures 대상 100→99→100: 7초·19초 안에 4개 소켓 재구독, Mark stale 0 |
| REST 예산 | — | — | 조사 최대 126/min(실제 사용). 5m 백필 75종목은 600/min 예산을 매분 소진 → 배치 필요 |

**미측정**: 24시간 연속 동작, Binance 24시간 강제 재연결 주기, Render 1 vCPU에서의 처리 여유, 다중 인스턴스 동시 운영.

## 15. 테스트 PASS / FAIL / NOT_RUN

| 구분 | 명령·범위 | 결과 |
| --- | --- | --- |
| Backend 전체 단위 테스트 | `jest --maxWorkers=4` (최종 트리) | **PASS** 325 suites / 5,312 tests, 실패 0 (opt-in DB/live 79 suites·112 tests는 기존대로 skip) |
| 신규 단위 테스트 | 호가 이력 15, 보존 워커 10, readiness +1, 카탈로그·universe·tick·provider·캔들·주문·자산·시드·등록 계획 갱신분 | PASS (위 수치에 포함) |
| 조사 스크립트 테스트 | `node --import tsx --test scripts/research-binance-crypto-100-2026.test.ts` / 기존 futures 조사 / Python `test_research_*` | PASS 7 / 10 / 7 |
| 조사 재현 | 커밋된 `raw-cache.tar.xz`만으로 분석 재실행 + Python 독립 검산 | PASS, `selection.json` 바이트 동일 |
| Load harness | `pnpm test:load-test` | PASS 110 |
| Typecheck / Build | `pnpm typecheck`, `pnpm build` | PASS |
| Lint gate | `lint:accounts:check`, `lint:candles:check`, 진단 bypass gate | PASS / PASS / PASS. 변경 파일 eslint 신규 오류 0. 기존 `assets.service.spec.ts` Prettier 불일치는 HEAD부터 존재(변경하지 않음) |
| Prisma | `migrate deploy`(PG16·PG17), `migrate diff --exit-code`, 생성 클라이언트 재생성 | PASS, drift 없음 |
| 호가 이력 DB 통합 | `CRYPTO_ORDER_BOOK_HISTORY_DB_INTEGRATION=1` | **PASS** PG17.10, PG16.14 |
| CI 금융 DB 목록 | Limit order 28 + Core account 25 + price-safety 1, 스위트마다 새 PG16 DB | **53/54 PASS**, `wallet-fx-transfer` 1 FAIL → 단독 재실행 PASS(WSL 시계 flake, 카탈로그 무관) |
| CI Futures release fixture (로컬 재현, 100+100) | migrate·serve·guard·prepare·catalog smoke·audit | **PASS** (CORRECTNESS PASS ×2, findings 0, 외부 provider 0). 시계 감시 단계는 이 호스트에서 설계상 실패하므로 NOT_RUN |
| Canonical E2E | env 파일 없는 복사본에서 `pnpm run test:e2e`, 환경변수 없음 | **PASS** 409/409 |
| 실데이터: 조사 | 공개 REST 1,055건 | PASS(전부 200, 429/418 0) |
| 실데이터: Spot smoke 100 | `BINANCE_MARKET_DATA_SMOKE=1` | exchangeInfo 100/100, REST 100/100, WS ticker 100/100, depth10 100/100; **판정 FAIL**은 기존 ASTERUSDT 폴백 tick 1건(§16-10) |
| 실데이터: Futures 스트림 | 100계약 × aggTrade/markPrice/ticker/depth10 | 4종 모두 100/100 수신 |
| 실데이터: 시드·등록 | 로컬 DB에 Spot 시드(100/100 검증), Futures 등록(21 + 100, blockers 0) | PASS |
| 실데이터: 캔들 | Spot 75 신규 1d/1w/5m, 4h Spot 100·USDⓈ-M 100 | PASS(5m은 배치 실행 필요, §16·운영 준비) |
| 실데이터 soak | 실서버 + 실 Binance 100+100, A(호가 이력 OFF) 15분 + B(ON) 62분 | PASS: 재연결 0(Spot), Mark stale 0, 팬아웃 p99 1 ms 동일, CPU 약 22~23 %, RSS 약 420 MB에서 정체, 호가 이력 97.8 % 기록, Futures 대상 99↔100 재구독 정상 |
| Frontend | 변경 없음 | NOT_RUN(변경 파일 없음) |
| 운영 | 운영 DB dry-run, Render 배포·환경변수, 운영 등록·백필, 운영 호가 기록 | **NOT_RUN**(금지·승인 대기) |
| 24시간 연속 수집 | — | **NOT_RUN**. 장기 안정성은 확인되지 않았다(77분 실측만) |
| live-candle 모드 100종목(300 streams) | — | NOT_RUN(운영 모드 아님. 단위 테스트의 stream 수·상한만 확인) |

## 16. 미해결 위험 및 운영 승인 대기 항목

| # | 위험·대기 항목 | 상태 | 대응 |
| ---: | --- | --- | --- |
| 1 | **DB 용량** — 100+100은 가격 스냅샷 14일 보존을 켜도 정상 상태가 50 GB의 80 %를 넘는다(§13) | 승인 대기 | 디스크 증설(권장 수치 §13)과 `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true`를 Spot 100 등록 **전에** 결정한다 |
| 2 | **얇은 신규 현물의 가격 신선도** — 현물 가격 스냅샷은 WS ticker로만 저장되고(WS 사용 중 REST 24h ticker는 쉼), Binance는 거래가 없는 종목의 ticker를 보내지 않는다. 실측 33분(07:31–08:04 UTC): 100종목 중 49종목이 execute 기준(10초) 초과 시간 1 % 초과, 27종목 5 % 초과, 최악 BANK 59 %(quote 60초 기준도 23 %), BARD 36 %, ZKP 29 %, TUT 28 %. 기존 25 중에서는 3종목(币安人生 23 % 등)뿐 | 제품 결정 필요 | 기존 신선도 정책을 바꾸지 않았다. 해당 시간대에 시장가 주문이 fail-closed된다. 선택지(범위 밖): 그대로 유지 / 얇은 종목 REST ticker 보완 / 표시 안내. 시간대(미국 장중 등)에 따라 수치가 달라진다 |
| 3 | **REST 예산 경합** — 백필이 분당 예산을 다 쓰면 Futures Last의 조용한 계약 REST 재확인이 거부된다(설계상 fail-closed). 실측: 백필 중 Last 최대 공백 89.7초(평시 7.1초), 10초 초과 427회 | 운영 절차 | 예산 1200을 설정하고, 백필은 분당 예산의 절반 이하로 나눈다(5m 기준 분당 약 25종목). 백필은 한산한 시간에, Futures 거래가 많은 시간대는 피한다 |
| 4 | 호가 이력 활성화 | 기본 OFF, 승인 대기 | 디스크 결정 후 `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=true` |
| 5 | 운영 등록(Spot 시드 71, Futures 등록 75+20)과 캔들 백필 | 미실행 | 운영 적용 준비의 순서대로. 운영 DB dry-run은 이번에 실행하지 않았다(운영 DB 접근은 이번 지시 범위 밖) |
| 6 | Spot depth10 대상은 소켓 연결 시점에 고정 | 기존 동작 | Spot 시드 후 서비스 재시작 1회. Futures는 자동 |
| 7 | Render 1 vCPU 처리 여유 | 로컬만 측정 | 로컬(빠른 CPU) 1 core 기준 약 24 %(약 600 frames/s). 운영 인스턴스는 더 느리므로 배포 후 Render CPU 지표 확인 필요 |
| 8 | Futures 시장 목록·거래 화면 폴링 | 기존 동작 | 카탈로그 전체(100개, 114 KB)를 목록 5초·거래 화면 2초 주기로 조회. 서버 7~12 ms(로컬)로 문제는 아니나 페이로드 4배. 프론트 행은 가상화되지 않음. 범위 밖이라 변경하지 않음 |
| 9 | 앱 마켓 목록의 ticker 구독 | 기존 동작 | 100개를 끝까지 스크롤하면 행당 구독 100개. 게이트웨이 클라이언트당 대기 ticker 64개 상한 → 느린 클라이언트는 일부 갱신 누락 가능. 범위 밖 |
| 10 | ASTERUSDT 폴백 tick | 기존 데이터 | 선언 0.001 vs 현재 0.0001. live metadata가 우선이라 정상 시 영향 없음. 기존 25 객체를 바꾸지 않았다. 갱신 여부 결정 필요(실데이터 smoke는 이 1건으로 FAIL) |
| 11 | Spot exchangeInfo 메타데이터 갱신 | 기존 동작 | 100개를 한 번의 `symbols=[…]` 요청으로 조회 → 한 심볼이라도 상장폐지되면 전체가 실패하고 폴백 상수를 쓴다 |
| 12 | 신규 Han 심볼 | 해당 없음 | 신규 현물 75개에 Han 심볼 없음. 선물은 ASCII만 허용(정책·DB CHECK) |
| 13 | MARSCOIN(42/45일), MEGA(169일), GRAM(106일), AERO(91일) 등 최근 상장 | 정책대로 | YTD 실제 일봉만 합산(연환산 없음). 순위가 짧은 기간 거래대금에 의존함을 알림 |
| 14 | 24시간 장기 안정성 | **미검증** | 로컬 실측은 약 75분(§14). 24시간 연속·Binance 24시간 강제 재연결·장기 메모리는 확인하지 않았다 |
| 15 | WSL 시계 역행 | 환경 | 로컬 금융 통합 테스트·CI fixture 재현 시 시계 단계 역행으로 인한 실패 가능(§15에서 분류) |
| 16 | 다중 인스턴스 | 설계 | 호가 이력은 기본키로 중복 방지. 인스턴스마다 Binance 연결을 따로 열고 각자 쓰기를 시도한다(충돌 시 no-op) |
| 17 | KOSCOM 호가 무제한 증가 | 기존, 범위 밖 | 이번 작업은 KOSCOM 보존 정책을 바꾸지 않았다 |


## 17. 실제 git diff와 최종 작업 트리 상태

- 기준·현재 `HEAD` = `ead934cd2d8941987436f8a89f4ce85f5b1ab24b`(= 시작 시 `origin/main`). **커밋·push 하지 않았다.** 새 브랜치·워크트리 없음. 모든 변경은 `main` 작업 트리에 미커밋 상태다.
- tracked 변경: 52 파일, +2,446 / −226. 이 중 Prisma 생성 클라이언트가 10 파일, +878 / −81(`prisma generate` 결과 그대로이며 CI가 일치를 확인한다). frontend 변경은 없다.
- 신규(untracked): migration 1, 백엔드 소스 6(호가 이력 config/service/worker와 spec), 스크립트 4(조사·검산·조사 테스트·통합), artifact 1, 문서 2, 생성 모델 2, 조사 기록 폴더 1(약 12.9 MB, 대부분 원본 캐시 `raw-cache.tar.xz` 11.3 MB).
- 운영 DB·Render·운영 환경변수·원격 저장소·KOSCOM/KIS/Tiingo에는 어떤 요청도 보내지 않았다. 로컬 검증 서버는 env 파일이 없는 디렉터리에서 `env -i` + loopback DB/Redis만으로 실행했다(`backend/.env.local`의 운영 DB 경로를 읽지 않음).
- 로컬 전용 자원(PG17 55951, PG16 55952·55431, Redis 56951·56952·56953·56381, scratchpad 데이터)은 이 세션 scratchpad에만 있다.

변경 파일 목록과 이유는 §9를 따른다. 핵심 diff 범위:

```text
.github/workflows/ci.yml                                       +16   PG16/PG17 호가 이력 통합 단계
backend/prisma/schema.prisma, migrations/20261016200000_*       +53   테이블 2, OpsJobName 1
backend/src/providers/crypto-order-book-history.{config,service}.ts   신규
backend/src/providers/crypto-order-book-retention.worker.ts    신규
backend/src/providers/binance/binance-order-book.service.ts    +7/−2   샘플러 전달 1줄 + 선택적 주입
backend/src/futures/futures-market-data-ingestion.service.ts   +4      샘플러 전달 1줄 + 선택적 주입
backend/src/app.service.ts                                      +29/−1  readiness·알림
backend/src/providers/binance/binance-fixed-asset-universe.ts  +909/−5 Spot 신규 75 (기존 25 객체 불변, 주석만 갱신)
backend/src/providers/binance/binance-product-catalog.ts       +176/−5 Futures 신규 75, Futures-only 21, 표시 소수 100
backend/scripts/lib/asset-universe-apply.ts, provision-futures-instruments.ts   timeout·100 기준
```

## 운영 적용 준비

운영 변경은 하나도 실행하지 않았다. 아래는 승인 후 실행 순서다. 기존 25+25 상품의 행·ID·증거·포지션은 어느 단계에서도 수정되지 않는다(시드·등록 CLI는 기존 행을 `unchanged`/`maintain`으로만 보고하고, 계약 불일치·비활성·식별자 충돌이면 쓰기 전에 차단한다).

1. **배포 전 확인**
   - Render 환경변수 `BINANCE_CRYPTO_SYMBOLS`가 미설정 또는 빈 값인지 확인한다. 값이 있으면 ticker 소켓이 그 목록만 구독한다.
   - `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE=1200`이 설정되어 있는지 확인한다.
   - **`ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true`를 먼저 승인·적용**한다. 100종목에서 가격 스냅샷이 하루 약 1.9 GB 늘어난다(§13).
   - 디스크 증설을 결정한다(§13 권장 수치).
2. **배포**: migration `20261016200000_add_crypto_order_book_history`가 빌드 중 실행된다. 빈 테이블 2개와 OpsJobName 값 1개를 추가할 뿐 잠금 시간이 짧은 additive 변경이다. 호가 이력 플래그는 기본 OFF이므로 배포만으로는 행이 생기지 않는다.
   - 배포 직후 효과: Spot ticker 소켓은 100개를 구독한다. depth10은 DB에 등록된 자산만 구독하므로 기존 25개와 PUMP/AAVE/BCH/FIL, 즉 29개다.
   - PUMP/AAVE/BCH/FIL은 현물 목록에 바로 나타난다. 이 4개의 현물 캔들 백필(3단계)을 곧바로 실행한다.
   - Futures 수집 대상은 DB 등록분(25개) 그대로다.
3. **Spot 등록**: `node --import tsx scripts/seed-binance-fixed-asset-universe.ts`로 dry-run을 먼저 실행한다. 기대값은 total 100, create 71, unchanged 29다.
   - 이어 `--apply`로 실행한다. 쓰기 전에 공개 exchangeInfo로 100개를 검증하고, 한 트랜잭션(120초 timeout)으로 생성한다.
   - 신규 자산의 ticker 가격 스냅샷은 30초 안에 시작된다.
   - **서비스를 1회 재시작**해 depth10을 100개로 재구독한다.
4. **Spot 캔들**: 신규 자산 ID로 기존 `scripts/candle-baseline-sync.ts --apply`를 실행한다.
   - 1d/1w: `--days 365 --target 1d --target 1w`. 75개를 한 번에 실행해도 된다.
   - 5m: `--days 35 --target 5m`. 아직 커버리지가 완전하지 않은 자산만 넘긴다. 분당 백필은 예산의 절반 이하로 나눈다(예산 1200 기준 분당 약 25개). Futures Last/Mark REST 복구 여유를 남기기 위해서다(§16-3).
   - 이어 장기 4h 백필을 실행한다.
   - 중단된 실행이 남긴 `running` checkpoint는 다음 실행을 `ACTIVE_SYNC_EXISTS`로 실패시킨다. 해당 자산만 `--no-resume`으로 다시 실행한다.
   - 로컬에서 실제 Binance 데이터로 이 절차를 검증했다(§14).
5. **Futures 등록**: 먼저 `FUTURES_PROVISION_DRY_RUN_REDIS_URL=<loopback> pnpm futures:provision-instruments --dry-run`을 실행한다. 기대값은 assets create 20 / maintain 80, instruments create 75 / maintain 25, blockers 0이다.
   - 이어 `FUTURES_PROVISION_EXPECTED_TARGET=<host:port/db> … --apply`를 실행한다. Serializable 한 트랜잭션, 120초 timeout이다.
   - Last/Mark/호가/ticker 수집기는 30초 안에 대상을 다시 읽고 스스로 재구독한다.
6. **Futures 캔들**: 신규 계약에 대해 기존 futures candle sync와 장기 4h 백필을 실행한다.
7. **확인**
   - Spot 목록 100, Futures 카탈로그 100인지 본다.
   - 신규 표본의 가격·호가·캔들을 본다.
   - `/readiness`에서 `futuresMark.targets=100`, stale 0인지 본다.
   - `binanceWebSocketStreaming.subscribedStreams`가 200개인지 본다.
   - REST used weight를 본다.
8. **호가 이력 활성화**(별도 승인, 디스크 결정 후): 모든 인스턴스에 `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=true`를 설정한다. 보존 작업은 자동으로 같이 켜진다.
   - 확인: `/readiness` `cryptoOrderBookHistory`, `ops_job_runs`(`crypto_order_book_retention`), 분당 약 200행 증가.

**롤백**

| 대상 | 방법 | 한계 |
| --- | --- | --- |
| 호가 이력 | `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=false`로 즉시 중단한다. 보존 작업은 `CRYPTO_ORDER_BOOK_RETENTION_ENABLED=true`로 14일 유지해 테이블을 비운다. 테이블은 어떤 금융 경로도 읽지 않는다. | 없음. |
| Futures 신규 75 | 카탈로그 코드를 되돌린다. 신규 계약은 목록·신규 진입에서 빠지고, 열린 포지션은 기존 open-lifetime 조건으로 Last/Mark·청산·정산을 유지한다. | 없음. |
| Spot 신규 75 | 첫 사용자 거래 전에는 비활성화하면 깨끗하다. | 거래 후 비활성화는 보유자의 매도를 막는다(현물 sell-only 모드 없음). 제품 결정이 필요하다. |
| 기존 25+25 보호 | 어떤 단계도 기존 행을 바꾸지 않는다. 문제가 생겨도 기존 상품은 그대로 남는다. | — |

