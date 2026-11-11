-- Token savers, off unless set per system: RTK compresses tool results in the request (lossy: long outputs are cut),
-- Caveman and Ponytail append a style instruction to the system prompt. Levels: lite, full, ultra.
ALTER TABLE system ADD COLUMN rtk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE system ADD COLUMN caveman TEXT;
ALTER TABLE system ADD COLUMN ponytail TEXT;

-- Bytes RTK removed from the request, to measure it against the token counts of the same row.
ALTER TABLE usage ADD COLUMN rtk_saved_bytes INTEGER NOT NULL DEFAULT 0;
