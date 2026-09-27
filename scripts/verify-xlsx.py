"""Independently read the application's generated workbook; no spreadsheet authoring library."""
import io
import subprocess
import warnings
import zipfile
import xml.etree.ElementTree as ET
import openpyxl

code = """
import {workbookBytes,taskSheets} from './extension/lib/xlsx.mjs';
const task={jobs:[{keyword:'CCD数码相机',scanned:200,skipped:2,status:'done',note:'样例验证',groups:[{best:{id:'123',title:'=1+1 中文相机',cents:2988,url:'https://mobile.pinduoduo.com/goods.html?goods_id=123',image:'https://img.pddpic.com/test.jpg',collectedAt:'2026-09-26T00:00:00Z'}}]}]};
process.stdout.write(workbookBytes(taskSheets(task)));
"""
data = subprocess.run(['node', '--input-type=module', '-e', code], check=True, capture_output=True).stdout
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        if name.endswith(('.xml', '.rels')):
            ET.fromstring(archive.read(name))
with warnings.catch_warnings():
    warnings.simplefilter('error')
    book = openpyxl.load_workbook(io.BytesIO(data))
assert book.sheetnames == ['模版']
sheet = book['模版']
assert sheet['A1'].value.startswith('各个字段说明：')
assert sheet['A9'].value == '*产品主编号'
assert sheet['V9'].value == 'SKU尺寸(CM)'
assert sheet['A10'].value == 'PDD123'
assert sheet['B10'].data_type == 's'
assert sheet['B10'].value == '=1+1 中文相机'
assert sheet['C10'].value == 'CNY'
assert sheet['E10'].hyperlink.target.endswith('goods_id=123')
assert sheet['F10'].value == '拼多多'
assert sheet['R10'].value == '29.88'
assert sheet.freeze_panes == 'A10'
assert str(sheet.merged_cells) == 'A1:L8'
print('Independent XLSX read passed: ZIP CRC, XML, template headers, Chinese text, literal formula text, price, source link, merged introduction.')
