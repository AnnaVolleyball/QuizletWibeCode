# Сервер синхронизации Карточек

`sync_server.py` — маленький сервер на Python 3 без сторонних библиотек (встроенный `sqlite3`).
Хранит **только шифр**: телефон шифрует каждую запись до отправки, ключ на сервер не попадает.
Как устроено шифрование и обмен — `docs/SYNC.md`.

Адреса и подробности конкретного сервера в репозиторий не пишем (он публичный). Для сервера Анны
действует её инструкция `~/.claude/ANNA-SERVER.md`.

## API
- `GET /health` → `{"ok": true}`
- `POST /sync`, заголовок `Authorization: Bearer <токен из ключа>`, тело
  `{"space": hex32, "since": число, "push": [{"rid": hex32, "ts": число, "blob": "iv.шифр"}]}`
  → `{"cursor", "items": [...], "more"}`; если `since` больше, чем знает сервер, → `{"reset": true}`.
  Побеждает запись с бОльшим `ts`. Первое обращение с новым `space` создаёт «пространство» (если разрешено).

## Настройки (переменные окружения)
| Переменная | По умолчанию | Что это |
|---|---|---|
| `KARTOCHKI_HOST` | `127.0.0.1` | слушать только локально; наружу — через Caddy |
| `KARTOCHKI_PORT` | `8788` | порт |
| `KARTOCHKI_DB` | `./data/sync.db` | файл базы |
| `KARTOCHKI_ORIGINS` | `https://annavolleyball.github.io` | откуда разрешены запросы браузера (через запятую) |
| `KARTOCHKI_MAX_SPACES` | `2` | сколько наборов данных можно создать |
| `KARTOCHKI_NEW_SPACES` | `open` | `closed` — новые создавать нельзя (после подключения своих устройств) |
| `KARTOCHKI_RATE` | `120` | запросов в минуту с одного адреса |

## Проверить локально
```bash
KARTOCHKI_DB=/tmp/kartochki-test.db KARTOCHKI_ORIGINS=http://localhost:8000 python3 server/sync_server.py
python3 -m http.server 8000   # в другом окне, из корня репозитория
```
В приложении: Настройки → Синхронизация, сервер `http://localhost:8788` (http разрешён только для localhost).

## Установка (systemd + Caddy)
Файлы — в `deploy/`. Пример для пользователя `anna`, каталог `/srv/kartochki-sync`:
```bash
sudo install -d -o anna -g anna /srv/kartochki-sync /srv/kartochki-sync/data
# скопировать sync_server.py в /srv/kartochki-sync/
sudo cp deploy/kartochki-sync.service deploy/kartochki-sync-backup.service deploy/kartochki-sync-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kartochki-sync kartochki-sync-backup.timer
curl -s 127.0.0.1:8788/health
```
Caddy (официальный пакет из репозитория Caddy): `/etc/caddy/Caddyfile` по образцу `deploy/Caddyfile.example`,
`sudo systemctl reload caddy`, порты `sudo ufw allow 80,443/tcp`. Наружу доступно только то, что проксирует Caddy.

## Обслуживание
- Журнал: `sudo journalctl -u kartochki-sync -n 50` (запросы и адреса не пишутся).
- Копии базы: `/srv/kartochki-sync/data/backups/sync-ГГГГ-ММ-ДД.db`, хранятся 14 дней (таймер `kartochki-sync-backup`).
- Обновить сервер: заменить `sync_server.py`, `sudo systemctl restart kartochki-sync`.
- Восстановить из копии: остановить сервис, подложить файл как `sync.db`, запустить. Телефоны получат `reset`
  и сами отправят свои данные заново.
- Переезд на свой домен: поменять имя в Caddyfile, `sudo systemctl reload caddy`, на устройствах — новый адрес
  в «Синхронизации» (тот же ключ).
