-- Proxy pools also hold HTTP CONNECT and SOCKS5 proxies (worker/socket-fetch.ts), beside the https relays.
-- `proxies`: JSON [{kind, host, port, has_auth}], no credential. `proxy_auth`: the proxies' user names and
-- passwords, one JSON object sealed with CONNECTIONS_KEY (worker/secret-box.ts), keyed by "kind://host:port".
-- A pool with no https relay keeps '' in `secret` and `hint`.
ALTER TABLE proxy_pool ADD COLUMN proxies TEXT NOT NULL DEFAULT '[]';
ALTER TABLE proxy_pool ADD COLUMN proxy_auth TEXT;
