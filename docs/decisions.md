# Build decisions

Decisions taken during the build that the requirements leave to implementation. Open decisions (OD-nn) stay in the requirements until they are closed there.

| Area | Decision | Traces to |
|---|---|---|
| Pool selection | The engine derives the pools a driver may book from their user type and eligibility. The client never names a pool. Staff and students draw on the campus ring-fence first, then the open share; guests draw on the open share only; accessible capacity is offered only to eligible accounts that ask for it, with no general fallback. | US-022, US-024, US-047, US-133, NFR-SEC-09 |
| Capacity check | A window fits a pool when the peak number of simultaneous claims across the window, plus one, does not exceed the pool's capacity. Windows are half-open. Confirmed reservations and unexpired holds are both claims. | US-023, US-135 |
| Concurrency | Every booking locks its candidate pool rows `FOR UPDATE` in id order, then the driver's wallet, inside one READ COMMITTED transaction. The debit and the reservation commit together or not at all. | US-022, US-023 |
| Data access | Plain SQL migrations and node-postgres. No ORM. The engine package has no I/O and is lint-enforced. | NFR-ARC-03 |
| Money | Integer kobo throughout, `bigint` in code and database; serialised as strings in JSON. | NFR-LOC-02 |
| Pass anti-sharing (OD-13) | The QR is `AV1:<signed pass id + lot id>:<code>`. The signature is Ed25519; the code is a 6-digit HMAC-SHA-256 TOTP from a per-pass secret, rotating every 30 seconds and accepted within ±5 minutes so an offline gate device with a drifting clock still verifies. The attendant still matches the plate. | US-034, OD-13 |
| Stale code result | A genuine pass whose rotating code is outside the window returns STALE_CODE, in addition to the US-038 states. The attendant's first next action is to ask the driver to open the live pass. To be added to US-038 and US-041. | US-038, US-041 |
| PIN | Six digits, unique among every pass at the lot that a gate device could hold at once (24-hour horizon). Resolves one booking; the attendant confirms the plate. Stored encrypted (AES-256-GCM) with a separate keyed hash for uniqueness; gate caches receive a freshly salted hash. | US-036, US-039, NFR-SEC-08 |
| Pass copies | SMS and email carry the reference, window, plate, PIN and a link to the live pass. No QR leaves the app, so nothing static can be forwarded. | US-033, OD-13 |
| Early entry | A pass is VALID from 15 minutes before the reserved start, configurable per lot (0–120). The session still ends at the reserved end. | US-027, US-038 |
| Seeded credit | Sprint 1 seed balances are recorded as administrator allocations, not top-ups, because no money was received. | US-018, US-062 |
| Campus identifier formats | Permissive placeholder patterns until UNILAG staff-number and matriculation formats are confirmed. Held in `user_type_rule`, changeable without a release. | US-002 |
| Hourly rate | ₦500/hour in seed and tests is a placeholder. | OD-04 |
| Attendant sign-in | Attendants are staff accounts scoped to one lot. They sign in by mobile OTP, only on a device an administrator has enrolled for that lot with a one-time code. Every gate call carries the attendant token and the device token, and the two must match. The attendant session lasts 12 hours; verification never needs it. | US-055, NFR-SEC-03 |
| Gate devices (OD-14) | Bring-your-own. The cache and the outbound queue are encrypted with a non-extractable AES-GCM key generated on the phone. This protects against casual access and backups, not a compromised handset; exposure is limited by caching only name, plate, window and accessible indicator, for 24 hours. | OD-14, NFR-OFF-05, NFR-PRI-01 |
| Gate records | Each entry or exit gets an id on the device, which is the idempotency key. Records sync oldest first; a record leaves the device only when the server acknowledges it. | NFR-OFF-03 |
| Conflicts | The server applies every record and flags, never drops: CANCELLED_WHILE_OFFLINE, SUSPENDED_WHILE_OFFLINE, UNKNOWN_PASS, DUPLICATE_ENTRY, REENTRY_AFTER_EXIT, EXIT_WITHOUT_ENTRY, DUPLICATE_EXIT, EXIT_BEFORE_ENTRY, PLATE_NOT_CONFIRMED, ADMITTED_ON_<status>, MANUAL_EXCEPTION, CLOCK_SKEW (device more than 10 minutes ahead), DEVICE_REVOKED. An entry creates the session even when flagged, because the vehicle is physically in. | NFR-OFF-04, US-041 |
| Revocation | A revoked device can no longer download passes and purges its cache on next contact. It may still upload records it made before, which are accepted and flagged DEVICE_REVOKED. | US-055, NFR-OFF-04 |
| Administration before the console | `pnpm gate:admin` creates attendants and devices and revokes devices until the operations console (sprint 6). | US-055 |
