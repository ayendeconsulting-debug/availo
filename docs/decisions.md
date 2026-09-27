# Build decisions

Decisions taken during the build that the requirements leave to implementation. Open decisions (OD-nn) stay in the requirements until they are closed there.

| Area | Decision | Traces to |
|---|---|---|
| Pool selection | The engine derives the pools a driver may book from their user type and eligibility. The client never names a pool. Staff and students draw on the campus ring-fence first, then the open share; guests draw on the open share only; accessible capacity is offered only to eligible accounts that ask for it, with no general fallback. | US-022, US-024, US-047, US-133, NFR-SEC-09 |
| Capacity check | A window fits a pool when the peak number of simultaneous claims across the window, plus one, does not exceed the pool's capacity. Windows are half-open. Confirmed reservations and unexpired holds are both claims. | US-023, US-135 |
| Concurrency | Every booking locks its candidate pool rows `FOR UPDATE` in id order, then the driver's wallet, inside one READ COMMITTED transaction. The debit and the reservation commit together or not at all. | US-022, US-023 |
| Data access | Plain SQL migrations and node-postgres. No ORM. The engine package has no I/O and is lint-enforced. | NFR-ARC-03 |
| Money | Integer kobo throughout, `bigint` in code and database; serialised as strings in JSON. | NFR-LOC-02 |
| Pass anti-sharing (OD-13) | The pass carries an Ed25519-signed opaque reference plus a TOTP-style code from a per-pass secret, rotating every 30 seconds and accepted within a wide window so offline gate devices tolerate clock drift. The attendant still matches the plate. | US-034, OD-13 |
| Seeded credit | Sprint 1 seed balances are recorded as administrator allocations, not top-ups, because no money was received. | US-018, US-062 |
| Campus identifier formats | Permissive placeholder patterns until UNILAG staff-number and matriculation formats are confirmed. Held in `user_type_rule`, changeable without a release. | US-002 |
| Hourly rate | ₦500/hour in seed and tests is a placeholder. | OD-04 |
