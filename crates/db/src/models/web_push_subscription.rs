use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct WebPushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl WebPushSubscription {
    pub async fn upsert(
        pool: &SqlitePool,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        user_agent: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO web_push_subscriptions (
                endpoint, p256dh, auth, user_agent, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, datetime('now', 'subsec'), datetime('now', 'subsec'))
            ON CONFLICT(endpoint) DO UPDATE SET
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                updated_at = datetime('now', 'subsec')
            "#,
        )
        .bind(endpoint)
        .bind(p256dh)
        .bind(auth)
        .bind(user_agent)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, endpoint: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM web_push_subscriptions WHERE endpoint = ?")
            .bind(endpoint)
            .execute(pool)
            .await?;

        Ok(())
    }

    pub async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"
            SELECT endpoint, p256dh, auth, user_agent, created_at, updated_at
            FROM web_push_subscriptions
            ORDER BY updated_at DESC
            "#,
        )
        .fetch_all(pool)
        .await
    }
}
