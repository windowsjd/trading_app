# WSL2 시스템 시계 역행 원인 조사

판정: **LAYER_IDENTIFIED**. Windows는 180초 관측에서 역행하지 않았고,
WSL에서는 6회 역행했다. 별도 120초 Windows 기준 관측에서도 WSL 역행 4회를
재현했다. 직접 후퇴 경로는 **Ubuntu systemd-timesyncd의 NTP step 보정**으로
매우 높은 신뢰도로 특정했다. 반복 오차의 가장 유력한 원인은 **WSL VM의
PHC 기반 chrony agent와 Ubuntu timesyncd가 공유 시계를 동시에 제어하는 충돌**이다.
단, 개별 syscall의 PID/반환값과 충돌 제거 실험은 확보하지 않았으므로 전체
원인을 `ROOT_CAUSE_CONFIRMED`로 선언하지 않는다. 시스템 설정은 변경하지 않았다.

조사일은 **2026-10-09 KST**다. 아래 이벤트 날짜는 **2026-10-08 UTC**다.
기존 [금융 PostgreSQL 조사](../2026-10-08-financial-pg-flakiness/report.md),
[verification](../2026-10-08-financial-pg-flakiness/verification.json),
[120초 probe](../2026-10-08-financial-pg-flakiness/evidence/wallclock.jsonl),
[시스템 로그](../2026-10-08-financial-pg-flakiness/evidence/system-clock-events.log),
[기존 관측기](../2026-10-08-financial-pg-flakiness/reproduction/wallclock-probe.py)를
확인했다. 당시 금융 오류와 역행의 인과관계는 유지하되, 이번에는 OS 경로를 조사했다.

## 1. 환경과 접근 제한

| 항목 | 현재 확인 값 |
|---|---|
| Windows | Windows 11 Pro, 10.0.26200.9457; CIM BuildNumber 26200 |
| WSL | 2.6.3.0; 기본 Ubuntu, WSL2 |
| 실제 실행 kernel | 6.6.87.2-microsoft-standard-WSL2 |
| Ubuntu / systemd | Ubuntu 24.04.4 LTS / 255.4-1ubuntu8.17 |
| clocksource | `tsc`; 사용 가능: `tsc hyperv_clocksource_tsc_page hyperv_clocksource_msr acpi_pm` |
| Ubuntu wsl.conf | `systemd=true`, 기본 사용자 nayuta |
| Windows .wslconfig | `vmIdleTimeout=-1`, `instanceIdleTimeout=-1`; 추가 kernel/clocksource 설정 없음 |
| Hyper-V 경로 | `hv_utils.timesync_implicit=1`, TimeSync IC 4.0, PTP clock name `hyperv` |
| WSL system distro | CBL-Mariner 2.0.20250701; chronyc client 4.1 |

Kernel boot log의 `Host Build 10.0.26100.9444`와 현재 Windows build는 다르다.
이 값만으로 업데이트 시점이나 결함을 추론하지 않는다. 현재 kernel/clocksource는
기존 조사와 같다.

기본 sandbox에서는 systemd bus가 `Operation not permitted`, Windows interop가
`UtilBindVsockAnyPort: socket failed 1`로 실패했다. 승인된 sandbox 밖 읽기 전용
명령에서는 정상 접근했다. OS 관리자 설정 변경이나 설치로 우회하지 않았다.
Windows `w32tm /query /source`와 `/configuration`은 실제 Windows 권한에서
`0x80070005`로 거부됐다. 상태/peer 조회와 기존 이벤트 조회는 가능했다.
권한을 변경하지 않았으며, configuration 이벤트는 현재 설정의 완전한 대체가 아니다.
Ubuntu `/proc/171/syscall`과 tracefs도 접근 거부여서 syscall 추적은 하지 않았다.

