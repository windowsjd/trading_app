// Detect wall-clock steps: compare Date.now() deltas with monotonic deltas every 50ms.
const { performance } = require('node:perf_hooks');
let lastWall = Date.now(), lastMono = performance.now(); const steps = [];
const end = Date.now() + Number(process.argv[2] || 70) * 1000;
const t = setInterval(() => {
  const wall = Date.now(), mono = performance.now();
  const drift = (wall - lastWall) - (mono - lastMono);
  if (Math.abs(drift) > 20) steps.push({ at: new Date(wall).toISOString(), stepMs: Math.round(drift) });
  lastWall = wall; lastMono = mono;
  if (performance.now() > 0 && wall > end + 1e9) clearInterval(t);
}, 50);
setTimeout(() => { clearInterval(t); console.log(JSON.stringify({ seconds: Number(process.argv[2] || 70), steps })); }, Number(process.argv[2] || 70) * 1000);
