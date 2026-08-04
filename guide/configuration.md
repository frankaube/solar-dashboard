# Configuration and endpoints

Environment variables, what each one does, and the HTTP surface the app exposes.

[← back to the README](../README.md)

---


Most settings live in the app. These env vars pre-seed a fresh install — put them in
`.env` next to `docker-compose.yml`.

| Variable | Purpose | Default |
|---|---|---|
| `TESLAMATE_ENCRYPTION_KEY` | Encrypts Tesla tokens at rest | **required** for TeslaMate |
| `DTU_HOST`, `DTU_SERIAL` | Solar gateway (the scan finds it too) | — |
| `CHARGER_HOST` | Tesla Wall Connector | — |
| `SITE_LATITUDE`, `SITE_LONGITUDE` | Weather forecast location | unset = weather off |
| `POLL_INTERVAL_MS` | Solar poll interval — **keep ≥ 300000** | 300000 |
| `NOTIFY_WEBHOOK_URL` | ntfy topic or Discord webhook | off |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | Home Assistant discovery | off |
| `API_TOKEN` | Require `Authorization: Bearer` on writes | off |
| `POSTGRES_PASSWORD` | TeslaMate database password | `hoymiles_dev` |

With no location set the weather feature stays off rather than guessing. Someone
else's forecast is worse than none, because it looks like data.

Postgres is bound to `127.0.0.1` — it has a well-known default password, so it is
deliberately not reachable from the rest of your LAN.

---

## Endpoints

- Dashboard — `http://localhost:8080`
- TeslaMate — `http://localhost:4000` (sign in with Tesla API tokens; use
  [tesla_auth](https://github.com/adriankumpf/tesla_auth) so your password never
  touches this stack)
- Health — `http://localhost:8080/api/status`
- Prometheus — `http://localhost:8080/api/metrics` (starter dashboard in `grafana/`)

---
