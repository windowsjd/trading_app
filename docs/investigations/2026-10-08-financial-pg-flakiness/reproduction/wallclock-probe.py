import time,json,pathlib
out=pathlib.Path('/tmp/finance-pg-investigation/wallclock.jsonl')
last_wall=time.time_ns(); last_mono=time.monotonic_ns(); started=last_mono; count=0
with out.open('w') as log:
 while time.monotonic_ns()-started < 120_000_000_000:
  time.sleep(.001); wall=time.time_ns(); mono=time.monotonic_ns()
  dw=(wall-last_wall)/1e6; dm=(mono-last_mono)/1e6
  if dw<0 or abs(dw-dm)>20:
   log.write(json.dumps({'wallUnixNs':wall,'previousWallUnixNs':last_wall,'wallDeltaMs':dw,'monotonicDeltaMs':dm,'sample':count})+'\n'); log.flush()
  last_wall=wall;last_mono=mono;count+=1
 log.write(json.dumps({'samples':count,'elapsedMs':(time.monotonic_ns()-started)/1e6})+'\n')
print(out.read_text())
