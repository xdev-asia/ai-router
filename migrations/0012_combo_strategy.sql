-- How a combo picks its model (FR-CMB-05): 'fallback', 'round-robin', 'smart' or 'fusion'. NULL follows the
-- gateway-wide setting "combo" (worker/combo-strategy.ts), which defaults to 'fallback'.
ALTER TABLE combo ADD COLUMN strategy TEXT;
-- The combo's own settings for its strategy, JSON: judge_model, router_model, policy, threshold, fusion (FR-CMB-26).
ALTER TABLE combo ADD COLUMN config TEXT;
