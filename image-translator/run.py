"""Start the local tool; a console remains available for Ctrl+C shutdown."""
import argparse
import logging
import sys
import webbrowser
from pathlib import Path

from werkzeug.serving import make_server
from app import create_app


def main():
    parser = argparse.ArgumentParser(description='Local Traditional Chinese image converter')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--output-dir')
    args = parser.parse_args()
    base = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
    app = create_app(output_default=args.output_dir or base / '繁体图片输出')
    server = make_server('127.0.0.1', args.port, app, threaded=True)
    app.extensions['shutdown'] = server.shutdown
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    url = f'http://127.0.0.1:{server.server_port}/'
    print(f'Local URL: {url}', flush=True)
    print('Keep this window open. Press Ctrl+C to exit.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.extensions['image_service'].close()


if __name__ == '__main__':
    main()
