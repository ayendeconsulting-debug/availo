# Availo

MVP1 of the Parking Exchange: one lot at the University of Lagos. Requirements live in the
project's High-Level Requirements; cite their identifiers (US-, NFR-, DE-, OD-) in commits, PRs and tests.

## Layout

- `packages/engine` — the Parking Exchange Engine (NFR-ARC-03). Pure TypeScript, no I/O; lint forbids framework and driver imports.
- `packages/db` — SQL migrations and the Postgres adapter for the engine's store port.

## Running the tests

Needs Postgres 16 and Node 22.

```sh
pnpm install
export DATABASE_URL=postgres://postgres@localhost:5432/availo_test
pnpm test:capacity   # US-023 release gate
pnpm test            # everything
```

The test suite drops and rebuilds the `public` schema of the database it is pointed at. Never point it at anything but a test database.
