use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Cursor,
    time::Duration,
};

use anyhow::Context;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    web_push_subscription::WebPushSubscription,
    workspace::Workspace,
};
use deployment::Deployment;
use openssl::{
    ec::{EcGroup, EcKey, PointConversionForm},
    nid::Nid,
    pkey::{PKey, Private},
};
use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushMessageBuilder,
};

use crate::DeploymentImpl;

const VAPID_PRIVATE_KEY_ENV: &str = "WEB_PUSH_VAPID_PRIVATE_KEY";
const VAPID_PUBLIC_KEY_ENV: &str = "WEB_PUSH_VAPID_PUBLIC_KEY";
const VAPID_CONTACT_ENV: &str = "WEB_PUSH_CONTACT";
const VAPID_PRIVATE_KEY_FILE: &str = "web_push_vapid_private.pem";
const POLL_INTERVAL: Duration = Duration::from_secs(10);
const WEB_PUSH_MIN_ENCRYPTED_PAYLOAD_BYTES: usize = 4096;
const WEB_PUSH_AES128GCM_OVERHEAD_BYTES: usize = 103;
const WEB_PUSH_DESCRIPTION_SAFETY_MARGIN_BYTES: usize = 10;
const WEB_PUSH_FIXED_PAYLOAD_BUDGET_BYTES: usize = 512;
const WEB_PUSH_DESCRIPTION_BUDGET_BYTES: usize = WEB_PUSH_MIN_ENCRYPTED_PAYLOAD_BYTES
    - WEB_PUSH_AES128GCM_OVERHEAD_BYTES
    - WEB_PUSH_DESCRIPTION_SAFETY_MARGIN_BYTES
    - WEB_PUSH_FIXED_PAYLOAD_BUDGET_BYTES;

#[derive(Debug, Clone)]
pub struct VapidKeys {
    pub private_pem: String,
    pub public_key: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
struct WorkspaceAttentionPushPayload {
    #[serde(rename = "type")]
    kind: &'static str,
    event_id: String,
    title: String,
    body: String,
    deeplink_path: String,
    sound_url: Option<String>,
}

#[derive(Debug, Clone)]
struct WorkspaceAttention {
    workspace_id: Uuid,
    workspace_name: String,
    reason: AttentionReason,
    fingerprint: String,
    activity_turn_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy)]
enum AttentionReason {
    Approval,
    Activity,
}

#[derive(Debug, Clone, FromRow)]
struct LatestUnseenTurnInfo {
    workspace_id: Uuid,
    turn_id: Uuid,
}

pub fn load_or_create_vapid_keys() -> anyhow::Result<VapidKeys> {
    let subject =
        std::env::var(VAPID_CONTACT_ENV).unwrap_or_else(|_| "mailto:admin@localhost".to_string());

    if let (Ok(private_pem), Ok(public_key)) = (
        std::env::var(VAPID_PRIVATE_KEY_ENV),
        std::env::var(VAPID_PUBLIC_KEY_ENV),
    ) {
        return Ok(VapidKeys {
            private_pem,
            public_key,
            subject,
        });
    }

    let key_path = utils::assets::asset_dir().join(VAPID_PRIVATE_KEY_FILE);
    let private_pem = if key_path.exists() {
        fs::read_to_string(&key_path).with_context(|| {
            format!(
                "failed to read web push VAPID key from {}",
                key_path.display()
            )
        })?
    } else {
        let pem = generate_private_key_pem()?;
        fs::write(&key_path, &pem).with_context(|| {
            format!(
                "failed to persist web push VAPID key to {}",
                key_path.display()
            )
        })?;
        pem
    };

    let public_key = derive_public_key(&private_pem)?;

    Ok(VapidKeys {
        private_pem,
        public_key,
        subject,
    })
}

