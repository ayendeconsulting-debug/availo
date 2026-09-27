-- Sprint 1 core schema: the tables the walking skeleton needs.
-- DE-01 User, DE-03 Vehicle, DE-06 Property, DE-07 Lot, DE-09 Capacity Pool,
-- DE-10 Tariff, DE-12 Wallet Ledger Entry, DE-14 Reservation, DE-34 Inventory Hold.
-- Money is integer kobo (NFR-LOC-02: NGN only, currency column kept for extension).
-- All timestamps are timestamptz, stored UTC (NFR-LOC-03).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- GiST index on (pool_id, time_window)

CREATE TYPE user_type AS ENUM ('staff', 'student', 'guest');           -- US-002
CREATE TYPE verification_state AS ENUM ('pending', 'verified', 'flagged', 'suspended'); -- US-006
CREATE TYPE pool_kind AS ENUM ('campus', 'open', 'accessible');         -- US-010, US-133
CREATE TYPE reservation_status AS ENUM ('confirmed', 'cancelled', 'completed');
CREATE TYPE wallet_entry_type AS ENUM ('top_up', 'allocation', 'reservation_debit', 'extension_debit', 'penalty', 'refund', 'reversal'); -- DE-12

CREATE TABLE app_user (                                                  -- DE-01
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile_e164         text NOT NULL UNIQUE,
  display_name        text NOT NULL,
  user_type           user_type NOT NULL,
  campus_identifier   text,
  verification_state  verification_state NOT NULL DEFAULT 'pending',
  accessible_eligible boolean NOT NULL DEFAULT false,                  -- US-046: the fact only, never the evidence
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campus_id_required CHECK (user_type = 'guest' OR campus_identifier IS NOT NULL)
);
CREATE UNIQUE INDEX app_user_campus_identifier_uq ON app_user (campus_identifier) WHERE campus_identifier IS NOT NULL;

CREATE TABLE vehicle (                                                   -- DE-03
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  plate_display    text NOT NULL,
  plate_normalised text NOT NULL,                                      -- US-003: all gate matching uses this
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicle_plate_active_uq ON vehicle (plate_normalised) WHERE active;

CREATE TABLE property (                                                  -- DE-06
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lot (                                                       -- DE-07, US-009, US-010
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES property(id),
  name           text NOT NULL,
  total_bays     integer NOT NULL CHECK (total_bays >= 0),
  withheld_bays  integer NOT NULL DEFAULT 0 CHECK (withheld_bays >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (withheld_bays <= total_bays)
);

CREATE TABLE capacity_pool (                                             -- DE-09
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id     uuid NOT NULL REFERENCES lot(id),
  kind       pool_kind NOT NULL,
  capacity   integer NOT NULL CHECK (capacity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, kind)
);

CREATE TABLE tariff (                                                    -- DE-10, US-013: versioned
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id               uuid NOT NULL REFERENCES lot(id),
  user_type            user_type,                                      -- NULL = all types (US-013: one rate in MVP1, keyed for later)
  hourly_rate_kobo     bigint NOT NULL CHECK (hourly_rate_kobo >= 0),
  currency             char(3) NOT NULL DEFAULT 'NGN',
  min_hours            integer NOT NULL DEFAULT 1 CHECK (min_hours >= 1),
  max_hours            integer NOT NULL DEFAULT 12 CHECK (max_hours >= min_hours),
  effective_from       timestamptz NOT NULL DEFAULT now(),
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_entry (                                              -- DE-12, US-020: immutable, append-only
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id),
  entry_type   wallet_entry_type NOT NULL,
  amount_kobo  bigint NOT NULL CHECK (amount_kobo <> 0),                -- signed: credit > 0, debit < 0
  currency     char(3) NOT NULL DEFAULT 'NGN',
  reference    text NOT NULL,
  actor        text,
  reverses_id  uuid REFERENCES wallet_entry(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entry_user_idx ON wallet_entry (user_id);

-- NFR-SEC-14: no interface may alter a ledger entry. Corrections are reversing entries.
CREATE FUNCTION wallet_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_entry is append-only (US-020, NFR-SEC-14)';
END $$;
CREATE TRIGGER wallet_entry_no_update BEFORE UPDATE OR DELETE ON wallet_entry
  FOR EACH ROW EXECUTE FUNCTION wallet_entry_immutable();
CREATE TRIGGER wallet_entry_no_truncate BEFORE TRUNCATE ON wallet_entry
  FOR EACH STATEMENT EXECUTE FUNCTION wallet_entry_immutable();

CREATE TABLE reservation (                                               -- DE-14, US-022, US-023
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES app_user(id),
  vehicle_id       uuid NOT NULL REFERENCES vehicle(id),
  lot_id           uuid NOT NULL REFERENCES lot(id),
  pool_id          uuid NOT NULL REFERENCES capacity_pool(id),
  time_window      tstzrange NOT NULL CHECK (NOT isempty(time_window) AND lower_inc(time_window) AND NOT upper_inc(time_window)),
  hours            integer NOT NULL CHECK (hours >= 1),
  rate_applied_kobo bigint NOT NULL,                                   -- US-013: rate stored on the reservation
  tariff_id        uuid NOT NULL REFERENCES tariff(id),
  amount_kobo      bigint NOT NULL,
  wallet_entry_id  uuid REFERENCES wallet_entry(id),                   -- US-023: the ledger entry that paid for it
  status           reservation_status NOT NULL DEFAULT 'confirmed',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_pool_window_idx ON reservation USING gist (pool_id, time_window) WHERE status = 'confirmed';

CREATE TABLE inventory_hold (                                            -- DE-34, US-135 (used from sprint 4; counted from day one)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  pool_id     uuid NOT NULL REFERENCES capacity_pool(id),
  time_window tstzrange NOT NULL CHECK (NOT isempty(time_window)),
  expires_at  timestamptz NOT NULL,
  released_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_hold_pool_window_idx ON inventory_hold USING gist (pool_id, time_window) WHERE released_at IS NULL;
