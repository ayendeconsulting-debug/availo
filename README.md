# Availo

MVP1 of the Parking Exchange: one lot at the University of Lagos. Requirements live in the
project's High-Level Requirements; cite their identifiers (US-, NFR-, DE-, OD-) in commits, PRs and tests.

## Layout

- `packages/engine` — the Parking Exchange Engine (NFR-ARC-03). Pure TypeScript, no I/O; lint forbids framework and driver imports.
- `packages/db` — SQL migrations, the seed, and the Postgres adapter for the engine's store port.
- `packages/shared` — rules shared by server and clients: mobile and plate normalisation.
- `packages/pass` — the pass: signed QR, rotating code, offline verification. Runs in the browser and on the server.
- `packages/gate-client` — the attendant device's offline core: encrypted cache, durable outbound queue, sync.
- `packages/ui` — the prototype's "Road marking" design as React components; fonts bundled for offline use.
- `apps/web` — the driver PWA: sign up or in, reserve, the pass (works offline).
- `apps/gate` — the attendant PWA: enrol, scan, PIN, plate search, entry and exit, offline queue and sync.
- `e2e` — the browser test that runs the gate with the network genuinely off.
- `apps/api` — NestJS API: OTP sign-in, registration, availability, reservation, passes, gate.
- `docs/decisions.md` — build decisions the requirements leave to implementation.

## Running the tests

Needs Postgres 16 and Node 22.

```sh
pnpm install
export DATABASE_URL=postgres://postgres@localhost:5432/availo_test
pnpm test:capacity   # US-023 release gate
pnpm test            # everything
```

The test suite drops and rebuilds the `public` schema of the database it is pointed at. Never point it at anything but a test database.

## Running the API locally

```sh
createdb availo_dev
export DATABASE_URL=postgres://postgres@localhost:5432/availo_dev
pnpm db:migrate && pnpm db:seed
pnpm --filter @availo/api dev
```

In development the SMS provider is a stub that prints each message, including OTP codes, to the console. It refuses to start in production.

## Setting up a gate device

```sh
pnpm gate:admin attendant add <lotId> 08031234567 "Attendant name"
pnpm gate:admin device add <lotId> "Gate phone 1"     # prints a one-time enrolment code
```

The attendant enters the code on their phone once, then signs in by OTP.

## Running the apps

```sh
pnpm --filter @availo/api dev        # :3000
pnpm --filter @availo/web dev        # :5173 driver app
pnpm --filter @availo/gate dev       # :5174 gate app
```

`VITE_API_URL` points either app at another API. `VITE_OPS_PHONE` gives the gate app a number for "Call operations".

## The offline browser test

Needs Postgres, ffmpeg and Chromium.

```sh
pnpm e2e                                              # uses Playwright's Chromium
PW_CHROMIUM_PATH=/path/to/chrome pnpm e2e             # or a Chromium you already have
E2E_SCREENSHOTS=./screens pnpm e2e                    # and keep screen captures
```

It builds both apps, books through the driver app, sets up a gate phone, then takes the gate browser offline, stops the API and the gate app's web server, reloads the gate app from its service worker, feeds its camera a capture of the driver's pass, admits and releases the car, restarts everything and checks the records arrived once. The API's clock is started at a fixed time for this run through `AVAILO_CLOCK_START`, which the API refuses in production.
