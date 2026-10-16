// Preload: event-loop delay + heap/RSS every 15 s to SOAK_PROBE_FILE (JSONL).
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const file = process.env.SOAK_PROBE_FILE;
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let last = process.cpuUsage();
let lastAt = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage(last);
  const wallUs = Number(now - lastAt) / 1000;
  last = process.cpuUsage(); lastAt = now;
  const m = process.memoryUsage();
  fs.appendFileSync(file, JSON.stringify({
    at: new Date().toISOString(),
    loopP50Ms: h.percentile(50) / 1e6, loopP99Ms: h.percentile(99) / 1e6, loopMaxMs: h.max / 1e6,
    cpuPercent: +(100 * (cpu.user + cpu.system) / wallUs).toFixed(1),
    rssMb: +(m.rss / 1e6).toFixed(1), heapUsedMb: +(m.heapUsed / 1e6).toFixed(1),
  }) + '\n');
  h.reset();
}, 15000).unref();
