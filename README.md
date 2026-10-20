# Availo

MVP1 of the Parking Exchange. Requirements live in the project's High-Level Requirements; cite their
identifiers (US-, NFR-, DE-, OD-) in commits, PRs and tests. The seed is still the university profile
(one UNILAG lot); the SCIAN open-field profile arrives with location profiles in sprint 3.

## Layout

- `packages/engine` — the Parking Exchange Engine (NFR-ARC-03). Pure TypeScript, no I/O; lint forbids framework and driver imports.
- `packages/db` — SQL migrations, the seed, and the Postgres adapter for the engine's store port.
- `packages/shared` — rules shared by server and clients: mobile and plate normalisation.
- `packages/pass` — the pass: signed QR, rotating code, offline verification. Runs in the browser and on the server.
- `packages/gate-client` — the attendant device's offline core: encrypted cache, durable outbound queue, sync.
- `packages/ui` — the prototype's "Road marking" design as React components; fonts bundled for offline use.
- `packages/paystack-sim` — a local stand-in for Paystack's API, hosted checkout page and signed webhooks, for development and tests. Not Paystack.
- `apps/web` — the driver PWA: sign up or in, reserve, the pass (works offline).
- `apps/gate` — the attendant PWA: enrol, scan, PIN, plate search, entry and exit, offline queue and sync.
- `e2e` — the browser test that runs the gate with the network genuinely off.
- `apps/api` — NestJS API: OTP sign-in, registration, availability, reservation, passes, gate, and payments: checkout behind a hold, wallet top-up, webhooks, refunds, receipts.
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
pnpm paystack:sim                    # :4010, in its own terminal
pnpm --filter @availo/api dev
```

In development the SMS provider is a stub that prints each message, including OTP codes, to the console. It refuses to start in production.

The seed has three staff drivers with allocated credit and one guest (`0803 000 0010`) who pays at checkout.

## Payments

Paystack, behind one interface (`apps/api/src/payments/provider.ts`). In development the API talks to the
local simulator; its checkout page is plainly labelled as a test and no money moves.

To run against Paystack's own test mode instead:

```sh
export PAYSTACK_SECRET_KEY=sk_test_…            # from the Paystack dashboard, test mode
export PAYSTACK_BASE_URL=https://api.paystack.co
export APP_BASE_URL=http://localhost:5173       # where Paystack sends the driver back
pnpm --filter @availo/api dev
```

Paystack must be able to reach `POST /webhooks/paystack` for webhooks; locally use a tunnel and set it as the
test webhook URL in the dashboard. Without webhooks everything still settles when the driver returns, or when
the expiry job asks Paystack. Outcomes are only ever taken from Paystack's verify endpoint.

| Variable | Meaning |
|---|---|
| `PAYSTACK_SECRET_KEY` | Secret key; also the webhook signing key. Required in production. |
| `PAYSTACK_BASE_URL` | Defaults to the simulator in development, Paystack in production (https only). |
| `PAYMENT_FALLBACK_EMAIL_DOMAIN` | Paystack requires an email; drivers without one are sent as `<mobile>@<domain>`. Required in production. |
| `PAYMENT_JOBS` | `on` runs hold expiry and refund submission on intervals (default except in tests). |

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

## The browser tests

Needs Postgres, ffmpeg and Chromium.

```sh
pnpm e2e                                              # uses Playwright's Chromium
PW_CHROMIUM_PATH=/path/to/chrome pnpm e2e             # or a Chromium you already have
E2E_SCREENSHOTS=./screens pnpm e2e                    # and keep screen captures
```

`e2e/checkout.spec.ts` runs both payment paths in the driver app against the simulator's hosted page: a guest pays at checkout behind a hold and lands on a pass; a member of staff short of balance tops up from the booking screen and comes straight back to book.

`e2e/offline-gate.spec.ts` builds both apps, books through the driver app, sets up a gate phone, then takes the gate browser offline, stops the API and the gate app's web server, reloads the gate app from its service worker, feeds its camera a capture of the driver's pass, admits and releases the car, restarts everything and checks the records arrived once. The API's clock is started at a fixed time for this run through `AVAILO_CLOCK_START`, which the API refuses in production.

## The demo

```sh
pnpm demo                 # ten consecutive runs; exits non-zero on any failure
DEMO_RUNS=50 pnpm demo    # more
```

Each run registers a staff member by OTP, grants them credit and tops up through the payment simulator (webhook sent three times, credited once), reserves one hour from the wallet with allocated credit drawn first, fetches the pass, has a gate device verify it and record entry with the network cut, syncs, records exit offline, syncs again and resends the same records. Then a guest registers, checks out behind a hold, pays, and is confirmed exactly once however often the webhook repeats. Every run checks that reservations, both ledgers, the balance, occupancy and the capacity cap agree; the end prints cash received, revenue earned and wallet liability separately (US-062). It uses its own database, `availo_demo`, rebuilt on every start.