원문: [Linux 상태](evidence/linux-before.log),
[인코딩을 보존한 Windows 상태](evidence/windows-after.log).
초기 [Windows 상태](evidence/windows-before.log)는 native 한국어 출력이 깨졌으므로
후속 파일을 판독 기준으로 사용한다.

## 2. 활성 시간 동기화 경로

**Windows:** W32Time Running / Manual, WslService Running / Automatic.
`vmictimesync`는 Windows 내부의 guest용 서비스로 Stopped / Manual이다.
이 서비스의 중지는 Hyper-V가 Linux guest로 시간을 제공하지 않는다는 뜻이 아니다.
W32Time은 leap indicator 3, stratum 0, 마지막 성공 동기화 시각 미지정,
`Local CMOS Clock`, 최근 동기화 오류 1을 보고했다. peer는
`time.windows.com,0x9`, 표시 poll은 1024초이며 재시도 대기 시간이 남아 있었다.
최근 Operational configuration 이벤트에는 `SpecialPollInterval=16384`도 있다.
Windows의 실제 32초 보정 근거는 없다.

**Ubuntu:** systemd-timesyncd PID 171이 enabled/running이며,
`91.189.91.157 (ntp.ubuntu.com)`을 사용한다. 실제 poll은 **32초**,
최대 2048초다. 시작 전 조회 offset은 **−879.950ms**였다.
Ubuntu의 chrony/ntp 서비스와 binary는 없었다. 기본 설정은 주석만 있고,
패키지의 `systemd-timesyncd.service.d/wsl.conf`가 WSL에서 서비스를 허용한다.
`timedatectl`의 synchronized=yes는 안정성과 단일 제어 주체를 보장하지 않는다.

**배포판 외부 chrony endpoint:** `wsl --system`의 읽기 전용 `chronyc tracking`,
`sources`, `sourcestats`가 살아 있는 chrony 응답을 반환했다. 선택 소스는
`#* PHC0`, stratum 1, poll exponent 3 (8초), reach 377이며,
주파수 추정은 약 **28,308–28,829ppm slow**였다. system distro의
localhost UDP 323 endpoint도 확인했다. 여기의 `chronyc -v`는 client 버전이며,
daemon binary의 버전을 직접 조회한 것으로 표시하지 않는다.