pub fn spawn_workspace_attention_monitor(deployment: DeploymentImpl, vapid_keys: VapidKeys) {
    tokio::spawn(async move {
        let mut seen_fingerprints: HashMap<Uuid, String> = HashMap::new();
        let mut initialized = false;
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            match collect_workspace_attention(&deployment).await {
                Ok(attention) => {
                    let active: HashMap<Uuid, WorkspaceAttention> = attention
                        .into_iter()
                        .map(|item| (item.workspace_id, item))
                        .collect();

                    seen_fingerprints.retain(|workspace_id, _| active.contains_key(workspace_id));

                    for (workspace_id, item) in active {
                        let already_seen = seen_fingerprints
                            .get(&workspace_id)
                            .is_some_and(|fingerprint| fingerprint == &item.fingerprint);

                        seen_fingerprints.insert(workspace_id, item.fingerprint.clone());

                        if initialized && !already_seen {
                            send_workspace_attention_pushes(&deployment, &vapid_keys, &item).await;
                        }
                    }

                    initialized = true;
                }
                Err(error) => {
                    tracing::warn!(?error, "failed to collect workspace attention state");
                }
            }
        }
    });
}

fn generate_private_key_pem() -> anyhow::Result<String> {
    let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1)?;
    let key = EcKey::generate(&group)?;
    let pem = key.private_key_to_pem()?;

    String::from_utf8(pem).context("generated VAPID private key was not UTF-8")
}

fn derive_public_key(private_pem: &str) -> anyhow::Result<String> {
    let key = EcKey::private_key_from_pem(private_pem.as_bytes())?;
    let group = key.group();
    let mut ctx = openssl::bn::BigNumContext::new()?;
    let bytes = key
        .public_key()
        .to_bytes(group, PointConversionForm::UNCOMPRESSED, &mut ctx)?;

    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn validate_private_key(private_pem: &str) -> anyhow::Result<PKey<Private>> {
    PKey::private_key_from_pem(private_pem.as_bytes()).context("invalid VAPID private key")
}

pub fn validate_vapid_keys(keys: &VapidKeys) -> anyhow::Result<()> {
    validate_private_key(&keys.private_pem)?;
    Ok(())
}

async fn collect_workspace_attention(
    deployment: &DeploymentImpl,
) -> anyhow::Result<Vec<WorkspaceAttention>> {
    let pool = &deployment.db().pool;
    let workspaces: Vec<_> = Workspace::find_all_with_status(pool, Some(false), None)
        .await?
        .into_iter()
        .map(|item| item.workspace)
        .collect();

    let latest_processes = ExecutionProcess::find_latest_for_workspaces(pool, false).await?;
    let running_ep_ids: Vec<_> = latest_processes
        .values()
        .filter(|info| info.status == ExecutionProcessStatus::Running)
        .map(|info| info.execution_process_id)
        .collect();
    let pending_approval_eps = deployment
        .approvals()
        .get_pending_execution_process_ids(&running_ep_ids);
    let unseen_workspaces = CodingAgentTurn::find_workspaces_with_unseen(pool, false).await?;
    let latest_unseen_turns = find_latest_unseen_turns(pool, false).await?;

    let attention = workspaces
        .into_iter()
        .filter_map(|workspace| {
            let latest = latest_processes.get(&workspace.id);
            let name = workspace
                .name
                .clone()
                .unwrap_or_else(|| workspace.id.to_string());

            if let Some(latest) = latest
                && latest.status == ExecutionProcessStatus::Running
                && pending_approval_eps.contains(&latest.execution_process_id)
            {
                return Some(WorkspaceAttention {
                    workspace_id: workspace.id,
                    workspace_name: name,
                    reason: AttentionReason::Approval,
                    fingerprint: format!("approval:{}", latest.execution_process_id),
                    activity_turn_id: None,
                });
            }

            if unseen_workspaces.contains(&workspace.id)
                && !matches!(
                    latest.map(|info| &info.status),
                    Some(ExecutionProcessStatus::Running)
                )
            {
                let turn_id = latest_unseen_turns
                    .get(&workspace.id)
                    .copied()
                    .unwrap_or(workspace.id);
                return Some(WorkspaceAttention {
                    workspace_id: workspace.id,
                    workspace_name: name,
                    reason: AttentionReason::Activity,
                    fingerprint: format!("activity:{turn_id}"),
                    activity_turn_id: Some(turn_id),
                });
            }

            None
        })
        .collect();

    Ok(attention)
}

async fn find_latest_unseen_turns(
    pool: &SqlitePool,
    archived: bool,
) -> Result<HashMap<Uuid, Uuid>, sqlx::Error> {
    let rows = sqlx::query_as::<_, LatestUnseenTurnInfo>(
        r#"
        SELECT workspace_id, turn_id
        FROM (
            SELECT
                s.workspace_id AS workspace_id,
                cat.id AS turn_id,
                ROW_NUMBER() OVER (
                    PARTITION BY s.workspace_id
                    ORDER BY cat.created_at DESC
                ) AS rn
            FROM coding_agent_turns cat
            JOIN execution_processes ep ON cat.execution_process_id = ep.id
            JOIN sessions s ON ep.session_id = s.id
            JOIN workspaces w ON s.workspace_id = w.id
            WHERE cat.seen = 0
              AND w.archived = ?
        )
        WHERE rn = 1
        "#,
    )
    .bind(archived)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| (row.workspace_id, row.turn_id))
        .collect())
}

