"""Paired extension bridge; the existing queue remains the sole browser owner."""
import hmac
import re
from pathlib import Path
from flask import request, jsonify, send_file
from folder_picker import choose_folder
from prompts import build_prompt

EXTENSION_ID = re.compile(r'[a-p]{32}\Z')
ALLOWED_HEADERS = {'content-type', 'x-tool-token', 'x-extension-id'}

def register_bridge(app, get_queue, lifecycle, private_root, reset_queue, credential_status=None):
    paired = None
    private_root = Path(private_root).resolve()

    def forbidden():
        return jsonify(error='采集插件连接无效，请重新配对'), 403

    def origin_id():
        origin = request.headers.get('Origin', '')
        prefix = 'chrome-extension://'
        extension = origin[len(prefix):] if origin.startswith(prefix) else ''
        return extension if EXTENSION_ID.fullmatch(extension) else None

    @app.before_request
    def bridge_guard():
        if not request.path.startswith('/api/bridge/'):
            return
        nonlocal paired
        is_pair = request.path == '/api/bridge/pair'
        origin = request.headers.get('Origin')
        if request.method == 'OPTIONS':
            extension = origin_id()
            headers = {h.strip().lower() for h in request.headers.get('Access-Control-Request-Headers','').split(',') if h.strip()}
            method = request.headers.get('Access-Control-Request-Method')
            expected = 'GET' if request.path.startswith(('/api/bridge/state', '/api/bridge/capabilities', '/api/bridge/manifest', '/api/bridge/images/')) else 'POST'
            if not extension or (paired != extension and not (is_pair and paired is None)) or not headers.issubset(ALLOWED_HEADERS) or method != expected:
                return forbidden()
            return '', 204
        provided = request.headers.get('X-Tool-Token', '')
        if request.path.startswith('/api/bridge/images/'):
            provided = request.args.get('token', provided)
        if not hmac.compare_digest(provided.encode('utf-8'), app.config['TOOL_TOKEN'].encode('utf-8')):
            return forbidden()
        extension = request.headers.get('X-Extension-Id', '')
        if request.path.startswith('/api/bridge/images/'):
            extension = request.args.get('extension_id', extension)
        if not EXTENSION_ID.fullmatch(extension) or (origin and origin_id() != extension):
            return forbidden()
        with lifecycle:
            if is_pair:
                body = request.get_json(silent=True)
                if not isinstance(body, dict) or body.get('extension_id') != extension or (paired and paired != extension):
                    return forbidden()
                paired = extension
            elif paired != extension:
                return forbidden()

    @app.after_request
    def bridge_cors(response):
        if request.path.startswith('/api/bridge/') and origin_id() and response.status_code != 403:
            response.headers['Access-Control-Allow-Origin'] = request.headers['Origin']
            response.headers['Vary'] = 'Origin'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Tool-Token, X-Extension-Id'
            response.headers['Access-Control-Expose-Headers'] = 'Content-Disposition'
        return response

    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict): raise ValueError('请求内容无效')
        return value

    def output_folder(value):
        if not isinstance(value, str) or not value.strip(): raise ValueError('请选择本机输出文件夹')
        folder = Path(value.strip()).expanduser()
        if not folder.is_absolute(): raise ValueError('输出文件夹必须使用完整路径')
        folder = folder.resolve()
        if folder == private_root or private_root in folder.parents:
            raise ValueError('输出文件夹不能使用工具缓存或登录目录')
        if folder.exists() and not folder.is_dir(): raise ValueError('输出位置必须是文件夹')
        return folder

    def owned(job_id, source_task_id=None, require_source=False):
        snap = get_queue().snapshot()
        if not job_id or snap.get('id') != job_id or snap.get('kind') != 'collector':
            raise RuntimeError('转换任务已变更，请重新开始或连接当前任务')
        if require_source and (not source_task_id or snap.get('source_task_id') != source_task_id):
            raise RuntimeError('采集任务已变更，拒绝操作旧任务')
        return snap

    @app.post('/api/bridge/pair')
    def pair():
        return jsonify(paired=True)

    @app.get('/api/bridge/capabilities')
    def capabilities():
        return jsonify(version='1.6.2',providers=['doubao','aliyun'],image_kinds=['main','detail','sku'],
                       **(credential_status() if credential_status else {'aliyun_configured':False,'aliyun_price_per_image':0.06}))

    @app.post('/api/bridge/folder')
    def folder():
        with lifecycle:
            selected = choose_folder()
            return jsonify(path=str(output_folder(selected)) if selected else '')

    @app.post('/api/bridge/jobs', endpoint='bridge_jobs')
    def jobs():
        data = body()
        output = output_folder(data.get('output_dir'))
        source = data.get('source_task_id')
        if not isinstance(source, str) or not source.strip() or len(source) > 200: raise ValueError('采集任务编号无效')
        if not isinstance(data.get('entries'), list): raise ValueError('图片清单无效')
        with lifecycle:
            queue = get_queue()
            if queue.snapshot()['status'] not in {'idle', 'completed'}:
                raise RuntimeError('本机工具有未完成任务，请先在工具页面处理或清空')
            queue.start_urls(data['entries'], output, build_prompt(), source,
                             provider=data.get('provider','doubao'),image_kinds=data.get('image_kinds'),paid_confirmed=data.get('paid_confirmed') is True)
            return jsonify(queue.snapshot())

    @app.get('/api/bridge/state', endpoint='bridge_state')
    def state():
        with lifecycle:
            snap = get_queue().snapshot()
            if snap['id'] is None and not request.args.get('job_id'): return jsonify(snap)
            return jsonify(owned(request.args.get('job_id')))

    @app.post('/api/bridge/action', endpoint='bridge_action')
    def action():
        data = body()
        command = data.get('action')
        if command not in {'stop','continue','retry','retry-upload','redo','open-browser','cancel'}: raise ValueError('未知操作')
        index = data.get('index')
        if index is not None and (not isinstance(index,int) or isinstance(index,bool) or index < 0): raise ValueError('请选择有效图片')
        with lifecycle:
            queue = get_queue()
            if command == 'open-browser' and queue.snapshot()['status'] in {'idle','completed'} and not data.get('job_id'):
                queue.open_browser()
            else:
                owned(data.get('job_id'),data.get('source_task_id'),True)
                if command == 'cancel': return jsonify(reset_queue())
                elif command == 'open-browser': queue.open_browser()
                else: queue.action(command,index,paid_confirmed=data.get('paid_confirmed') is True)
            return jsonify(queue.snapshot())

    @app.get('/api/bridge/manifest')
    def manifest():
        with lifecycle:
            snap = owned(request.args.get('job_id'))
            return jsonify(error='请使用插件的商品 Excel 导出，已取消独立图片清单'),410

    @app.get('/api/bridge/images/<job>/<int:index>/<kind>', endpoint='bridge_image')
    def image(job,index,kind):
        with lifecycle:
            snap = owned(job)
            try:
                item = snap['items'][index]
                path = item.get('input_path') if kind == 'original' else (item.get('result') or {}).get('output_path') if kind == 'result' else None
                if not path or not Path(path).is_file(): return jsonify(error='图片尚未保存'), 404
                return send_file(path)
            except (IndexError,KeyError,TypeError):
                return jsonify(error='图片不存在'), 404
