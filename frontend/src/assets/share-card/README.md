# 수익 공유 카드 art

Decorative art of the 수익 공유 card (`src/components/share/TradeShareCard.tsx`).

- Source: the approved card design `트레이딩 클래스 수익 카드(1).png` (1024×1536,
  2026-11-06), supplied by the product owner for this feature.
- `whale.png` — the whale with its waves and spray (design x 405–1001,
  y 22–536); `wave.png` — the lower wave (design x 6–1006, y 995–1272).
- Processing: each region was keyed against the design's navy background
  (#011a3a: alpha = the least opacity that keeps the colour in range, colour
  un-mixed from that navy), the edges that would cut the art were feathered,
  the design's text inside the region (nickname/date, contract name) was masked
  out, and the result was quantised to a 256-colour palette PNG. No text, figure
  or profile from the design is in these files: every card text is rendered at
  run time.

The card's own navy gradient matches that background where the art sits, so the
art blends in without a visible edge.