async fn send_workspace_attention_pushes(
    deployment: &DeploymentImpl,
    vapid_keys: &VapidKeys,
    attention: &WorkspaceAttention,
) {
    let subscriptions = match WebPushSubscription::list(&deployment.db().pool).await {
        Ok(subscriptions) => subscriptions,
        Err(error) => {
            tracing::warn!(?error, "failed to list web push subscriptions");
            return;
        }
    };

    if subscriptions.is_empty() {
        return;
    }

    let config = deployment.config().read().await.notifications.clone();
    let sound_url = if config.sound_enabled {
        Some(format!("/api/sounds/{}", config.sound_file.to_filename()))
    } else {
        None
    };
    let payload = WorkspaceAttentionPushPayload {
        kind: "workspace_attention",
        event_id: format!(
            "workspace-attention:local:{}:{}",
            attention.workspace_id, attention.fingerprint
        ),
        title: "Workspace needs attention".to_string(),
        body: build_workspace_attention_body(&deployment.db().pool, attention).await,
        deeplink_path: format!("/workspaces/{}", attention.workspace_id),
        sound_url,
    };

    let payload_bytes = match serialize_workspace_attention_payload(&payload) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(?error, "failed to encode web push payload");
            return;
        }
    };

    let client = match IsahcWebPushClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(?error, "failed to create web push client");
            return;
        }
    };

    let mut stale_endpoints = HashSet::new();

    for subscription in subscriptions {
        match send_web_push(&client, vapid_keys, &subscription, &payload_bytes).await {
            Ok(()) => {}
            Err(error) => {
                tracing::warn!(
                    endpoint = %subscription.endpoint,
                    ?error,
                    "failed to send workspace attention web push"
                );
                stale_endpoints.insert(subscription.endpoint);
            }
        }
    }

    for endpoint in stale_endpoints {
        if let Err(error) = WebPushSubscription::delete(&deployment.db().pool, &endpoint).await {
            tracing::warn!(%endpoint, ?error, "failed to remove stale web push subscription");
        }
    }
}

