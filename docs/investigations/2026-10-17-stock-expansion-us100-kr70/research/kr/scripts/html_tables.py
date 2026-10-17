#!/usr/bin/env python3
"""Minimal stdlib HTML table extractor used by the KR-70 study scripts.

Imported by the other scripts via an explicit sys.path entry for this
scripts directory (the scripts run with ``python3 -I``). Can also be run
directly to preview a table: ``python3 -I html_tables.py FILE [N]``.
"""
from __future__ import annotations

import re
import sys
from html.parser import HTMLParser


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._cell is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._cell is not None:  # unclosed cell
                self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
                self._cell = None
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def read_rows(path: str) -> list[list[str]]:
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    parser = _TableParser()
    parser.feed(text)
    parser.close()
    return [r for r in parser.rows if any(c for c in r)]


def read_dicts(path: str, header_contains: str) -> list[dict[str, str]]:
    """Rows as dicts keyed by the first row that contains ``header_contains``."""
    rows = read_rows(path)
    for i, row in enumerate(rows):
        if any(header_contains in c for c in row):
            header = row
            out = []
            for r in rows[i + 1:]:
                if len(r) < len(header) // 2:
                    continue
                out.append({header[j]: (r[j] if j < len(r) else "") for j in range(len(header))})
            return out
    return []


if __name__ == "__main__":
    rows = read_rows(sys.argv[1])
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    print(len(rows), "rows")
    for r in rows[:n]:
        print(r)
