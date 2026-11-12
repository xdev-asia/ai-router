-- Who signed in, within the provider's account (the ID token's `sub`, else its email). Two people of one ChatGPT
-- workspace share an account id; each gets a connection of their own. NULL for API keys.
ALTER TABLE connection ADD COLUMN subject TEXT;
