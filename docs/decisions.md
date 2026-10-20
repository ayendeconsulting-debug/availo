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
| Apps | Two installable PWAs sharing packages: `apps/web` for drivers and `apps/gate` for attendants, each on its own origin in production so gate storage is never shared with a driver app. | NFR-ARC-07, NFR-OFF-05 |
| Look | The prototype's "Road marking" design at full fidelity: charcoal and road-line yellow on paper, Barlow Condensed over Barlow, bundled for offline use. | Design brief |
| Offline test | The sprint 1 offline test runs real builds in Chromium with the browser offline, the API stopped and the gate app's web server stopped; the gate camera reads a capture of the driver's pass screen. It runs in CI. | NFR-OFF-02, handover §7 |
| Opening hours | Start times in the driver app run 06:00–21:00 until lot availability schedules (US-011) are built. | US-011 |

## Sprint 2 — payments

| Area | Decision | Traces to |
|---|---|---|
| Scope | Both payment paths on one provider layer: checkout behind a hold (the only path at the SCIAN open-field site) and wallet top-up (the university profile). | US-016, US-134, US-135, HLR §3.1, §3.2 |
| Payment path | Which path a driver uses is configuration — `user_type_rule.wallet_enabled` today, the site's location profile from sprint 3. The engine refuses the other path; the client never chooses it. | US-002, NFR-ARC-10 |
| Provider | Paystack, behind `PaymentProvider`. Hosted checkout, so card, transfer and USSD are chosen on Paystack's page and no card data reaches the platform. The in-app "Pay with" radio in the prototype is shown as a list of methods instead. | HLR §3.6, NFR-SEC-06 |
| Verification | An outcome is believed only from Paystack's `GET /transaction/verify`. The browser's return and the webhook body are prompts to verify, never evidence. A webhook whose HMAC-SHA512 signature fails is rejected before its body is parsed. | US-017, US-134, NFR-SEC-09 |
| Idempotency | Three layers. Each distinct webhook is recorded once (repeats are counted). Every outcome goes through one settle step that locks the payment row and re-reads it. Unique indexes make a second reservation per hold or per payment, a second top-up credit per payment and a second ledger posting per payment impossible in the database itself. | US-017, US-020 |
| Holds | A hold is placed under the same pool locks as a wallet booking and counted by the same capacity check, so the hard cap holds across both paths. Default ten minutes, per lot. An expired hold stops counting the instant it expires; the expiry job only records it. | US-023, US-135 |
| One hold at a time | A driver has at most one live hold. A second checkout returns `CHECKOUT_IN_PROGRESS` with the live hold's id; the app resumes it. | US-135 |
| Conversion | A verified payment converts its hold to a reservation in the same transaction as the payment-ledger entry, under the pool lock, without releasing the space. Capacity is re-checked counting every claim but the hold itself, which always passes for a live hold. | US-022, US-135 |
| Late payment | Paystack can complete a payment after the hold lapsed. It converts if the space is still free; otherwise, or if the driver cancelled, or has since booked the same car for that time, the payment is recorded as cash owed back and refunded in full. | US-017 |
| Paystack "abandoned" | Verify reports "abandoned" for a transaction nobody has paid yet. It is not treated as final while the hold is live; a payment is closed as abandoned only when its hold expires (or the driver cancels). "failed" releases the hold at once. | US-135 |
| Amount mismatch | A payment whose verified amount or currency differs from what was asked is never honoured: it is refunded. | US-017 |
| Refunds | Full refunds to the original method, queued and then submitted by a job that claims each refund before submitting it. The refund posts to the ledger once, when Paystack reports it processed. | US-017, US-134 |
| Payment ledger | `payment_ledger_entry` records money moving through the provider: checkout payments (cash and revenue at once), top-up payments (cash, with the wallet side in `wallet_entry`), unfulfilled payments (cash owed back, never revenue) and refunds. Append-only by trigger. | US-020, US-062, US-066 |
| OD-12 (closed) | Allocated credit is consumed before paid credit. Each wallet entry records the part of its amount that is allocated credit, so allocated and paid balances are both derived from the ledger. The order is a wallet-rule setting. Existing rows were back-filled by replaying each wallet allocated-first. | US-018, OD-12 |
| Wallet rules | Minimum and maximum top-up and maximum balance are versioned configuration. Placeholders: ₦500, ₦50,000 and ₦100,000, pending the pilot operator. | US-015 |
| Service fee | Per tariff, default zero, shown before confirmation and stored on the reservation and the hold. Whether one is charged is OD-03. | US-013, US-134, OD-03 |
| Vehicle overlap | On the checkout path a vehicle cannot be held or booked for a time it is already booked for, so a driver is refused before paying rather than refunded after. The wallet path adopts the same rule when US-026 is built. | US-026 |
| Rate limits | Five payment initiations per driver per ten minutes. | NFR-SEC-08 |
| Webhook data | Only the fields reconciliation needs are kept: no customer, card or authorisation detail. | NFR-PRI-01, NFR-SEC-06 |
| Email for Paystack | Paystack requires an email; a driver without one is sent to it as `<mobile digits>@<configured domain>`. | US-001 |
| Receipts | PDF receipts per payment and statements for any West Africa Time date range, server-generated. Standard PDF fonts have no naira sign, so formal documents show "NGN". | US-019, NFR-LOC-03 |
| Jobs | Hold expiry and refund submission run on intervals inside the API, safe across instances. pg-boss replaces them with session warnings in sprint 3. | Handover §5 |
| Simulator | `packages/paystack-sim` reproduces Paystack's API, hosted page and signed webhooks so the production adapter is what the tests exercise. Field details it copies come from Paystack's published API and are confirmed by a live test-mode run. | — |
