"""Short-lived native picker, isolated from the server/browser worker."""
import json
import os
from pathlib import Path
import subprocess
import sys

def native_folder():
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        return filedialog.askdirectory(parent=root, title='选择图片转换结果保存文件夹', mustexist=True) or ''
    finally:
        root.destroy()

def choose_folder():
    launcher = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__).with_name('run.py'))]
    result = subprocess.run(launcher + ['--choose-folder'], capture_output=True, text=True, encoding='utf-8',
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0, check=False)
    if result.returncode != 0: raise RuntimeError('无法打开本机文件夹选择窗口')
    try:
        value = json.loads(result.stdout)
        path = value['path']
        if not isinstance(path,str): raise ValueError
        return path
    except (ValueError,KeyError,TypeError):
        raise RuntimeError('文件夹选择结果无效') from None
