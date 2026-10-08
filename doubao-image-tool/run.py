"""Random-port localhost launcher. Chrome opens only on a user command."""
import argparse
import json
import os
import sys
import webbrowser
from pathlib import Path
from werkzeug.serving import make_server, WSGIRequestHandler
from app import create_app

class PrivateRequestHandler(WSGIRequestHandler):
    # Preview URLs carry short-lived credentials. Never echo request URLs.
    def log(self, type, message, *args): pass

class InstanceLock:
    def __init__(self, root):
        root.mkdir(parents=True, exist_ok=True)
        self.file = (root / 'instance.lock').open('a+b')
    def acquire(self):
        self.file.seek(0); self.file.write(b'0'); self.file.flush(); self.file.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def close(self): self.file.close()

def main():
    parser = argparse.ArgumentParser(description='Doubao image Simplified-to-Traditional local tool')
    parser.add_argument('--no-open', action='store_true', help='Do not open the local UI browser')
    parser.add_argument('--choose-folder', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--download-image', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--aliyun-translate', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--aliyun-result', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--oss-publish', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--state-dir', type=Path, help='Local profile/state directory (default LOCALAPPDATA/DoubaoImageTool)')
    args = parser.parse_args()
    if args.oss_publish:
        from oss_storage import oss_helper_main
        return oss_helper_main()
    if args.aliyun_translate:
        from aliyun_translation import translate_helper_main
        return translate_helper_main()
    if args.aliyun_result:
        from aliyun_translation import result_helper_main
        return result_helper_main()
    if args.download_image:
        from image_batch import download_helper_main
        return download_helper_main()
    if args.choose_folder:
        from folder_picker import native_folder
        print(json.dumps({'path': native_folder()}, ensure_ascii=True), flush=True)
        return 0
    root = args.state_dir or Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'DoubaoImageTool'
    lock = InstanceLock(root)
    try: lock.acquire()
    except OSError:
        print('工具或专用 Chrome 配置正在使用中，请关闭已有工具后重试。', file=sys.stderr); lock.close(); return 1
    app = server = None
    try:
        app = create_app(state_dir=root)
        server = make_server('127.0.0.1', 0, app, threaded=True, request_handler=PrivateRequestHandler)
        app.extensions['shutdown'] = server.shutdown
        url = f"http://127.0.0.1:{server.server_port}/#token={app.config['TOOL_TOKEN']}"
        print(f'本机工具已启动：http://127.0.0.1:{server.server_port}/（连接码请在工具页面复制）', flush=True)
        if not args.no_open: webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        if app: app.extensions['queue'].close(clear_state=True)
        if server: server.server_close()
        lock.close()
    return 0

if __name__ == '__main__': raise SystemExit(main())
