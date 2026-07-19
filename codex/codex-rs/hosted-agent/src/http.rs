use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::HeaderValue;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::AgentCheckpoint;
use crate::AgentCheckpointRequest;
use crate::AgentPatchApplyRequest;
use crate::AgentPatchArtifact;
use crate::AgentPatchExportRequest;
use crate::AgentProvisionRequest;
use crate::AgentReconnectRequest;
use crate::AgentReleaseRequest;
use crate::AgentRetention;
use crate::AgentRetentionRequest;
use crate::HostedAgentError;
use crate::HostedAgentErrorCategory;
use crate::HostedAgentService;
use crate::MAX_OPAQUE_ID_BYTES;
use crate::PatchApplyResult;
use crate::ProvisionedAgent;
use crate::types::Result;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_CONFLICT_PATHS: usize = 256;

pub const CODEX_HOSTED_AGENT_TOKEN_ENV_VAR: &str = "CODEX_HOSTED_AGENT_TOKEN";

/// HTTP implementation of the hosted-agent service contract.
///
/// Authentication is retained only in memory and all diagnostics intentionally
/// omit the service URL, bearer token, response body, and connection endpoint.
pub struct HttpHostedAgentService {
    client: reqwest::Client,
    service_url: url::Url,
    authorization: HeaderValue,
    issued_ids: Mutex<IssuedIds>,
}

#[derive(Default)]
struct IssuedIds {
    leases: HashMap<String, String>,
    environments: HashMap<String, String>,
    provision_keys: HashMap<(String, String), Option<String>>,
}

impl HttpHostedAgentService {
    pub fn from_env(service_url: &str) -> Result<Self> {
        let token = std::env::var(CODEX_HOSTED_AGENT_TOKEN_ENV_VAR).map_err(|_| {
            HostedAgentError::new(
                HostedAgentErrorCategory::Unauthorized,
                "hosted-agent service token is not set",
            )
        })?;
        Self::new(service_url, &token)
    }

