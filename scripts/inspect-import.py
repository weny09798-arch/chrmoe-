"""Read-only comparison of the user's template and the downloaded export."""
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath('tmp_xls_reader'))
import xlrd

paths = [
    r'D:\Desktop\chrome插件\导入产品模板.xls',
    r'D:\Desktop\拼多多商品链接_2026-09-27.xls',
]

for path in paths:
    book = xlrd.open_workbook(path, ignore_workbook_corruption=True, formatting_info=True)
    sheet = book.sheet_by_index(0)
    print('\nFILE', path, 'bytes', os.path.getsize(path), 'sheets', book.sheet_names())
    print('shape', sheet.nrows, sheet.ncols, 'merged', sheet.merged_cells)
    for row in [0, 8, 9, 10]:
        if row >= sheet.nrows:
            continue
        print('ROW', row + 1)
        for col in range(min(sheet.ncols, 22)):
            cell = sheet.cell(row, col)
            if cell.value not in ('', None):
                value = str(cell.value).replace('\n', ' ')
                print(col + 1, repr(value[:160]), 'type', cell.ctype, 'xf', cell.xf_index)
    print('column widths', [(col, info.width) for col, info in sorted(sheet.colinfo_map.items())[:22]])
    print('row heights', [(row, info.height) for row, info in sorted(sheet.rowinfo_map.items())[:10]])

code = "import fs from 'node:fs'; import * as XLSX from 'xlsx'; const b=XLSX.read(fs.readFileSync('导入产品模板.xls'),{type:'buffer',cellStyles:true}); process.stdout.write(XLSX.write(b,{bookType:'biff8',type:'buffer',cellStyles:true,bookSST:true}));"
clone = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True, check=True).stdout
sheet = xlrd.open_workbook(file_contents=clone, formatting_info=True).sheet_by_index(0)
print('\nROUNDTRIP', 'bytes', len(clone), 'shape', sheet.nrows, sheet.ncols, 'merged', sheet.merged_cells)
print('styles', [(ref, sheet.cell(*ref).xf_index) for ref in [(0, 0), (8, 0), (8, 2), (9, 0), (9, 17)]])
print('column widths', [(col, info.width) for col, info in sorted(sheet.colinfo_map.items())[:22]])
