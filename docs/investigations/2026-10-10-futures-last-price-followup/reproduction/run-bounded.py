#!/usr/bin/env python3
"""Record a command's log, whole-process-group RSS and wall/monotonic drift.
Usage: run-bounded.py LOG.json SECONDS RSS_MIB -- COMMAND [ARGS...]
No connection defaults; callers must explicitly supply disposable DB/Redis URLs.
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

report = Path(sys.argv[1])
deadline = float(sys.argv[2])
memory_limit = int(sys.argv[3]) * 1024
command = sys.argv[5:]
report.parent.mkdir(parents=True, exist_ok=True)
started_wall, started = time.time(), time.monotonic()
steps, samples = [], []
last_wall, last_mono = started_wall, started
reason = None
with report.with_suffix('.log').open('w') as log:
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    while child.poll() is None:
        wall, mono = time.time(), time.monotonic()
        drift = (wall - last_wall) - (mono - last_mono)
        if abs(drift) > 0.020:
            steps.append({'elapsedSeconds': mono - started, 'stepMs': drift * 1000})
        last_wall, last_mono = wall, mono
        processes = subprocess.run(['ps', '-eo', 'pgid=,rss='], capture_output=True, text=True, check=True)
        rss = sum(int(line.split()[1]) for line in processes.stdout.splitlines() if int(line.split()[0]) == child.pid)
        samples.append({'elapsedSeconds': round(mono - started, 3), 'rssMiB': round(rss / 1024, 1)})
        if mono - started > deadline or rss > memory_limit:
            reason = 'timeout' if mono - started > deadline else 'process_group_memory_limit'
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            # Drain/kill remaining children even if the parent exited promptly.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break
        time.sleep(0.1)
    code = child.wait()
result = {
    'command': command, 'startedAtUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(started_wall)),
    'elapsedSeconds': round(time.monotonic() - started, 3), 'exitCode': code,
    'terminationReason': reason, 'peakProcessGroupRssMiB': max((s['rssMiB'] for s in samples), default=0),
    'clockSteps': steps, 'rssSamples': samples[::100],
}
report.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'rssSamples'}))
sys.exit(code if code >= 0 and reason is None else 1)
