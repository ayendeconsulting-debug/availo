-- Sprint 1 identity: OTP sign-in (US-001), sessions, and configurable user types (US-002).

ALTER TABLE app_user ADD COLUMN email text;
ALTER TABLE app_user ADD COLUMN email_verified_at timestamptz;
ALTER TABLE app_user ADD COLUMN verified_at timestamptz;
ALTER TABLE app_user ADD COLUMN verified_by text;                     -- US-006: which rule or which administrator

ALTER TABLE vehicle ADD COLUMN plate_warning text;                    -- US-003: warn, don't block

-- US-002: the list of user types and their identifier rules is configuration, not code.
CREATE TABLE user_type_rule (
  user_type                 user_type PRIMARY KEY,
  label                     text NOT NULL,
  requires_campus_identifier boolean NOT NULL,
  identifier_label          text,
  identifier_pattern        text,                                    -- POSIX regex; NULL when not required
  wallet_enabled            boolean NOT NULL,                        -- US-016: wallet for staff/students; guests pay at checkout
  active                    boolean NOT NULL DEFAULT true
);
-- Placeholder patterns: permissive until UNILAG's staff-number and matriculation formats are confirmed.
INSERT INTO user_type_rule VALUES
  ('staff',   'Staff',   true,  'Staff number',         '^[A-Za-z0-9/-]{4,20}$', true,  true),
  ('student', 'Student', true,  'Matriculation number', '^[A-Za-z0-9/-]{4,20}$', true,  true),
  ('guest',   'Guest',   false, NULL,                   NULL,                    false, true);

-- US-001: a six-digit code, valid ≤ 5 minutes, ≤ 5 attempts, resend ≤ once per 60 s. Only a hash is kept.
CREATE TABLE otp_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile_e164  text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenge_mobile_idx ON otp_challenge (mobile_e164, created_at DESC);

-- Refresh tokens rotate on every use; reuse of a rotated token revokes the whole family.
CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  rotated_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_token_family_idx ON refresh_token (family_id);

-- A client retry of the same booking must not create a second one.
ALTER TABLE reservation ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX reservation_idempotency_uq ON reservation (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