async fn build_workspace_attention_body(
    pool: &SqlitePool,
    attention: &WorkspaceAttention,
) -> String {
    match attention.reason {
        AttentionReason::Approval => {
            format!("{} is waiting for approval.", attention.workspace_name)
        }
        AttentionReason::Activity => {
            let Some(turn_id) = attention.activity_turn_id else {
                return format!("{} has new activity.", attention.workspace_name);
            };

            match latest_agent_response_excerpt(pool, turn_id).await {
                Ok(Some(excerpt)) => {
                    format!("{} has new activity: {}", attention.workspace_name, excerpt)
                }
                Ok(None) => format!("{} has new activity.", attention.workspace_name),
                Err(error) => {
                    tracing::warn!(
                        %turn_id,
                        ?error,
                        "failed to load agent response excerpt for workspace attention push"
                    );
                    format!("{} has new activity.", attention.workspace_name)
                }
            }
        }
    }
}

async fn latest_agent_response_excerpt(
    pool: &SqlitePool,
    turn_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let summary = sqlx::query_scalar::<_, Option<String>>(
        r#"
        SELECT summary
        FROM coding_agent_turns
        WHERE id = ?
        "#,
    )
    .bind(turn_id)
    .fetch_optional(pool)
    .await?
    .flatten();

    Ok(summary.and_then(|value| normalize_push_description(&value)))
}

fn normalize_push_description(value: &str) -> Option<String> {
    let without_tags = strip_html_tags(value);
    let decoded = decode_common_html_entities(&without_tags);
    let normalized = decoded.split_whitespace().collect::<Vec<_>>().join(" ");

    if normalized.is_empty() {
        None
    } else {
        Some(take_utf8_tail(
            &normalized,
            WEB_PUSH_DESCRIPTION_BUDGET_BYTES,
        ))
    }
}

fn strip_html_tags(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_tag = false;

    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    output
}

fn decode_common_html_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn take_utf8_tail(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }

    value[start..].to_string()
}

fn serialize_workspace_attention_payload(
    payload: &WorkspaceAttentionPushPayload,
) -> Result<Vec<u8>, serde_json::Error> {
    let payload_budget = WEB_PUSH_MIN_ENCRYPTED_PAYLOAD_BYTES
        - WEB_PUSH_AES128GCM_OVERHEAD_BYTES
        - WEB_PUSH_DESCRIPTION_SAFETY_MARGIN_BYTES;
    let mut payload = payload.clone();

    loop {
        let bytes = serde_json::to_vec(&payload)?;
        if bytes.len() <= payload_budget || payload.body.is_empty() {
            return Ok(bytes);
        }

        let overflow = bytes.len() - payload_budget;
        let max_body_bytes = payload.body.len().saturating_sub(overflow + 1);
        payload.body = take_utf8_tail(&payload.body, max_body_bytes);
    }
}

async fn send_web_push(
    client: &IsahcWebPushClient,
    vapid_keys: &VapidKeys,
    subscription: &WebPushSubscription,
    payload: &[u8],
) -> anyhow::Result<()> {
    let subscription_info = SubscriptionInfo::new(
        &subscription.endpoint,
        &subscription.p256dh,
        &subscription.auth,
    );
    let mut signature_builder = VapidSignatureBuilder::from_pem(
        Cursor::new(vapid_keys.private_pem.as_bytes()),
        &subscription_info,
    )?;
    signature_builder.add_claim("sub", vapid_keys.subject.clone());
    let signature = signature_builder.build()?;

    let mut builder = WebPushMessageBuilder::new(&subscription_info);
    builder.set_payload(ContentEncoding::Aes128Gcm, payload);
    builder.set_vapid_signature(signature);

    client.send(builder.build()?).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_push_description_text() {
        let description =
            normalize_push_description("<p>Hello&nbsp;<strong>world</strong> &amp; team</p>")
                .expect("description should not be empty");

        assert_eq!(description, "Hello world & team");
    }

    #[test]
    fn takes_utf8_tail_without_splitting_characters() {
        let tail = take_utf8_tail("abcéfg", 4);

        assert!(tail.is_char_boundary(0));
        assert_eq!(tail, "éfg");
        assert!(tail.len() <= 4);
    }
}
