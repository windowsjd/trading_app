"""120s Windows reference vs Linux monotonic/raw, plus exact NTP timestamps.

No clock writes, tracing configuration, service changes, or extra dependencies.
"""
import base64
import json
import pathlib
import subprocess
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
script = r'''
$ErrorActionPreference='Stop'
$freq=[Diagnostics.Stopwatch]::Frequency
$start=[Diagnostics.Stopwatch]::GetTimestamp()
while ($true) {
  $mono=[Diagnostics.Stopwatch]::GetTimestamp()
  $wall=[DateTime]::UtcNow.Ticks
  [Console]::Out.WriteLine((@{kind='reference';wallTicks=$wall;monotonicTicks=$mono;frequency=$freq;elapsedSeconds=($mono-$start)/$freq} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  if (($mono-$start)/$freq -ge 120) { break }
  [Threading.Thread]::Sleep(1000)
}
'''
encoded = base64.b64encode(script.encode('utf-16-le')).decode()
lock = threading.Lock()
done = threading.Event()
with (ROOT/'evidence/reference-probe.jsonl').open('w') as log, (ROOT/'evidence/reference-probe.stderr.log').open('w') as err:
    def emit(row):
        with lock:
            log.write(json.dumps(row)+'\n')
            log.flush()
    proc = subprocess.Popen(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
                            stdout=subprocess.PIPE,stderr=err,text=True)
    def references():
        for line in proc.stdout:
            before = time.monotonic_ns()
            raw = time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)
            wall = time.time_ns()
            row=json.loads(line)
            row.update(linuxMonotonicNs=before,linuxRawNs=raw,linuxWallUnixNs=wall)
            emit(row)
        done.set()
    def ntp():
        previous = None
        while not done.is_set():
            r = subprocess.run(['busctl','--json=short','get-property','org.freedesktop.timesync1',
                                '/org/freedesktop/timesync1','org.freedesktop.timesync1.Manager','NTPMessage'],
                               capture_output=True,text=True,timeout=4)
            if r.stdout != previous:
                emit(dict(kind='ntp',linuxMonotonicNs=time.monotonic_ns(),linuxWallUnixNs=time.time_ns(),
                          synchronizedMtimeNs=pathlib.Path('/run/systemd/timesync/synchronized').stat().st_mtime_ns,
                          response=json.loads(r.stdout) if r.returncode==0 else None,error=r.stderr))
                previous = r.stdout
            done.wait(.5)
    reader = threading.Thread(target=references)
    monitor = threading.Thread(target=ntp)
    reader.start(); monitor.start()
    last_wall,last_mono=time.time_ns(),time.monotonic_ns()
    started=last_mono; count=0; events=0
    emit(dict(kind='linux_start',wallUnixNs=last_wall,monotonicNs=last_mono))
    while not done.is_set() and time.monotonic_ns()-started < 150_000_000_000:
        time.sleep(.002)
        wall,mono=time.time_ns(),time.monotonic_ns()
        count+=1
        dw,dm=(wall-last_wall)/1e6,(mono-last_mono)/1e6
        if (dw<0 or abs(dw-dm)>20) and events<1000:
            emit(dict(kind='discontinuity',wallUnixNs=wall,previousWallUnixNs=last_wall,
                      monotonicNs=mono,wallDeltaMs=dw,monotonicDeltaMs=dm,differenceMs=dw-dm))
            events+=1
        last_wall,last_mono=wall,mono
    if not done.is_set():
        proc.terminate()
    proc.wait(timeout=10)
    done.set(); reader.join(timeout=5); monitor.join(timeout=5)
    emit(dict(kind='linux_summary',elapsedMs=(last_mono-started)/1e6,samples=count,events=events,
              wallUnixNs=last_wall,monotonicNs=last_mono,windowsExit=proc.returncode))
    assert proc.returncode==0
    print(json.dumps(dict(events=events,samples=count,elapsedMs=(last_mono-started)/1e6)))
