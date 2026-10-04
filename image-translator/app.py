"""Loopback-only image input, serial processing, and known-result previews."""
import copy
import hmac
import io
import secrets
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, abort, jsonify, render_template, request, send_file
from PIL import Image


class ImageService:
    def __init__(self, translator):
        self.translator = translator
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='local-images')
        self.lock = threading.RLock()
        self.admission = threading.Lock()
        self.jobs = {}
        self.temp = tempfile.TemporaryDirectory(prefix='traditional-image-')

    def close(self):
        self.pool.shutdown(wait=True)
        self.temp.cleanup()

    def public(self, job):
        return copy.deepcopy({key: value for key, value in job.items() if key != '_inputs'})

    def start(self, files, output_dir, mode):
        with self.lock:
            if any(job['status'] in ('queued', 'running') for job in self.jobs.values()):
                raise RuntimeError('正在处理上一批图片，请完成后再添加。')
            while len(self.jobs) >= 4:
                oldest = next(iter(self.jobs))
                old = self.jobs.pop(oldest)
                for item in old['_inputs']:
                    Path(item['path']).unlink(missing_ok=True)
            job_id = secrets.token_hex(16)
            inputs = []
            for index, (name, data) in enumerate(files):
                target = Path(self.temp.name) / f'{job_id}-{index}'
                target.write_bytes(data)
                inputs.append({'name':name, 'path':str(target)})
            job = {'id':job_id, 'status':'queued', 'processed':0, 'total':len(inputs),
                   'current':'等待开始', 'output_dir':str(output_dir), 'mode':mode,
                   'results':[], '_inputs':inputs}
            self.jobs[job_id] = job
            self.pool.submit(self.process, job_id)
            return job_id

    def process(self, job_id):
        from storage import save_result
        with self.lock:
            job = self.jobs[job_id]
            job['status'] = 'running'
        for index, entry in enumerate(job['_inputs']):
            with self.lock:
                job['current'] = entry['name']
            result = {'index':index, 'name':entry['name'], 'status':'error'}
            try:
                png, report = self.translator.convert(Path(entry['path']).read_bytes(), job['mode'])
                paths = save_result(job['output_dir'], entry['name'], png, report)
                result.update(status='ok', paths=paths, report=report)
            except Exception as error:
                result['error'] = str(error) or '图片处理失败，请检查文件与输出路径。'
            with self.lock:
                job['results'].append(result)
                job['processed'] += 1
        with self.lock:
            successes = sum(result['status'] == 'ok' for result in job['results'])
            job['status'] = 'done' if successes == job['total'] else 'partial' if successes else 'error'
            job['current'] = '本批处理结束'


def create_app(translator=None, output_default=None, token=None):
    if translator is None:
        from engine import Translator
        translator = Translator()
    token = token or secrets.token_urlsafe(32)
    output_default = Path(output_default or Path.cwd() / '繁体图片输出').absolute()
    app = Flask(__name__, static_folder='web', static_url_path='/assets', template_folder='web')
    app.config['MAX_CONTENT_LENGTH'] = 80 * 1024 * 1024
    app.config['MAX_FORM_PARTS'] = 30
    service = ImageService(translator)
    app.extensions['image_service'] = service
    app.extensions['local_token'] = token

    @app.before_request
    def guard():
        host = urlsplit(request.host_url).hostname
        if host not in ('127.0.0.1', 'localhost') or request.remote_addr not in ('127.0.0.1', '::1'):
            abort(403)
        origin = request.headers.get('Origin')
        if origin and origin != request.host_url.rstrip('/'):
            abort(403)
        if request.path.startswith('/api/'):
            provided = request.headers.get('X-Local-Token') or request.args.get('token', '')
            if not hmac.compare_digest(provided.encode('utf-8'), token.encode('utf-8')):
                abort(403)

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'"
        return response

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(413)
    def bad_request(error):
        descriptions = {400:'输入内容不正确。', 403:'请从本地工具页面操作。', 404:'未找到这项结果。', 413:'图片总大小超过80MB，请分批处理。'}
        return jsonify(error=descriptions.get(error.code, '请求失败。')), error.code

    @app.get('/')
    def index():
        return render_template('index.html', token=token, output_default=str(output_default))

    @app.post('/api/shutdown')
    def shutdown():
        callback = app.extensions.get('shutdown')
        if callback is None:
            return jsonify(error='请在启动窗口中关闭工具。'), 409
        threading.Thread(target=callback, daemon=True).start()
        return jsonify(ok=True)

    def admit_upload(view):
        @wraps(view)
        def admitted():
            if not service.admission.acquire(blocking=False):
                return jsonify(error='正在接收另一批图片，请稍后再试。'), 409
            try:
                with service.lock:
                    if any(job['status'] in ('queued', 'running') for job in service.jobs.values()):
                        return jsonify(error='正在处理上一批图片，请完成后再添加。'), 409
                return view()
            finally:
                service.admission.release()
        return admitted

    @app.post('/api/jobs')
    @admit_upload
    def submit():
        from engine import decode_image
        files = request.files.getlist('images')
        if not 1 <= len(files) <= 20:
            return jsonify(error='一次请选择1到20张图片。'), 400
        mode = request.form.get('mode', 's2t')
        if mode not in ('s2t', 's2tw', 's2hk'):
            return jsonify(error='请选择有效的繁体类型。'), 400
        directory = Path(request.form.get('output_dir', '').strip().strip('"'))
        if not directory.is_absolute() or (directory.exists() and not directory.is_dir()):
            return jsonify(error='请输入完整输出文件夹路径，例如 D:\\图片输出。'), 400
        try:
            uploads = []
            expected = {'.png':'PNG', '.jpg':'JPEG', '.jpeg':'JPEG', '.webp':'WEBP'}
            for file in files:
                name = (file.filename or '').replace('\\', '/').split('/')[-1]
                extension = Path(name).suffix.lower()
                if extension not in expected:
                    raise ValueError('只支持 JPG、PNG、WebP 图片。')
                data = file.read()
                decode_image(data)
                with Image.open(io.BytesIO(data)) as picture:
                    if picture.format != expected[extension]:
                        raise ValueError(f'{name} 的文件类型与后缀不一致。')
                uploads.append((name, data))
            job_id = service.start(uploads, directory, mode)
            return jsonify(id=job_id), 202
        except ValueError as error:
            return jsonify(error=str(error)), 400
        except RuntimeError as error:
            return jsonify(error=str(error)), 409

    @app.get('/api/jobs/<job_id>')
    def progress(job_id):
        with service.lock:
            job = service.jobs.get(job_id)
            if job is None:
                abort(404)
            return jsonify(service.public(job))

    @app.get('/api/jobs/<job_id>/image/<int:index>/<kind>')
    def picture(job_id, index, kind):
        with service.lock:
            job = service.jobs.get(job_id)
            if job is None or not 0 <= index < job['total']:
                abort(404)
            if kind == 'original':
                path = job['_inputs'][index]['path']
                name = job['_inputs'][index]['name']
            elif kind == 'result':
                result = next((r for r in job['results'] if r['index'] == index and r['status'] == 'ok'), None)
                if result is None:
                    abort(404)
                path, name = result['paths']['png'], Path(result['paths']['png']).name
            else:
                abort(404)
        extension = Path(name).suffix.lower()
        mime = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp'}[extension]
        return send_file(path, mimetype=mime, download_name=name, as_attachment=request.args.get('download') == '1')

    return app
