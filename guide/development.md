# Development and architecture

Running it from source, the test suites, and how the pieces fit together.

[← back to the README](../README.md)

---


```bash
pnpm install
docker compose up -d db
pnpm --dir apps/api dev
pnpm --dir apps/web dev
```

Dev UI on **:5173**, API on **:3001**. Stop the dockerised API first (`docker compose
stop api`) — both bind 3001. To develop the UI against the containerised API instead,
set `API_DEV_URL=http://localhost:8080`.

```bash
pnpm --dir apps/api test
pnpm --dir apps/web test
```

The tests concentrate on unit conversions and anything that fails silently. Energy
bugs are quiet: reading watt-minutes as watt-hours overstates by 60× and still plots a
believable curve, and a coil thermistor read as room temperature looks perfectly
reasonable. Both were real bugs here. Both now have tests.

The same rule decides what gets a comment: if being wrong would still *look* right,
it needs one. Most of the assertions here exist because something already went wrong
once — a Modbus read that exceeded the protocol's own limit, a battery parser
reporting a confident 0% for a device it did not understand, a signing routine that
happened to work for exactly one endpoint.

**Simulated devices earn their keep.** Fixtures only ever agree with whatever the
author already believed; pointing an adapter at a fake device that answers like real
hardware has repeatedly found what unit tests could not.

## Architecture

```
Inverter / meters / devices on the LAN
      │  local protocols — protobuf, HTTP, mDNS, SSE
      ▼
NestJS collector ──► SQLite (Prisma) ──► REST API ──► React + MUI + ECharts
```

- `apps/api` — collector behind a vendor-neutral `InverterDataSource` interface,
  device adapters behind `DeviceAdapter`, storage, REST API, alerting.
- `apps/web` — React + TypeScript frontend.
