"""Read clocks only. One Windows process; bounded 180s observation and logs."""
import base64
import datetime
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'evidence'
PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

def utc(ns):
    return datetime.datetime.fromtimestamp(ns / 1e9, datetime.timezone.utc).isoformat()

script = (ROOT / 'reproduction/windows-probe.ps1').read_text()
encoded = base64.b64encode(script.encode('utf-16-le')).decode()
with (OUT / 'windows-probe.stderr.log').open('w') as err:
    proc = subprocess.Popen([PS, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                            stdout=subprocess.PIPE, stderr=err, text=True)
    # Windows emits its start marker before Linux starts: no comparison of unrelated
    # monotonic epochs is needed to establish concurrent observation.
    import select
    if not select.select([proc.stdout], [], [], 20)[0]:
        proc.terminate()
        proc.wait(timeout=10)
        raise RuntimeError('Windows probe did not signal readiness within 20s')
    start_line = proc.stdout.readline()
    windows_start_received = time.monotonic_ns()
    windows_start = json.loads(start_line)
    if windows_start.get('kind') != 'start':
        raise RuntimeError('Invalid Windows start marker')
    last_wall, last_mono = time.time_ns(), time.monotonic_ns()
    started = last_mono
    samples = events = backwards = 0
    max_gap = 0.0
    with (OUT / 'wsl-wallclock.jsonl').open('w') as log:
        def emit(obj):
            log.write(json.dumps(obj) + '\n')
            log.flush()
        emit(dict(kind='start', environment='WSL', utc=utc(last_wall),
                  wallUnixNs=last_wall, monotonicNs=last_mono, durationSeconds=180,
                  windowsStartReceivedMonotonicNs=windows_start_received))
        while time.monotonic_ns() - started < 180_000_000_000:
            time.sleep(.002)
            wall, mono = time.time_ns(), time.monotonic_ns()
            dw, dm = (wall-last_wall)/1e6, (mono-last_mono)/1e6
            samples += 1
            max_gap = max(max_gap, dm)
            backwards += dw < 0
            if (dw < 0 or abs(dw-dm) > 20) and events < 1000:
                emit(dict(kind='discontinuity', utc=utc(wall), wallUnixNs=wall,
                          previousWallUnixNs=last_wall, monotonicNs=mono,
                          elapsedMs=(mono-started)/1e6, wallDeltaMs=dw,
                          monotonicDeltaMs=dm, differenceMs=dw-dm, sample=samples))
                events += 1
            last_wall, last_mono = wall, mono
        emit(dict(kind='summary', utc=utc(last_wall), monotonicNs=last_mono,
                  elapsedMs=(last_mono-started)/1e6, samples=samples,
                  events=events, backwards=backwards, maxSampleGapMs=max_gap))
    try:
        rest, _ = proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        proc.terminate()  # Only the observer created by this script.
        rest, _ = proc.communicate(timeout=10)
        raise RuntimeError('Windows probe exceeded bounded runtime')
    (OUT / 'windows-wallclock.jsonl').write_text(start_line + rest)
    rows = [json.loads(s) for s in (start_line + rest).splitlines()]
    assert proc.returncode == 0 and rows[-1]['kind'] == 'summary'
    print(json.dumps(dict(windows=rows[-1], wslSamples=samples, wslEvents=events,
                          wslBackwards=backwards, windowsStartedBeforeLinux=True)))
