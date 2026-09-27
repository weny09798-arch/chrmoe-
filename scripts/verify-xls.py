"""Compare a real BIFF8 export against the supplied user template using xlrd.

Read-only QA. Install xlrd into tmp_xls_reader for this script if needed.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath('tmp_xls_reader'))
import xlrd

source_path = '导入产品模板.xls'
source_book = xlrd.open_workbook(source_path, ignore_workbook_corruption=True, formatting_info=True)
source = source_book.sheet_by_index(0)
code = """
import * as XLSX from 'xlsx';
import {workbookXlsBytes,taskSheets} from './extension/lib/xlsx.mjs';
const task={jobs:[{keyword:'相机',groups:[{best:{id:'123',title:'=1+1 相机',cents:2988,url:'https://mobile.pinduoduo.com/goods.html?goods_id=123',image:'https://img.pddpic.com/test.jpg'}}]}]};
process.stdout.write(workbookXlsBytes(taskSheets(task),XLSX));
"""
data = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True, check=True).stdout
book = xlrd.open_workbook(file_contents=data, formatting_info=True)
sheet = book.sheet_by_index(0)
assert sheet.name == source.name == '模版'
assert sheet.ncols == source.ncols == 22
if sheet.cell_value(0, 0) != source.cell_value(0, 0):
    original, generated = source.cell_value(0, 0), sheet.cell_value(0, 0)
    mismatch = next((i for i, (a, b) in enumerate(zip(original, generated)) if a != b), min(len(original), len(generated)))
    print('Instruction mismatch', len(original), len(generated), mismatch, repr(original[mismatch - 20:mismatch + 70]), repr(generated[mismatch - 20:mismatch + 70]))
assert sheet.cell_value(0, 0) == source.cell_value(0, 0)
assert sheet.merged_cells == source.merged_cells == [(0, 8, 0, 12)]
for column in range(22):
    assert sheet.cell_value(8, column) == source.cell_value(8, column), column
    assert abs(sheet.colinfo_map[column].width - source.colinfo_map[column].width) <= 2, column
for row, column in [(0, 0), *[(8, c) for c in range(22)], (9, 0), (9, 1), (9, 17)]:
    generated_xf = book.xf_list[sheet.cell_xf_index(row, column)]
    original_xf = source_book.xf_list[source.cell_xf_index(row, column)]
    generated_font = book.font_list[generated_xf.font_index]
    original_font = source_book.font_list[original_xf.font_index]
    assert (generated_font.name, generated_font.height, generated_font.colour_index) == (original_font.name, original_font.height, original_font.colour_index), (row, column)
    assert (generated_xf.alignment.hor_align, generated_xf.alignment.vert_align, generated_xf.border.left_line_style, generated_xf.background.fill_pattern) == (original_xf.alignment.hor_align, original_xf.alignment.vert_align, original_xf.border.left_line_style, original_xf.background.fill_pattern), (row, column)
assert [sheet.cell_value(9, i) for i in [0, 1, 2, 3, 4, 5, 6, 17]] == [
    'PDD123', '=1+1 相机', 'CNY', 'https://img.pddpic.com/test.jpg',
    'https://mobile.pinduoduo.com/goods.html?goods_id=123', '拼多多', '123', '29.88',
]
assert sheet.cell(9, 17).ctype == source.cell(9, 17).ctype == xlrd.XL_CELL_TEXT
print('Independent BIFF8 read passed: template instructions, merged area, 22 headers, visual cell styles, widths and product data.')
