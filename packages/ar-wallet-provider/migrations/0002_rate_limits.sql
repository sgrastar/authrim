-- Fixed-window counters for the wallet provider's own rate limits (no Durable Object needed).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX rate_limits_window_start ON rate_limits (window_start);
