#!/usr/bin/env python3
"""Сервер синхронизации Карточек.

Хранит только зашифрованные записи: телефон шифрует каждую запись до отправки.
Сервер видит лишь служебные поля: rid (случайный на вид идентификатор), ts (время изменения)
и blob (шифр). Прочитать данные на сервере невозможно.

Без сторонних библиотек: Python 3.10+ и встроенный sqlite3.

API:
  GET  /health                      -> {"ok": true}
  POST /sync  Authorization: Bearer <токен>
       {"space": hex32, "since": int, "push": [{"rid": hex32, "ts": int, "blob": str}]}
    -> {"cursor": int, "items": [{"rid", "ts", "blob"}], "more": bool}
  Правило: побеждает запись с бОльшим ts. since/cursor — номер изменения на сервере
  (а не время телефона), поэтому расхождение часов не теряет данные при обмене.

Настройки — переменные окружения (см. server/README.md).
"""

import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get('KARTOCHKI_HOST', '127.0.0.1')
PORT = int(os.environ.get('KARTOCHKI_PORT', '8788'))
DB_PATH = os.environ.get('KARTOCHKI_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'sync.db'))
ORIGINS = [o.strip() for o in os.environ.get('KARTOCHKI_ORIGINS', 'https://annavolleyball.github.io').split(',') if o.strip()]
MAX_SPACES = int(os.environ.get('KARTOCHKI_MAX_SPACES', '2'))       # сколько «пространств» (наборов данных) можно создать
NEW_SPACES = os.environ.get('KARTOCHKI_NEW_SPACES', 'open') == 'open'  # 'closed' — новые создавать нельзя
MAX_BODY = int(os.environ.get('KARTOCHKI_MAX_BODY', str(8 * 1024 * 1024)))
MAX_BLOB = 2 * 1024 * 1024
PAGE = 2000
RATE_PER_MIN = int(os.environ.get('KARTOCHKI_RATE', '120'))

HEX32 = re.compile(r'^[0-9a-f]{32}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')

db_lock = threading.Lock()


def open_db(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA synchronous=NORMAL')
    con.executescript('''
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS items (
        space TEXT NOT NULL, rid TEXT NOT NULL, ts INTEGER NOT NULL, seq INTEGER NOT NULL, blob TEXT NOT NULL,
        PRIMARY KEY (space, rid));
      CREATE INDEX IF NOT EXISTS items_seq ON items (space, seq);
    ''')
    return con


con = None
hits = {}  # ip -> [минута, число запросов]


def rate_ok(ip):
    minute = int(time.time() // 60)
    m, n = hits.get(ip, (minute, 0))
    if m != minute:
        m, n = minute, 0
    hits[ip] = (m, n + 1)
    if len(hits) > 10000:
        hits.clear()
    return n + 1 <= RATE_PER_MIN


class SyncError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def check_space(space, token):
    th = hashlib.sha256(token.encode()).hexdigest()
    row = con.execute('SELECT token_hash FROM spaces WHERE id=?', (space,)).fetchone()
    if row is None:
        if not NEW_SPACES:
            raise SyncError(403, 'new spaces are closed')
        (count,) = con.execute('SELECT COUNT(*) FROM spaces').fetchone()
        if count >= MAX_SPACES:
            raise SyncError(403, 'space limit reached')
        con.execute('INSERT INTO spaces (id, token_hash, created_at) VALUES (?,?,?)', (space, th, int(time.time())))
        return
    if not hmac.compare_digest(row[0], th):
        raise SyncError(401, 'bad token')


def do_sync(token, body):
    space = body.get('space')
    since = body.get('since', 0)
    push = body.get('push', [])
    if not isinstance(space, str) or not HEX32.match(space):
        raise SyncError(400, 'bad space')
    if not isinstance(since, int) or since < 0:
        raise SyncError(400, 'bad since')
    if not isinstance(push, list):
        raise SyncError(400, 'bad push')
    for it in push:
        if not (isinstance(it, dict) and isinstance(it.get('rid'), str) and HEX32.match(it['rid'])
                and isinstance(it.get('ts'), int) and it['ts'] >= 0
                and isinstance(it.get('blob'), str) and 0 < len(it['blob']) <= MAX_BLOB):
            raise SyncError(400, 'bad item')

    with db_lock:
        con.execute('BEGIN IMMEDIATE')
        try:
            check_space(space, token)
            (seq,) = con.execute('SELECT COALESCE(MAX(seq), 0) FROM items WHERE space=?', (space,)).fetchone()
            if since > seq:
                # база новее не стала, а телефон «помнит» больше — её восстановили из копии или очистили.
                # Просим телефон отправить всё заново.
                con.execute('COMMIT')
                return {'reset': True}
            for it in push:
                row = con.execute('SELECT ts FROM items WHERE space=? AND rid=?', (space, it['rid'])).fetchone()
                if row is not None and row[0] >= it['ts']:
                    continue  # на сервере то же или более новое
                seq += 1
                con.execute('INSERT INTO items (space, rid, ts, seq, blob) VALUES (?,?,?,?,?) '
                            'ON CONFLICT(space, rid) DO UPDATE SET ts=excluded.ts, seq=excluded.seq, blob=excluded.blob',
                            (space, it['rid'], it['ts'], seq, it['blob']))
            con.execute('UPDATE spaces SET last_seen=? WHERE id=?', (int(time.time()), space))
            rows = con.execute('SELECT rid, ts, seq, blob FROM items WHERE space=? AND seq>? ORDER BY seq LIMIT ?',
                               (space, since, PAGE + 1)).fetchall()
            con.execute('COMMIT')
        except BaseException:
            con.execute('ROLLBACK')
            raise
    more = len(rows) > PAGE
    rows = rows[:PAGE]
    cursor = rows[-1][2] if rows else since
    return {'cursor': cursor, 'more': more, 'items': [{'rid': r, 'ts': t, 'blob': b} for r, t, _, b in rows]}


class Handler(BaseHTTPRequestHandler):
    server_version = 'kartochki-sync'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # без IP и тел запросов в журнале
        pass

    def client_ip(self):
        # Caddy передаёт адрес клиента в X-Forwarded-For; сервер слушает только 127.0.0.1
        return (self.headers.get('X-Forwarded-For') or self.client_address[0]).split(',')[0].strip()

    def cors(self):
        origin = self.headers.get('Origin')
        if origin and origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Max-Age', '86400')

    def reply(self, code, obj, close=False):
        data = json.dumps(obj, separators=(',', ':')).encode()
        self.send_response(code)
        if close:
            # тело запроса не дочитано — соединение дальше использовать нельзя
            self.send_header('Connection', 'close')
            self.close_connection = True
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True})
        self.reply(404, {'error': 'not found'}, close=True)

    def do_POST(self):
        if self.path != '/sync':
            return self.reply(404, {'error': 'not found'}, close=True)
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {'error': 'bad size'}, close=True)
        raw = self.rfile.read(length)  # дочитываем тело всегда, до любых отказов
        if not rate_ok(self.client_ip()):
            return self.reply(429, {'error': 'too many requests'})
        auth = self.headers.get('Authorization', '')
        token = auth[7:] if auth.startswith('Bearer ') else ''
        if not HEX64.match(token):
            return self.reply(401, {'error': 'no token'})
        try:
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.reply(400, {'error': 'bad json'})
        try:
            self.reply(200, do_sync(token, body))
        except SyncError as e:
            self.reply(e.code, {'error': str(e)})
        except Exception as e:  # noqa
            print('error:', type(e).__name__, e, file=sys.stderr, flush=True)
            self.reply(500, {'error': 'server error'})


def main():
    global con
    con = open_db(DB_PATH)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f'kartochki-sync listening on {HOST}:{PORT}', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
