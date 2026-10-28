#!/usr/bin/env python3
"""Build a standalone dashboard using only local, allowlisted historical JSON."""
from pathlib import Path
import json
import sys
root = Path(__file__).resolve().parents[2]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'reports/dashboard.html'
if output.exists():
    raise SystemExit('Painel já existe; escolha outro destino para preservar a edição anterior.')
reports = [json.loads((root / f'docs/benchmarks/results-{n}.json').read_text()) for n in ['002', '003', '004']]
data = json.dumps(reports, ensure_ascii=False).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
model = (root / 'scripts/reports/model.js').read_text()
html = (root / 'scripts/reports/dashboard.html').read_text().replace('/* MODEL */', model).replace('/* DATA */', data)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(html)
print(f'Painel gerado: {output}')
