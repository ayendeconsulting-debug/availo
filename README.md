# Availo

MVP1 of the Parking Exchange: one lot at the University of Lagos. Requirements live in the
project's High-Level Requirements; cite their identifiers (US-, NFR-, DE-, OD-) in commits, PRs and tests.

## Layout

- `packages/engine` — the Parking Exchange Engine (NFR-ARC-03). Pure TypeScript, no I/O; lint forbids framework and driver imports.
- `packages/db` — SQL migrations, the seed, and the Postgres adapter for the engine's store port.
- `packages/shared` — rules shared by server and clients: mobile and plate normalisation.
- `packages/pass` — the pass: signed QR, rotating code, offline verification. Runs in the browser and on the server.
- `packages/gate-client` — the attendant device's offline core: encrypted cache, durable outbound queue, sync.
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
