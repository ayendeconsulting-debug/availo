-- Sprint 2: payments. Both payment paths on one provider layer.
-- Checkout behind an inventory hold (US-134, US-135, US-017), wallet top-up (US-016),
-- allocated-before-paid consumption (US-018, OD-12), the immutable ledger (US-020),
-- receipts and history (US-019), wallet rules (US-015).
-- DE-13 Payment Transaction, DE-34 Inventory Hold, DE-12 Wallet Ledger Entry.

-- ——— Tariff and lot settings ———

-- US-013, US-022: a service fee per site, shown before confirmation and stored on the booking.
ALTER TABLE tariff ADD COLUMN service_fee_kobo bigint NOT NULL DEFAULT 0 CHECK (service_fee_kobo >= 0);
ALTER TABLE reservation ADD COLUMN service_fee_kobo bigint NOT NULL DEFAULT 0 CHECK (service_fee_kobo >= 0);

-- US-135: how long checkout capacity is held while payment completes. Default ten minutes.
ALTER TABLE lot ADD COLUMN hold_minutes integer NOT NULL DEFAULT 10 CHECK (hold_minutes BETWEEN 2 AND 60);

-- ——— US-015 wallet rules: configuration, versioned and attributed ———

CREATE TABLE wallet_rule (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  min_top_up_kobo   bigint NOT NULL CHECK (min_top_up_kobo > 0),
  max_top_up_kobo   bigint NOT NULL,
  max_balance_kobo  bigint NOT NULL,
  -- OD-12, decided: allocated credit is consumed before paid credit. Kept as data so it can change without a release.
  consumption_order text NOT NULL DEFAULT 'allocated_first' CHECK (consumption_order IN ('allocated_first', 'paid_first')),
  effective_from    timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (max_top_up_kobo >= min_top_up_kobo),
  CHECK (max_balance_kobo >= max_top_up_kobo)
);
-- Placeholder limits until the pilot operator sets them: ₦500 to ₦50,000 per top-up, ₦100,000 balance.
INSERT INTO wallet_rule (min_top_up_kobo, max_top_up_kobo, max_balance_kobo, effective_from, created_by)
VALUES (50000, 5000000, 10000000, '2000-01-01', 'migration 0006: placeholder limits');

-- ——— DE-13 Payment Transaction ———

CREATE TYPE payment_purpose AS ENUM ('checkout', 'top_up');
-- What the provider says happened to the money.
CREATE TYPE payment_status AS ENUM ('initiated', 'succeeded', 'failed', 'abandoned');
-- What the platform did with a successful payment (US-017: never take money without honouring it).
CREATE TYPE payment_fulfilment AS ENUM ('pending', 'fulfilled', 'refund_due', 'not_applicable');

