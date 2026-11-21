-- A combo's own upstream timeouts (docs/srs/combo-timeouts.md), JSON with only the set fields: first_byte_s, idle_s.
-- NULL, or a field left out, follows the gateway-wide setting "timeouts" (worker/timeouts.ts).
ALTER TABLE combo ADD COLUMN timeouts TEXT;