    pub fn new(service_url: &str, bearer_token: &str) -> Result<Self> {
        Self::with_timeout(service_url, bearer_token, DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(
        service_url: &str,
        bearer_token: &str,
        request_timeout: Duration,
    ) -> Result<Self> {
        Self::build(
            service_url,
            bearer_token,
            request_timeout,
            /*allow_insecure_loopback*/ false,
        )
    }

    #[cfg(test)]
    pub(crate) fn for_test(service_url: &str, bearer_token: &str) -> Result<Self> {
        Self::build(
            service_url,
            bearer_token,
            DEFAULT_TIMEOUT,
            /*allow_insecure_loopback*/ true,
        )
    }

    fn build(
        service_url: &str,
        bearer_token: &str,
        request_timeout: Duration,
        allow_insecure_loopback: bool,
    ) -> Result<Self> {
        if request_timeout.is_zero() {
            return Err(HostedAgentError::new(
                HostedAgentErrorCategory::ConnectionFailed,
                "request timeout must be non-zero",
            ));
        }
        let mut service_url = url::Url::parse(service_url).map_err(|_| {
            HostedAgentError::new(
                HostedAgentErrorCategory::ConnectionFailed,
                "service URL is invalid",
            )
        })?;
        let test_loopback = allow_insecure_loopback
            && service_url.scheme() == "http"
            && service_url.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
        if (service_url.scheme() != "https" && !test_loopback)
            || service_url.host_str().is_none()
            || !service_url.username().is_empty()
            || service_url.password().is_some()
            || service_url.query().is_some()
            || service_url.fragment().is_some()
        {
            return Err(HostedAgentError::new(
                HostedAgentErrorCategory::ConnectionFailed,
                "service URL is invalid",
            ));
        }
        if !service_url.path().ends_with('/') {
            service_url.set_path(&format!("{}/", service_url.path()));
        }
        if bearer_token.is_empty() {
            return Err(HostedAgentError::new(
                HostedAgentErrorCategory::Unauthorized,
                "service token is empty",
            ));
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {bearer_token}")).map_err(|_| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::Unauthorized,
                    "service token is invalid",
                )
            })?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT.min(request_timeout))
            .timeout(request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::ConnectionFailed,
                    "failed to construct HTTP client",
                )
            })?;
        Ok(Self {
            client,
            service_url,
            authorization,
            issued_ids: Mutex::new(IssuedIds::default()),
        })
    }

    async fn send<Request>(&self, path: &str, request: &Request) -> Result<reqwest::Response>
    where
        Request: Serialize + ?Sized,
    {
        self.send_with_not_found_category(path, request, HostedAgentErrorCategory::SnapshotMissing)
            .await
    }

    async fn send_with_not_found_category<Request>(
        &self,
        path: &str,
        request: &Request,
        not_found_category: HostedAgentErrorCategory,
    ) -> Result<reqwest::Response>
    where
        Request: Serialize + ?Sized,
    {
        let endpoint = self.service_url.join(path).map_err(|_| {
            HostedAgentError::new(
                HostedAgentErrorCategory::ConnectionFailed,
                "service endpoint is invalid",
            )
        })?;
        let response = self
            .client
            .post(endpoint)
            .header(reqwest::header::AUTHORIZATION, self.authorization.clone())
            .json(request)
            .send()
            .await
            .map_err(|_| {
                HostedAgentError::new(
                    HostedAgentErrorCategory::Unavailable,
                    "service request failed",
                )
            })?;
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(error_for_status(response.status(), not_found_category))
        }
    }

    async fn post<Request, Response>(&self, path: &str, request: &Request) -> Result<Response>
    where
        Request: Serialize + ?Sized,
        Response: DeserializeOwned,
    {
        decode_response(self.send(path, request).await?).await
    }

    fn validate_provisioned(
        &self,
        provisioned: &ProvisionedAgent,
        provision_key: Option<&str>,
    ) -> Result<()> {
        if provisioned.lease_id.trim().is_empty()
            || provisioned.environment_id.trim().is_empty()
            || provisioned.base_snapshot_id.trim().is_empty()
        {
            return Err(HostedAgentError::invalid_response(
                "service returned an empty opaque ID",
            ));
        }
        provisioned.connection.validate()?;
        let mut issued = self
            .issued_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if issued
            .leases
            .get(&provisioned.lease_id)
            .is_some_and(|environment| environment != &provisioned.environment_id)
            || issued
                .environments
                .get(&provisioned.environment_id)
                .is_some_and(|lease| lease != &provisioned.lease_id)
        {
            return Err(HostedAgentError::invalid_response(
                "service returned a duplicate lease or environment ID",
            ));
        }
        let pair = (
            provisioned.lease_id.clone(),
            provisioned.environment_id.clone(),
        );
        if let Some(provision_key) = provision_key
            && issued
                .provision_keys
                .get(&pair)
                .is_some_and(|key| key.as_deref() != Some(provision_key))
        {
            return Err(HostedAgentError::invalid_response(
                "service reused a lease and environment for a different provision request",
            ));
        }
        issued.leases.insert(
            provisioned.lease_id.clone(),
            provisioned.environment_id.clone(),
        );
        issued.environments.insert(
            provisioned.environment_id.clone(),
            provisioned.lease_id.clone(),
        );
        match provision_key {
            Some(key) => {
                issued.provision_keys.insert(pair, Some(key.to_string()));
            }
            None => {
                issued.provision_keys.entry(pair).or_insert(None);
            }
        }
        Ok(())
    }
}