CREATE TABLE payment_transaction (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,                       -- ours, sent to the provider: the key every verify and webhook resolves by
  user_id            uuid NOT NULL REFERENCES app_user(id),
  purpose            payment_purpose NOT NULL,
  provider           text NOT NULL,
  amount_kobo        bigint NOT NULL CHECK (amount_kobo > 0),     -- what we asked for; a different amount paid is a mismatch
  currency           char(3) NOT NULL DEFAULT 'NGN',
  hold_id            uuid REFERENCES inventory_hold(id),
  status             payment_status NOT NULL DEFAULT 'initiated',
  fulfilment         payment_fulfilment NOT NULL DEFAULT 'pending',
  fulfilment_note    text,
  provider_txn_id    text,
  paid_amount_kobo   bigint,
  channel            text,                                       -- card, bank_transfer, ussd …
  provider_fee_kobo  bigint,                                     -- for reconciliation (US-068)
  paid_at            timestamptz,
  verified_at        timestamptz,                                -- set only by a server-side verify (US-134)
  authorization_url  text,
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (purpose <> 'checkout' OR hold_id IS NOT NULL),
  CHECK (status <> 'succeeded' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX payment_idempotency_uq ON payment_transaction (user_id, purpose, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payment_provider_txn_uq ON payment_transaction (provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE INDEX payment_user_idx ON payment_transaction (user_id, created_at DESC);
CREATE INDEX payment_hold_idx ON payment_transaction (hold_id);

-- US-017: every attempt and every outcome, kept. Append-only.
CREATE TABLE payment_event (
  id          bigserial PRIMARY KEY,
  payment_id  uuid NOT NULL REFERENCES payment_transaction(id),
  kind        text NOT NULL,                                     -- initiated, verified, webhook, fulfilled, refund_queued, …
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_event_payment_idx ON payment_event (payment_id, id);

-- Webhooks as received, once per distinct event (US-017). Only authenticated ones are kept, and only the fields
-- reconciliation needs: no customer, card or authorisation detail is stored (NFR-SEC-06, data minimisation).
CREATE TABLE webhook_event (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,
  dedupe_key      text NOT NULL,
  event           text NOT NULL,
  reference       text,
  summary         jsonb NOT NULL,
  first_received  timestamptz NOT NULL,
  last_received   timestamptz NOT NULL,
  times_received  integer NOT NULL DEFAULT 1,
  processed_at    timestamptz,
  outcome         text,
  UNIQUE (provider, dedupe_key)
);

-- ——— DE-34 Inventory Hold: live from this sprint ———
-- The table is empty everywhere before this migration (holds were counted from day one, never written).

ALTER TABLE inventory_hold
  ADD COLUMN reference         text NOT NULL UNIQUE,
  ADD COLUMN lot_id            uuid NOT NULL REFERENCES lot(id),
  ADD COLUMN vehicle_id        uuid NOT NULL REFERENCES vehicle(id),
  ADD COLUMN hours             integer NOT NULL CHECK (hours >= 1),
  ADD COLUMN tariff_id         uuid NOT NULL REFERENCES tariff(id),
  ADD COLUMN rate_applied_kobo bigint NOT NULL,                   -- US-013: the quote is fixed when the hold is placed
  ADD COLUMN service_fee_kobo  bigint NOT NULL DEFAULT 0,
  ADD COLUMN amount_kobo       bigint NOT NULL,
  ADD COLUMN idempotency_key   text,
  ADD COLUMN release_reason    text CHECK (release_reason IN ('converted', 'expired', 'payment_failed', 'cancelled')),
  ADD CONSTRAINT hold_release_consistent CHECK ((released_at IS NULL) = (release_reason IS NULL));
CREATE UNIQUE INDEX inventory_hold_idempotency_uq ON inventory_hold (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX inventory_hold_live_idx ON inventory_hold (user_id) WHERE released_at IS NULL;
CREATE INDEX inventory_hold_expiry_idx ON inventory_hold (expires_at) WHERE released_at IS NULL;

-- ——— Reservations paid either way ———

ALTER TABLE reservation
  ADD COLUMN payment_transaction_id uuid REFERENCES payment_transaction(id),
  ADD COLUMN hold_id uuid UNIQUE REFERENCES inventory_hold(id),          -- a hold converts to exactly one reservation
  ADD CONSTRAINT reservation_paid_once CHECK (num_nonnulls(wallet_entry_id, payment_transaction_id) = 1);
-- One payment pays for at most one reservation, however many times it is verified.
CREATE UNIQUE INDEX reservation_payment_uq ON reservation (payment_transaction_id) WHERE payment_transaction_id IS NOT NULL;

-- ——— OD-12: allocated credit before paid credit ———
-- Every wallet entry records the part of its amount that is allocated credit. Allocated balance is
-- sum(allocated_kobo); paid balance is sum(amount_kobo - allocated_kobo). One row per movement, as before.

ALTER TABLE wallet_entry ADD COLUMN allocated_kobo bigint NOT NULL DEFAULT 0;
ALTER TABLE wallet_entry ADD COLUMN payment_transaction_id uuid REFERENCES payment_transaction(id);

-- Back-fill rows written before this sprint by replaying each wallet allocated-first. Only seed and
-- development rows can exist at this point; the append-only trigger is suspended for this statement alone.
ALTER TABLE wallet_entry DISABLE TRIGGER wallet_entry_no_update;
DO $$
DECLARE r record; cur uuid := NULL; alloc bigint := 0; part bigint;
BEGIN
  FOR r IN SELECT id, user_id, entry_type, amount_kobo FROM wallet_entry ORDER BY user_id, created_at, id LOOP
    IF cur IS DISTINCT FROM r.user_id THEN cur := r.user_id; alloc := 0; END IF;
    IF r.entry_type = 'allocation' THEN part := r.amount_kobo;
    ELSIF r.amount_kobo < 0 THEN part := -LEAST(GREATEST(alloc, 0), -r.amount_kobo);
    ELSE part := 0;
    END IF;
    alloc := alloc + part;
    IF part <> 0 THEN UPDATE wallet_entry SET allocated_kobo = part WHERE id = r.id; END IF;
  END LOOP;
END $$;
ALTER TABLE wallet_entry ENABLE TRIGGER wallet_entry_no_update;

ALTER TABLE wallet_entry
  ADD CONSTRAINT wallet_entry_allocated_part CHECK (
    allocated_kobo = 0 OR (sign(allocated_kobo) = sign(amount_kobo) AND abs(allocated_kobo) <= abs(amount_kobo))),
  ADD CONSTRAINT wallet_entry_allocation_is_allocated CHECK (entry_type <> 'allocation' OR allocated_kobo = amount_kobo),
  ADD CONSTRAINT wallet_entry_top_up_is_paid CHECK (entry_type <> 'top_up' OR allocated_kobo = 0);
-- US-017, US-020: a provider payment credits a wallet once, however many times it is verified or its webhook repeats.
CREATE UNIQUE INDEX wallet_entry_top_up_once ON wallet_entry (payment_transaction_id)
  WHERE entry_type = 'top_up' AND payment_transaction_id IS NOT NULL;

-- ——— US-020 the payment ledger: money moving through the provider ———
-- Checkout payments are cash received and revenue earned at once; top-ups are cash received and a
-- wallet liability (their wallet side is wallet_entry); a payment the platform could not honour is cash
-- received and owed straight back, never revenue. Refunds leave by the original method.
-- Immutable; corrections are reversing entries.

CREATE TYPE payment_ledger_type AS ENUM ('checkout_payment', 'top_up_payment', 'unfulfilled_payment', 'refund');

CREATE TABLE payment_ledger_entry (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type             payment_ledger_type NOT NULL,
  amount_kobo            bigint NOT NULL CHECK (amount_kobo <> 0),  -- money in > 0, money out < 0
  currency               char(3) NOT NULL DEFAULT 'NGN',
  user_id                uuid NOT NULL REFERENCES app_user(id),
  payment_transaction_id uuid NOT NULL REFERENCES payment_transaction(id),
  reservation_id         uuid REFERENCES reservation(id),
  reference              text NOT NULL,
  actor                  text NOT NULL,
  reverses_id            uuid REFERENCES payment_ledger_entry(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'refund') = (amount_kobo < 0))
);
-- One entry of each kind per payment: a repeated webhook can never post twice.
CREATE UNIQUE INDEX payment_ledger_once ON payment_ledger_entry (payment_transaction_id, entry_type) WHERE reverses_id IS NULL;
CREATE INDEX payment_ledger_user_idx ON payment_ledger_entry (user_id, created_at DESC);

CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (US-020, NFR-SEC-07)', TG_TABLE_NAME;
END $$;
CREATE TRIGGER payment_ledger_no_update BEFORE UPDATE OR DELETE ON payment_ledger_entry FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER payment_ledger_no_truncate BEFORE TRUNCATE ON payment_ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION append_only();
CREATE TRIGGER payment_event_no_update BEFORE UPDATE OR DELETE ON payment_event FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER payment_event_no_truncate BEFORE TRUNCATE ON payment_event FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- ——— Refunds to the original payment method (US-017 duplicates, US-134) ———

CREATE TYPE refund_status AS ENUM ('queued', 'submitted', 'processed', 'failed');
CREATE TABLE refund (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_transaction_id uuid NOT NULL UNIQUE REFERENCES payment_transaction(id),  -- full refunds only in sprint 2
  amount_kobo            bigint NOT NULL CHECK (amount_kobo > 0),
  reason                 text NOT NULL,
  status                 refund_status NOT NULL DEFAULT 'queued',
  provider_refund_ref    text,
  attempts               integer NOT NULL DEFAULT 0,
  last_error             text,
  actor                  text NOT NULL,
  queued_at              timestamptz NOT NULL DEFAULT now(),
  submitted_at           timestamptz,
  processed_at           timestamptz
);
CREATE INDEX refund_open_idx ON refund (status) WHERE status IN ('queued', 'submitted');
