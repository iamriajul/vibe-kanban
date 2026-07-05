use axum::{
    Extension, Json, Router,
    extract::State,
    http::HeaderMap,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::web_push_subscription::WebPushSubscription;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError, runtime::web_push::VapidKeys};

pub fn router(vapid_keys: VapidKeys) -> Router<DeploymentImpl> {
    Router::new()
        .route("/web-push/config", get(get_web_push_config))
        .route(
            "/web-push/subscriptions",
            post(upsert_subscription).delete(delete_subscription),
        )
        .layer(Extension(vapid_keys))
}

#[derive(Debug, Serialize)]
pub struct WebPushConfigResponse {
    pub enabled: bool,
    pub public_key: String,
}

#[derive(Debug, Deserialize)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize)]
pub struct PushSubscriptionRequest {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

#[axum::debug_handler]
async fn get_web_push_config(
    Extension(vapid_keys): Extension<VapidKeys>,
) -> ResponseJson<ApiResponse<WebPushConfigResponse>> {
    ResponseJson(ApiResponse::success(WebPushConfigResponse {
        enabled: true,
        public_key: vapid_keys.public_key,
    }))
}

#[axum::debug_handler]
async fn upsert_subscription(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(request): Json<PushSubscriptionRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok());

    WebPushSubscription::upsert(
        &deployment.db().pool,
        &request.endpoint,
        &request.keys.p256dh,
        &request.keys.auth,
        user_agent,
    )
    .await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

#[axum::debug_handler]
async fn delete_subscription(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushSubscriptionRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    WebPushSubscription::delete(&deployment.db().pool, &request.endpoint).await?;

    Ok(ResponseJson(ApiResponse::success(())))
}
