-- Gate operations: attendants, enrolled devices, entry/exit records, sessions.
-- US-027, US-040, US-041, US-042, US-055, NFR-OFF-01..05, DE-15, DE-17.

CREATE TYPE staff_role AS ENUM ('attendant', 'ops_admin', 'platform_admin', 'assessor');

-- People who operate the platform. Separate from drivers (app_user).
CREATE TABLE staff_account (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile_e164  text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role         staff_role NOT NULL,
  lot_id       uuid REFERENCES lot(id),                              -- US-055: attendants are scoped to one lot
  active       boolean NOT NULL DEFAULT true,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'attendant' OR lot_id IS NOT NULL)
);

-- A phone an administrator has enrolled as a gate device for one lot (OD-14: bring-your-own).
CREATE TABLE gate_device (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id               uuid NOT NULL REFERENCES lot(id),
  label                text NOT NULL,
  enrolment_code_hash  text UNIQUE,                                  -- one-time; cleared on use
  enrolment_expires_at timestamptz,
  token_hash           text UNIQUE,                                  -- set on enrolment
  enrolled_at          timestamptz,
  revoked_at           timestamptz,
  revoked_reason       text,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- DE-15, minimal for sprint 1: Active on recorded entry (US-027), Ended on recorded exit.
-- Warned, extended, expired, grace and penalty states arrive in sprint 3.
CREATE TYPE session_state AS ENUM ('active', 'ended');
CREATE TABLE parking_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE REFERENCES reservation(id),
  state          session_state NOT NULL,
  entered_at     timestamptz NOT NULL,
  exited_at      timestamptz,
  entry_event_id uuid NOT NULL,
  exit_event_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- DE-17. The id is generated on the device, so a repeated sync can never create a second record (NFR-OFF-03).
CREATE TYPE gate_event_kind AS ENUM ('entry', 'exit');
CREATE TYPE gate_method AS ENUM ('qr', 'pin', 'plate', 'manual');
CREATE TABLE gate_event (
  id               uuid PRIMARY KEY,
  lot_id           uuid NOT NULL REFERENCES lot(id),
  kind             gate_event_kind NOT NULL,
  method           gate_method NOT NULL,
  pass_id          uuid REFERENCES access_pass(id),
  reservation_id   uuid REFERENCES reservation(id),
  plate            text,                                             -- as confirmed or entered at the gate, normalised
  device_result    text NOT NULL,                                    -- what the device showed: VALID, EXPIRED, …
  plate_confirmed  boolean NOT NULL,
  reason           text,                                             -- mandatory for a manual exception (US-041)
  attendant_id     uuid NOT NULL REFERENCES staff_account(id),
  device_id        uuid NOT NULL REFERENCES gate_device(id),
  occurred_at      timestamptz NOT NULL,                             -- device clock
  received_at      timestamptz NOT NULL,                             -- server clock
  recorded_offline boolean NOT NULL,
  conflict         text,                                             -- NFR-OFF-04: flagged, never dropped
  review_state     text NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'flagged', 'resolved')),
  CHECK (method <> 'manual' OR reason IS NOT NULL)
);
CREATE INDEX gate_event_review_idx ON gate_event (lot_id, review_state) WHERE review_state = 'flagged';
CREATE INDEX gate_event_reservation_idx ON gate_event (reservation_id);
