-- US-009: the lot carries what a driver needs to find it. Values are set during pilot setup.
ALTER TABLE lot ADD COLUMN building text;
ALTER TABLE lot ADD COLUMN gate_directions text;            -- the point a driver must actually reach, in words
ALTER TABLE lot ADD COLUMN entrance_photo_url text;
ALTER TABLE lot ADD COLUMN gps_lat numeric(9,6);
ALTER TABLE lot ADD COLUMN gps_lng numeric(9,6);
ALTER TABLE lot ADD COLUMN gate_lat numeric(9,6);
ALTER TABLE lot ADD COLUMN gate_lng numeric(9,6);
