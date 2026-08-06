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

## Measuring self-consumption instead of estimating it

Without a meter on the service entrance, this app can only see solar it can name — a charge
session, a battery discharge. The fridge, the heat pumps and the water heater are invisible,
so measured self-consumption reads far too low and nearly every kWh gets valued at the
export rate. The gap is covered by a percentage you type into Settings, and every figure
derived from it is labelled as an estimate.

A CT clamp on the incoming service closes it, by subtraction rather than addition: what the
house used directly is what the array made minus what actually left the property. Nothing
has to be identified or metered individually.

1. Adopt the meter like any other device (Devices → Add, or a scan).
2. Open it and answer **"Is this clamped on the main service?"** with yes.

From then on, periods the clamp fully covers are measured; periods that predate it keep
using your estimate. The savings page marks which is which, and so does the MCP server.

> **Only if the clamps are on the incoming service conductors**, before anything branches
> off. A meter on a sub-panel measures part of the house, and the numbers it produces look
> entirely reasonable while being wrong — which is the worst failure mode available here.
> Only a device whose kind is `meter` may hold the designation, and only one at a time.

Fitting CTs means opening a service panel. In most of Canada that is electrician work; at
minimum, kill the main breaker, and treat the incoming conductors as live regardless.

---
