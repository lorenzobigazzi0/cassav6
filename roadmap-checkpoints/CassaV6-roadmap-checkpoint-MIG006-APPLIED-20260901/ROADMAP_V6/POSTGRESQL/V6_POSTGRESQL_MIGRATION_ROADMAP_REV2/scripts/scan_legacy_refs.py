#!/usr/bin/env python3
from pathlib import Path
import sys,csv,re
root=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
backend=root/'backend' if (root/'backend').exists() else root
patterns=['readDb(','writeDb(','node:sqlite','mysql2','app_state','app_state_domain_records','BACKEND_RELATIONAL_DB_PATH']
print('pattern,file,line,code')
for p in backend.rglob('*'):
    if not p.is_file() or p.suffix not in {'.js','.mjs','.ts','.sql','.sh','.json'}: continue
    if any(x in p.parts for x in ('node_modules','dist')): continue
    for n,line in enumerate(p.read_text(errors='ignore').splitlines(),1):
        for pat in patterns:
            if pat in line:
                row=[pat,str(p.relative_to(root)),str(n),line.strip()]
                print(','.join('"'+v.replace('"','""')+'"' for v in row))
