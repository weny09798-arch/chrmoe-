"""Public license protocol and authenticated CSRF-protected administration."""
import hmac
import re
import secrets
from functools import wraps

from flask import Blueprint, abort, current_app, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash

routes = Blueprint('licensing', __name__)


def store():
    return current_app.extensions['licenses']


def csrf_token():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_urlsafe(32)
    return session['csrf']


def check_csrf():
    supplied = request.form.get('csrf_token', '')
    if not re.fullmatch('[A-Za-z0-9_-]{43}', supplied) or not hmac.compare_digest(supplied, session.get('csrf', '')):
        abort(400)


def admin_required(function):
    @wraps(function)
    def decorated(*args, **kwargs):
        if not session.get('admin'):
            return redirect(url_for('licensing.login'))
        if request.method == 'POST':
            check_csrf()
        return function(*args, **kwargs)
    return decorated


@routes.before_request
def secure_transport():
    if not request.is_secure and not (current_app.testing and current_app.config['ALLOW_TEST_HTTP']):
        abort(400)
    if request.path.startswith('/admin'):
        if request.host_url.rstrip('/') != current_app.config['PUBLIC_ORIGIN']:
            abort(400)
        if request.method == 'POST' and request.headers.get('Origin') not in (None, current_app.config['PUBLIC_ORIGIN']):
            abort(400)


@routes.after_request
def private_response(response):
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Pragma'] = 'no-cache'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Content-Security-Policy'] = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    response.headers['Strict-Transport-Security'] = 'max-age=31536000'
    return response


@routes.post('/v1/activate')
@routes.post('/v1/validate')
def license_request():
    if not store().consume_limit('license', request.remote_addr or 'unknown', current_app.config['ACTIVATION_LIMIT'], 60):
        return jsonify(status='rate_limited', server_time=int(current_app.config['CLOCK']()), expires_at=None), 429, {'Retry-After': '60'}
    body = request.get_json(silent=True)
    if (not isinstance(body, dict) or set(body) != {'code', 'device_hash', 'nonce'}
            or not isinstance(body['code'], str) or not 20 <= len(body['code']) <= 128
            or not isinstance(body['device_hash'], str) or not re.fullmatch('[0-9a-f]{64}', body['device_hash'])
            or not isinstance(body['nonce'], str) or not re.fullmatch('[A-Za-z0-9_-]{16,128}', body['nonce'])):
        return jsonify(status='bad_request', server_time=int(current_app.config['CLOCK']()), expires_at=None), 400
    status, row, now = store().check(body['code'], body['device_hash'], request.path.endswith('/activate'))
    result = dict(status=status, server_time=now, expires_at=row['expires_at'] if row else None)
    if status == 'allowed':
        result['credential'] = current_app.extensions['signer'].sign(dict(
            version=1, license_id=row['id'], device_hash=body['device_hash'], issued_at=now,
            expires_at=row['expires_at'], lease_until=min(now + 86400, row['expires_at']), nonce=body['nonce']))
    # Do not log request bodies, codes, notes, device identities or credentials.
    current_app.logger.info('license request status=%s', status)
    return jsonify(result), 200 if status == 'allowed' else 403


@routes.route('/admin/login', methods=['GET', 'POST'])
def login():
    error = None
    status = 200
    if request.method == 'POST':
        check_csrf()
        if not store().consume_limit('login', request.remote_addr or 'unknown', current_app.config['LOGIN_LIMIT'], 900):
            error, status = 'Too many login attempts. Retry later.', 429
        elif check_password_hash(current_app.config['ADMIN_PASSWORD_HASH'], request.form.get('password', '')):
            session.clear()
            session['admin'] = True
            session.permanent = True
            csrf_token()
            return redirect(url_for('licensing.admin'))
        else:
            error, status = 'Invalid credentials.', 401
    return render_template('login.html', csrf_token=csrf_token(), error=error), status


@routes.get('/admin/')
@admin_required
def admin():
    return render_template('admin.html', licenses=store().list(), csrf_token=csrf_token(), new_code=None)


@routes.post('/admin/create')
@admin_required
def create():
    _, code = store().create(request.form.get('note', ''))
    # Render only this POST response: never put the raw code in a session or flash.
    return render_template('admin.html', licenses=store().list(), csrf_token=csrf_token(), new_code=code)


@routes.post('/admin/<license_id>/<action>')
@admin_required
def action(license_id, action):
    if action not in ('note', 'renew', 'disable', 'enable', 'unbind'):
        abort(404)
    try:
        store().admin_action(license_id, action, note=request.form.get('note', ''))
    except KeyError:
        abort(404)
    except ValueError as error:
        return render_template('admin.html', licenses=store().list(), csrf_token=csrf_token(), new_code=None, error=str(error)), 400
    return redirect(url_for('licensing.admin'))


@routes.post('/admin/logout')
@admin_required
def logout():
    session.clear()
    return redirect(url_for('licensing.login'))
