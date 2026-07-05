CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    endpoint TEXT PRIMARY KEY NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_updated_at
ON web_push_subscriptions (updated_at DESC);
