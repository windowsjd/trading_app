"""Read timesyncd D-Bus once a second; retain only changed NTP messages."""
import json
import pathlib
import subprocess
import time

out = pathlib.Path(__file__).resolve().parent.parent / 'evidence/timesync-monitor.jsonl'
started = time.monotonic_ns()
previous = None
with out.open('w') as log:
    while time.monotonic_ns() - started < 170_000_000_000:
        result = subprocess.run(['timedatectl', 'show-timesync', '--all'],
                                capture_output=True, text=True, timeout=4)
        if result.stdout != previous:
            log.write(json.dumps(dict(wallUnixNs=time.time_ns(),
                                      monotonicNs=time.monotonic_ns(),
                                      state=result.stdout, error=result.stderr,
                                      returncode=result.returncode)) + '\n')
            log.flush()
            previous = result.stdout
        time.sleep(1)
