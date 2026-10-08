$ErrorActionPreference = 'Stop'
$duration = 180.0
$frequency = [Diagnostics.Stopwatch]::Frequency
$lastWall = [DateTime]::UtcNow.Ticks
$lastMono = [Diagnostics.Stopwatch]::GetTimestamp()
$started = $lastMono
$samples = 0; $events = 0; $backwards = 0; $minDelta = 0.0; $maxGap = 0.0
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
Emit @{kind='start';environment='Windows';utc=([DateTime]::new($lastWall,[DateTimeKind]::Utc)).ToString('o');wallTicks=$lastWall;monotonicTicks=$lastMono;frequency=$frequency;durationSeconds=$duration}
while (([Diagnostics.Stopwatch]::GetTimestamp()-$started)/$frequency -lt $duration) {
  [Threading.Thread]::Sleep(2)
  $wall = [DateTime]::UtcNow.Ticks
  $mono = [Diagnostics.Stopwatch]::GetTimestamp()
  $dw = ($wall-$lastWall)/10000.0
  $dm = ($mono-$lastMono)*1000.0/$frequency
  $diff = $dw-$dm
  $samples++
  if ($dw -lt 0) { $backwards++ }
  $minDelta = [Math]::Min($minDelta,$diff); $maxGap = [Math]::Max($maxGap,$dm)
  if (($dw -lt 0 -or [Math]::Abs($diff) -gt 20) -and $events -lt 1000) {
    Emit @{kind='discontinuity';utc=([DateTime]::new($wall,[DateTimeKind]::Utc)).ToString('o');wallTicks=$wall;previousWallTicks=$lastWall;monotonicTicks=$mono;elapsedMs=($mono-$started)*1000.0/$frequency;wallDeltaMs=$dw;monotonicDeltaMs=$dm;differenceMs=$diff;sample=$samples}
    $events++
  }
  $lastWall=$wall; $lastMono=$mono
}
Emit @{kind='summary';utc=[DateTime]::UtcNow.ToString('o');monotonicTicks=[Diagnostics.Stopwatch]::GetTimestamp();elapsedMs=([Diagnostics.Stopwatch]::GetTimestamp()-$started)*1000.0/$frequency;samples=$samples;events=$events;backwards=$backwards;minDifferenceMs=$minDelta;maxSampleGapMs=$maxGap}