설치된 WSL 2.6.3의 [공식 init 소스](https://github.com/microsoft/WSL/blob/2.6.3/src/linux/init/main.cpp)는
mini-init에서 `StartTimeSyncAgent()`로 chronyd를 실행하며,
`refclock PHC /dev/ptp0 poll 3 dpoll -2 offset 0`을 구성한다.
이는 실제 PHC0 응답과 일치한다. PID namespace 경계 때문에 Ubuntu와 system
distro의 `ps`에서 agent PID는 확인하지 못했다. system distro의 `/etc/chrony.conf`
내용은 PHC 설정과 다른 기본 파일이므로 **실행 agent의 실제 설정 파일**로 취급하지 않는다.
소스의 생성 설정과 live endpoint를 함께 근거로 삼는다.
근거: [WSL agent](evidence/wsl-system-distro.log),
[endpoint](evidence/wsl-agent-endpoint.log), [system distro](evidence/wsl-system-final.log),
[버전 대응 소스 발췌](evidence/wsl-timesync-agent-source.txt).

## 3. Phase B: Windows/WSL 동시 관측

[관측기](reproduction/simultaneous-probe.py)는 단일 PowerShell process를 실행하고,
Windows start marker를 받은 뒤 Python probe를 시작했다. Windows는
UTC `DateTime.UtcNow`와 `Stopwatch`, Linux는 `time.time_ns()`와
`time.monotonic_ns()`를 읽었다. 각자 monotonic 기준 180초로 제한했다.
샘플 sleep은 2ms지만 Windows timer granularity 때문에 실제 샘플 간격은 더 길다.
불연속 기준은 wall delta<0 또는 |wall delta−monotonic delta|>20ms이며,
이벤트 기록은 최대 1000건이다. 정상 샘플은 저장하지 않는다.

| 항목 | Windows | WSL |
|---|---:|---:|
| monotonic 관측 시간 | 180.006초 | 180.000초 |
| 샘플 | 13,682 | 83,867 |
| 역행 / >20ms 불연속 | 0 / 0 | 6 / 6 |
| 최대 샘플 간격 | 83.100ms | 4.582ms |

Windows UTC 구간은 `15:29:08.1682605–15:32:08.1750260`이다.
WSL UTC marker는 `15:29:08.473059–15:32:03.094489`지만 그 차이는
관측 중 6번 후퇴했으므로 경과시간으로 사용할 수 없다. Phase C의 진행률을
적용하면 WSL의 180초는 Windows 기준 약 **175초**다. 두 관측은 실제로
겹쳤으며 모든 WSL 후퇴가 Windows 관측 구간 안에 있다.
서로 다른 monotonic epoch를 직접 빼서 겹침을 판단하지 않았다.
Windows의 짧은 sample gap 안에서 상쇄되는 미관측 변화까지 부정하지는 않는다.

| WSL 이벤트 UTC | wall delta (ms) | mono delta (ms) | step = wall−mono (ms) |
|---|---:|---:|---:|
| 15:29:13.824429 | −933.708 | +2.142 | −935.849 |
| 15:29:45.151618 | −905.595 | +2.139 | −907.734 |
| 15:30:16.542125 | −865.215 | +2.161 | −867.377 |
| 15:30:47.903482 | −881.689 | +2.140 | −883.829 |
| 15:31:19.255623 | −892.481 | +2.138 | −894.619 |
| 15:31:50.610658 | −887.070 | +2.144 | −889.215 |

인접 이벤트의 monotonic 간격은 **32.234924–32.257883초**다.
기존 조사의774–832ms보다 이번의865–934ms는 크지만 같은 주기적 후퇴를 재현했다.
원문: [Windows](evidence/windows-wallclock.jsonl), [WSL](evidence/wsl-wallclock.jsonl),
[NTP 상태 변화](evidence/timesync-monitor.jsonl), [집계](evidence/analysis.json).

## 4. Phase C: 보정 주체와 반복 오차 분리

추가 [관측기](reproduction/reference-probe.py)는 Windows process 하나에서
1초마다 wall/QPC reference를 보내고, Linux 수신 시각의 monotonic/raw/wall을
기록했다. Windows 기준 120.314초, Linux 기준 124.017초로 종료했고,
WSL 후퇴 4회를 재현했다. 정상 reference는 120개로 제한됐으며 상세 wall
샘플은 이벤트만 저장했다. NTP D-Bus timestamp는 0.5초 간격으로 조회해
변경된 응답만 보존했다. [원문](evidence/reference-probe.jsonl).

### NTP 응답 보정량과 실제 step

timesyncd의 네 timestamp를 사용해
`offset = ((receive−origin) + (transmit−destination)) / 2`를 계산했다.
모두 `Ignored=false`였고, timesyncd의 성공 동기화 marker mtime은 probe 이벤트보다
1.15–2.12ms 앞섰다. 단순 발생 시각뿐 아니라 **부호와 크기**까지 대조했다.

| UTC | packet | NTP offset (ms) | 실제 step (ms) | 차이 (ms) |
|---|---:|---:|---:|---:|
| 15:32:21.966065 | 591 | −891.895500 | −891.896118 | −0.000618 |
| 15:32:53.327147 | 592 | −901.257500 | −901.257888 | −0.000388 |
| 15:33:24.665821 | 593 | −892.922000 | −892.921446 | +0.000554 |
| 15:33:56.047010 | 594 | −891.041500 | −891.041247 | +0.000253 |

[systemd 255.4 공식 구현](https://github.com/systemd/systemd-stable/blob/v255.4/src/timesync/timesyncd-manager.c)은
|offset|≥0.4초에서 `clock_adjtime(CLOCK_REALTIME, ADJ_SETOFFSET)`로 step을
적용하고, offset>0.2초면 최소 poll로 되돌린다. 이번 accepted offset은 모두
이 조건을 충족한다. 따라서 **약 32초는 timesyncd의 실제 최소 polling과
지속적인 큰 offset 때문에 유지되는 주기**로 설명된다.
Ubuntu 패키지의 모든 downstream patch와 실행 syscall까지 직접 대조한 것은 아니다.
[구현 발췌](evidence/systemd-adjust-source.txt)와 정밀 일치에 기반한 attribution이다.

### 왜 큰 offset이 반복되는가

Windows QPC와 Linux reference의 선형회귀(초기 직렬화 sample 제외)는 다음과 같다.

| 진행률 | Windows QPC 대비 |
|---|---:|
| Linux CLOCK_MONOTONIC | 1.02859979배, 약 +2.86% |
| Linux CLOCK_MONOTONIC_RAW | 0.99999743배 |

stdout 전송 지연을 포함한 관측이므로 ppm 단위 정밀 교정 결과로 사용하지 않는다.
다만 **수 % 오차는 raw source 자체보다 커널 보정이 적용된 시계에 집중**된다.
monotonic이 역행하지 않는다는 기존 사실과, 정확한 속도로 진행한다는 주장은 다르다.

[adjtimex modes=0 읽기](evidence/adjtimex-readonly.json)는 `tick=10297`,
freq −16.4299ppm, status 8192를 반환했다. 보정 없는 nominal tick 10000에 비해
약 +2.97%이며, 일부 시점 값이므로 전체 관측의 평균 +2.86%와 정확히 같을
필요는 없다. [chrony Linux 구현](https://github.com/mlichvar/chrony/blob/4.1/sys_linux.c)은
`ADJ_TICK | ADJ_FREQUENCY`로 큰 주파수 보정을 나눠 적용한다.
timesyncd step 구현은 `ADJ_TICK`을 쓰지 않는다.

가장 유력한 설명은, PHC/Windows를 추적하는 VM chrony와 Ubuntu NTP를 추적하는
timesyncd가 같은 커널 시계를 제어하면서 chrony의 추정/보정과 timesyncd의
반복 step이 서로 영향을 주는 것이다. +2.86%는 약 31초 동안 0.89초의 오차를
만들 수 있어 실제 보정량도 설명한다. **tick을 실제로 쓴 PID와 초기 충돌의
유발 조건은 미확정**이다. TSC calibration 결함이나 Windows host step을
수 % 속도 오차의 확정 원인으로 보고하지 않는다.

## 5. 관련 로그와 가설 평가

Ubuntu journal의 `systemd-resolved: Clock change detected. Flushing caches.`는
Phase B 6회 모두 probe와 monotonic timestamp 기준 0.20–1.15ms 이내로
일치했다. [후속 journal](evidence/linux-after-journal.jsonl),
[대조](evidence/analysis.json). resolved는 **감지자**이며 시계 변경 주체가 아니다.
timesyncd의 일반 log level에는 매번 step 내용이 남지 않았으므로 로그 설정을
변경하지 않고 D-Bus 상태와 synchronized marker로 보완했다.

Windows Time-Service, Kernel-General, Power-Troubleshooter, Kernel-Power의
최근 2시간 조회에는 해당 이벤트가 없었다. Time-Service Operational은 enabled,
818 records이며 최근 이벤트는 관측보다 몇 시간 이전이었다. 최근 성공한 보정이나
절전/재개와 이번 32초 역행의 연결 증거는 없다. 로그 부재만으로 과거 수면이나
외부 조정을 전부 배제하지 않는다.

| 가설 | 현재 평가 |
|---|---|
| W32Time이 host를 32초마다 뒤로 변경 | Windows probe/상태에서 지지되지 않음 |
| Ubuntu timesyncd가 WSL wall clock을 step | offset/step 4회 정밀 일치 + accepted 응답 + 구현; 매우 높은 신뢰 |
| WSL chrony와 Ubuntu NTP 경로 충돌 | live PHC0 agent + 큰 chrony 주파수 보정 + tick/raw 비교; 가장 유력 |
| Hyper-V hv_utils 자체가 작은 step을 반복 | 해당 SYNC flag 추적 없음; implicit 경로는 5초 이상 guest 지연 조건이므로 0.9초 현상만으로 지목 불가 |
| TSC 자체 주파수 결함 | raw 진행률에서 수 % 오차를 지지하지 않음; 완전 배제는 아님 |
| 절전·재개·수동 설정 | 이번 관측과 연결된 로그 없음; 과거 영향 미확정 |

Hyper-V 경로 해석은 [실행 kernel 대응 소스](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.6.87.2/drivers/hv/hv_util.c)에 따른다.
유사 [WSL #10024](https://github.com/microsoft/WSL/issues/10024)는 PHC chrony와 사용자
동기화 설정의 간섭을 다룬다. 기존 이슈는 참고일 뿐, 이번 환경의 인과관계를
대신하는 증거로 쓰지 않았다.

## 6. 해결 방향 비교 — 모두 미적용

첫 선택은 **WSL 안의 시간 제어 주체를 하나로 정리하는 승인 후 실험**이다.
현재 증거에서는 Ubuntu timesyncd의 중복 제어를 일시적으로 제거하고 VM의 PHC
agent만 남기는 비교가 가장 작은 변경이다. 이는 이번 작업의 금지사항이므로
서비스 중지/비활성화 명령을 실행하지 않았다. PHC agent의 비정상 추정이
즉시 회복되는지 보장할 수 없어, 단순히 후퇴 0회만으로 성공을 판단하면 안 된다.

| 방법 | 원인 제거 가능성 / 범위 | 재시작·작업 종료 위험 | 재발 / 복구 |
|---|---|---|---|
| 승인 후 Ubuntu 중복 timesyncd 제어 제거 | 충돌이 원인이면 직접 제거. 설정 대상은 Ubuntu지만 공유 WSL 시계는 다른 배포판에도 영향 | NTP 서비스 조작 필요; WSL/Windows 재부팅은 첫 실험에 불필요. 개발 process 직접 종료 없음 | 다른 배포판 NTP나 자동 재활성화가 있으면 재발. 원래 enabled/running 상태로 복구 가능하나 복구 중 step 가능 |
| WSL/Ubuntu 공식 업데이트 또는 단일 동기화 구성 | 버전/설정에 맞는 지원 경로 검토 필요; 현재 특정 수정 버전은 확인 못함 | VM 재기동 필요할 수 있음; VS Code/PG/Redis/Docker 작업 종료 위험 | 버전별 회귀 가능. 설정 backup 및 지원되는 rollback 범위 확인 필요 |
| 별도 안정적인 Linux 테스트 host | 이 WSL 공유 시계 경로를 테스트에서 제외; 로컬 문제 자체는 남음 | 현재 작업 종료 불필요; 환경 구성 비용 | 새 host에서도 같은 시계 관측을 먼저 수행해야 함 |
| Windows W32Time 정상화 | 현재 unsynchronized 상태는 별도 개선 대상. 두 경로의 충돌을 자체 해결한다고 보장 못함 | Windows 전체 시각 변화 가능. 서비스 조작 또는 설정 변경 필요 | TLS/로그/다른 작업 시각에도 영향. 설정 복구는 가능하나 발생한 시각 변화를 되돌릴 수 없음 |
| tick 강제 초기화 / clocksource 변경 / agent 교체 | 원인 추적 또는 비교 실험 후보; agent가 다시 덮어쓰면 임시 완화에 그침 | 공유 VM 시계에 영향; persistent kernel 설정이면 재기동 필요 | 단독 해결로 권장하지 않음. 원래 값/설정 보존 및 재검증 필요 |

Windows peer와 Ubuntu NTP server 이름만 통일하는 것은 controller 충돌 제거를
보장하지 않는다. Windows `vmictimesync`나 `hv_utils.timesync_implicit`만 끄는 것도
PHC chrony를 제거하는 것과 다르다. 금융 timestamp 검증 완화, fixture backdate,
clock step을 숨기는 제품 수정은 해결책으로 채택하지 않는다.

chrony의 frequency는 daemon의 **추정치**이며 실제 무보정 TSC가 2.8% 느리다는
증거가 아니다. 해석 근거는 [chrony tracking 공식 문서](https://chrony-project.org/doc/4.4/chronyc.html)다.
Windows query/status 해석은 [W32Time 공식 문서](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings)에 따른다.

## 7. 확정 범위와 후속 검증

확정: 동시 관측 수행, WSL 후퇴 재현 10회, Windows Phase B 후퇴 0회,
Ubuntu accepted NTP offset/step 4회 정밀 일치, resolved의 감지 로그,
PHC0를 추적하는 live chrony endpoint, 큰 kernel tick 보정 및 mono/raw 진행률 차이.

미확정: 직접 clock syscall의 PID/반환값, VM agent의 현재 binary/전체 실행 설정,
두 controller의 충돌을 시작한 조건, 비정상 주파수 추정의 전체 생성 과정,
Windows NTP 실패의 이유, 어떤 변경으로 문제를 완전히 제거할 수 있는지.

사용자가 후속 변경을 승인하면 다음 순서로 검증한다.

1. Windows/Ubuntu/다른 실행 배포판의 시간 controller 상태와 원래 enabled/running
   설정을 보존하고, 변경 한 가지와 rollback 방법을 확정한다.
2. 중복 제어 제거 등 승인된 조치만 적용한다. 초기 수렴 중 step 가능성을 고려해
   금융 테스트를 실행하지 않는다. VM 재시작이 필요하면 진행 작업을 먼저 저장한다.
3. 동일 Phase B 180초와 Phase C 120초를 다시 실행한다. 역행 및 유의미한
   불연속 0회, mono/raw/QPC 진행률의 수 % 차이 해소, chrony offset/frequency
   안정화, timesyncd step 반복 제거를 함께 평가한다.
4. Windows NTP가 unsynchronized인 상태에서는 host와의 일치만으로 UTC 정확성을
   주장하지 않는다. 신뢰 가능한 외부 기준의 상태도 별도로 확인한다.
5. 최소 관측 통과 후 평상시 개발 및 승인된 절전/재개 조건에서 지속성을 확인한다.
   짧은 구간의 0회는 영구 해결 보장이 아니다.
6. 시계 안정화 이후 기존 최소 금융 재현 → 관련 PG 테스트 → 전체 금융 PG gate를
   **별도 요청/단계**로 실행한다.

## 8. 변경 파일과 안전성

추가 파일은 이 디렉터리의 `report.md`, `verification.json`, `evidence/`,
`reproduction/`이며 기존 금융 조사 report에 후속 링크만 추가했다.
애플리케이션 코드·테스트·DB·시스템 설정·레지스트리는 변경하지 않았다.
기존 frontend 사용자 변경은 보존했다. commit/push/메시지 전송은 없다.
NTP 서비스 조작, resync, clocksource 수정, reboot/shutdown, 금융 gate와 성능
테스트는 실행하지 않았다. 관측은 최대 약 3분의 가벼운 bounded process로 종료했다.
Frontend 변경이 없어 frontend typecheck/lint는 해당 없음이다.

**LAYER_IDENTIFIED — WSL 계층과 매우 유력한 timesyncd step/PHC chrony 충돌 경로 식별;
시스템 변경 없이 조사 완료, 충돌 제거 비교와 직접 syscall attribution은 후속 과제.**
