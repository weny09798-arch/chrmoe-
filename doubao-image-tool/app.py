"""Token-protected loopback UI; browser work is owned by QueueService."""
import hmac
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit
from flask import Flask, request, jsonify, send_file, render_template
from core import QueueService, StorageFailure
from prompts import build_prompt

def create_app(browser_factory=None, state_dir=None, output_default=None, token=None):
    root = Path(state_dir or Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'DoubaoImageTool')
    if browser_factory is None:
        from browser import DoubaoBrowser
        browser_factory = lambda: DoubaoBrowser(root / 'chrome-profile')
    app = Flask(__name__, static_folder='web', static_url_path='/static', template_folder='web')
    app.config.update(TOOL_TOKEN=token or secrets.token_urlsafe(32), MAX_CONTENT_LENGTH=81 * 1024 * 1024)
    queue = QueueService(browser_factory, root / 'state')
    app.extensions['queue'] = queue

    @app.before_request
    def guard():
        host = urlsplit('http://' + request.host)
        if host.hostname not in {'127.0.0.1', 'localhost'}: return jsonify(error='拒绝非本机访问'), 403
        origin = request.headers.get('Origin')
        if origin and origin != request.host_url.rstrip('/'): return jsonify(error='拒绝外部网页访问'), 403
        if request.path.startswith('/api/'):
            provided = request.headers.get('X-Tool-Token', '')
            if request.path.startswith('/api/images/'): provided = request.args.get('token', provided)
            if not hmac.compare_digest(provided, app.config['TOOL_TOKEN']): return jsonify(error='访问凭证无效，请重新打开工具页面'), 403

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'"
        return response

    @app.errorhandler(ValueError)
    def invalid(exc): return jsonify(error=str(exc)), 400
    @app.errorhandler(RuntimeError)
    def conflict(exc): return jsonify(error=str(exc)), 409
    @app.errorhandler(OSError)
    def file_error(exc): return jsonify(error=f'本机文件操作失败：{exc}'), 400
    @app.errorhandler(413)
    def too_large(exc): return jsonify(error='总大小不能超过 80MB'), 413

    @app.get('/')
    def index(): return render_template('index.html', output_default=str(output_default or Path.home() / 'Pictures' / '豆包繁体结果'))

    @app.get('/api/state')
    def state(): return jsonify(queue.snapshot())

    @app.post('/api/jobs')
    def jobs():
        output = request.form.get('output_dir', '').strip()
        if not output: raise ValueError('请填写本机输出文件夹')
        folder = Path(output).expanduser()
        if not folder.is_absolute(): raise ValueError('输出文件夹必须使用完整路径，例如 D:\\图片结果')
        files = [(f.filename or '', f.stream.read()) for f in request.files.getlist('files')]
        prompt = build_prompt(request.form.get('background') == 'true', request.form.get('typography') == 'true', request.form.get('extra', ''))
        queue.start(files, folder, prompt)
        return jsonify(queue.snapshot())

    @app.post('/api/action')
    def action():
        body = request.get_json(silent=True) or {}
        if body.get('action') == 'open-browser': queue.open_browser()
        else:
            index = body.get('index')
            if index is not None and (not isinstance(index, int) or isinstance(index, bool)): raise ValueError('请选择有效图片')
            queue.action(body.get('action'), index)
        return jsonify(queue.snapshot())

    @app.get('/api/images/<job>/<int:index>/<kind>')
    def image(job, index, kind):
        try:
            snap = queue.snapshot(job)
            item = snap['items'][index]
            path = item['input_path'] if kind == 'original' else item['result']['output_path'] if kind == 'result' and item['result'] else None
            if path is None: return jsonify(error='图片尚未生成'), 404
            return send_file(path)
        except (KeyError, IndexError, TypeError): return jsonify(error='图片不存在'), 404

    @app.post('/api/exit')
    def exit_app():
        shutdown = app.extensions.get('shutdown')
        if shutdown:
            import threading
            threading.Thread(target=shutdown, daemon=True).start()
        else: queue.close()
        return jsonify(message='工具正在关闭')
    return app