impl fmt::Debug for HttpHostedAgentService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpHostedAgentService")
            .field("client", &"[REDACTED]")
            .field("service_url", &"[REDACTED]")
            .field("authorization", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl HostedAgentService for HttpHostedAgentService {
    async fn provision(&self, request: AgentProvisionRequest) -> Result<ProvisionedAgent> {
        let provisioned: ProvisionedAgent = self.post("v1/agents/provision", &request).await?;
        self.validate_provisioned(&provisioned, Some(&request.idempotency_key))?;
        Ok(provisioned)
    }

    async fn reconnect(&self, request: AgentReconnectRequest) -> Result<ProvisionedAgent> {
        let response = self
            .send_with_not_found_category(
                "v1/agents/reconnect",
                &request,
                HostedAgentErrorCategory::LeaseMissing,
            )
            .await?;
        let provisioned: ProvisionedAgent = decode_response(response).await?;
        self.validate_provisioned(&provisioned, None)?;
        Ok(provisioned)
    }

    async fn checkpoint(&self, request: AgentCheckpointRequest) -> Result<AgentCheckpoint> {
        let checkpoint: AgentCheckpoint = self.post("v1/agents/checkpoint", &request).await?;
        validate_opaque_id(&checkpoint.snapshot_id, "snapshot")?;
        Ok(checkpoint)
    }

    async fn export_patch(&self, request: AgentPatchExportRequest) -> Result<AgentPatchArtifact> {
        let artifact: AgentPatchArtifact = self.post("v1/agents/patch/export", &request).await?;
        validate_opaque_id(&artifact.artifact_id, "artifact")?;
        validate_opaque_id(&artifact.base_snapshot_id, "base snapshot")?;
        if artifact.checksum.trim().is_empty() {
            return Err(HostedAgentError::invalid_response(
                "service returned an empty patch checksum",
            ));
        }
        Ok(artifact)
    }

    async fn apply_patch(&self, request: AgentPatchApplyRequest) -> Result<PatchApplyResult> {
        let result: PatchApplyResult = self.post("v1/agents/patch/apply", &request).await?;
        match &result {
            PatchApplyResult::Applied { checkpoint } => {
                validate_opaque_id(&checkpoint.snapshot_id, "snapshot")?;
            }
            PatchApplyResult::Conflict { paths } if paths.len() > MAX_CONFLICT_PATHS => {
                return Err(HostedAgentError::invalid_response(
                    "service returned too many conflict paths",
                ));
            }
            PatchApplyResult::Rejected { reason } if reason.len() > 4096 => {
                return Err(HostedAgentError::invalid_response(
                    "service returned an oversized rejection",
                ));
            }
            PatchApplyResult::Conflict { .. } | PatchApplyResult::Rejected { .. } => {}
        }
        Ok(result)
    }

    async fn release(&self, request: AgentReleaseRequest) -> Result<()> {
        self.send("v1/agents/release", &request).await?;
        Ok(())
    }

    async fn retain(&self, request: AgentRetentionRequest) -> Result<AgentRetention> {
        let retained: AgentRetention = self.post("v1/agents/retain", &request).await?;
        if retained.revision == 0
            || retained.desired_hash.len() != 64
            || !retained
                .desired_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(HostedAgentError::invalid_response(
                "service returned invalid retained state",
            ));
        }
        Ok(retained)
    }
}

async fn decode_response<Response>(mut response: reqwest::Response) -> Result<Response>
where
    Response: DeserializeOwned,
{
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(HostedAgentError::invalid_response(
            "service response exceeded the size limit",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        HostedAgentError::new(
            HostedAgentErrorCategory::Unavailable,
            "service response failed",
        )
    })? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(HostedAgentError::invalid_response(
                "service response exceeded the size limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| HostedAgentError::invalid_response("service returned an invalid response"))
}

fn validate_opaque_id(value: &str, kind: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(HostedAgentError::invalid_response(format!(
            "service returned an empty {kind} ID"
        )))
    } else if value.len() > MAX_OPAQUE_ID_BYTES {
        Err(HostedAgentError::invalid_response(format!(
            "service returned an oversized {kind} ID"
        )))
    } else {
        Ok(())
    }
}

fn error_for_status(
    status: StatusCode,
    not_found_category: HostedAgentErrorCategory,
) -> HostedAgentError {
    let category = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => HostedAgentErrorCategory::Unauthorized,
        StatusCode::NOT_FOUND => not_found_category,
        StatusCode::CONFLICT => HostedAgentErrorCategory::PatchConflict,
        StatusCode::UNPROCESSABLE_ENTITY => HostedAgentErrorCategory::InvalidTemplate,
        StatusCode::TOO_MANY_REQUESTS => HostedAgentErrorCategory::QuotaExceeded,
        StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT => {
            HostedAgentErrorCategory::Unavailable
        }
        _ => HostedAgentErrorCategory::ConnectionFailed,
    };
    HostedAgentError::new(category, "service rejected the request")
}
