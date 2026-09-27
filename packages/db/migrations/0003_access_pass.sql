-- DE-16 Access Pass (US-033, US-034, US-036) and early entry (US-038).

-- How early a driver may be admitted before the reserved start. The session still ends at the reserved end (US-027).
ALTER TABLE lot ADD COLUMN early_entry_minutes integer NOT NULL DEFAULT 15 CHECK (early_entry_minutes BETWEEN 0 AND 120);

CREATE TABLE access_pass (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- the opaque id carried in the QR
  reservation_id uuid NOT NULL UNIQUE REFERENCES reservation(id),
  lot_id         uuid NOT NULL REFERENCES lot(id),
  key_id         smallint NOT NULL,                             -- which signing key signed it
  signed_part    text NOT NULL,                                 -- the fixed part of the QR
  pin_lookup     text NOT NULL,                                 -- HMAC(pepper, lot:pin): uniqueness checks without the PIN
  pin_ciphertext text NOT NULL,                                 -- AES-256-GCM, so the driver can see their PIN again
  issued_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_pass_lot_pin_idx ON access_pass (lot_id, pin_lookup) WHERE revoked_at IS NULL;
