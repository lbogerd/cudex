use std::time::Duration;

use codex_otel::MetricsClient;
use codex_tools::ToolExecutionDomain;

const PROVISION_DURATION_METRIC: &str = "codex.hosted_agent.provision_duration_ms";
const RESTORE_COUNT_METRIC: &str = "codex.hosted_agent.restore";
const ACTIVE_LEASE_COUNT_METRIC: &str = "codex.hosted_agent.active_leases";
const CHECKPOINT_DURATION_METRIC: &str = "codex.hosted_agent.checkpoint_duration_ms";
const PATCH_SIZE_METRIC: &str = "codex.hosted_agent.patch_size_bytes";
const PATCH_CONFLICT_METRIC: &str = "codex.hosted_agent.patch_conflict";
const DENIED_TOOL_DOMAIN_METRIC: &str = "codex.hosted_agent.denied_tool_domain";
const CLEANUP_RETRY_METRIC: &str = "codex.hosted_agent.cleanup_retry";
const LOCAL_FALLBACK_ATTEMPT_METRIC: &str = "codex.hosted_agent.local_fallback_attempt";

#[derive(Clone, Copy)]
pub(crate) enum ProvisionKind {
    Fresh,
    Restore,
}

#[derive(Clone, Copy)]
pub(crate) enum CheckpointKind {
    Turn,
    Completion,
}

#[derive(Clone, Copy)]
pub(crate) enum LocalFallbackPath {
    ThreadStart,
    Delegate,
}

struct HostedAgentTelemetry {
    metrics: Option<MetricsClient>,
}

impl HostedAgentTelemetry {
    fn global() -> Self {
        Self {
            metrics: codex_otel::global(),
        }
    }

    fn record_provision_duration(&self, kind: ProvisionKind, duration: Duration, success: bool) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.record_duration(
            PROVISION_DURATION_METRIC,
            duration,
            &[
                ("kind", provision_kind_tag(kind)),
                ("result", result_tag(success)),
            ],
        );
    }

    fn record_restore(&self, success: bool) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.counter(
            RESTORE_COUNT_METRIC,
            /*inc*/ 1,
            &[("result", result_tag(success))],
        );
    }

    fn record_active_leases(&self, count: usize) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.gauge(ACTIVE_LEASE_COUNT_METRIC, bounded_usize(count), &[]);
    }

    fn record_checkpoint_duration(&self, kind: CheckpointKind, duration: Duration, success: bool) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.record_duration(
            CHECKPOINT_DURATION_METRIC,
            duration,
            &[
                ("kind", checkpoint_kind_tag(kind)),
                ("result", result_tag(success)),
            ],
        );
    }

    fn record_patch_size(&self, size_bytes: u64) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.histogram(PATCH_SIZE_METRIC, bounded_i64(size_bytes), &[]);
    }

    fn record_patch_conflict(&self, path_count: usize) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.counter(PATCH_CONFLICT_METRIC, /*inc*/ 1, &[]);
        let _ = metrics.histogram(
            "codex.hosted_agent.patch_conflict_paths",
            bounded_usize(path_count),
            &[],
        );
    }

    fn record_denied_tool_domain(&self, domain: &ToolExecutionDomain) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.counter(
            DENIED_TOOL_DOMAIN_METRIC,
            /*inc*/ 1,
            &[("domain", tool_domain_tag(domain))],
        );
    }

    fn record_cleanup_retry(&self, success: bool) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.counter(
            CLEANUP_RETRY_METRIC,
            /*inc*/ 1,
            &[("result", result_tag(success))],
        );
    }

    fn record_local_fallback_attempt(&self, path: LocalFallbackPath) {
        let Some(metrics) = &self.metrics else {
            return;
        };
        let _ = metrics.counter(
            LOCAL_FALLBACK_ATTEMPT_METRIC,
            /*inc*/ 1,
            &[("path", local_fallback_path_tag(path))],
        );
    }
}

pub(crate) fn record_provision_duration(kind: ProvisionKind, duration: Duration, success: bool) {
    HostedAgentTelemetry::global().record_provision_duration(kind, duration, success);
}

pub(crate) fn record_restore(success: bool) {
    HostedAgentTelemetry::global().record_restore(success);
}

pub(crate) fn record_active_leases(count: usize) {
    HostedAgentTelemetry::global().record_active_leases(count);
}

pub(crate) fn record_checkpoint_duration(kind: CheckpointKind, duration: Duration, success: bool) {
    HostedAgentTelemetry::global().record_checkpoint_duration(kind, duration, success);
}

pub(crate) fn record_patch_size(size_bytes: u64) {
    HostedAgentTelemetry::global().record_patch_size(size_bytes);
}

pub(crate) fn record_patch_conflict(path_count: usize) {
    HostedAgentTelemetry::global().record_patch_conflict(path_count);
}

pub(crate) fn record_denied_tool_domain(domain: &ToolExecutionDomain) {
    HostedAgentTelemetry::global().record_denied_tool_domain(domain);
}

pub(crate) fn record_cleanup_retry(success: bool) {
    HostedAgentTelemetry::global().record_cleanup_retry(success);
}

pub(crate) fn record_local_fallback_attempt(path: LocalFallbackPath) {
    HostedAgentTelemetry::global().record_local_fallback_attempt(path);
}

fn provision_kind_tag(kind: ProvisionKind) -> &'static str {
    match kind {
        ProvisionKind::Fresh => "fresh",
        ProvisionKind::Restore => "restore",
    }
}

fn checkpoint_kind_tag(kind: CheckpointKind) -> &'static str {
    match kind {
        CheckpointKind::Turn => "turn",
        CheckpointKind::Completion => "completion",
    }
}

fn local_fallback_path_tag(path: LocalFallbackPath) -> &'static str {
    match path {
        LocalFallbackPath::ThreadStart => "thread_start",
        LocalFallbackPath::Delegate => "delegate",
    }
}

fn result_tag(success: bool) -> &'static str {
    if success { "success" } else { "failure" }
}

fn tool_domain_tag(domain: &ToolExecutionDomain) -> &'static str {
    match domain {
        ToolExecutionDomain::AgentEnvironment => "agent_environment",
        ToolExecutionDomain::ControlPlane => "control_plane",
        ToolExecutionDomain::ProviderHosted => "provider_hosted",
        ToolExecutionDomain::EnvironmentBoundMcp { .. } => "environment_bound_mcp",
        ToolExecutionDomain::AmbientMcp { .. } => "ambient_mcp",
        ToolExecutionDomain::ClientCallback => "client_callback",
        ToolExecutionDomain::Extension => "extension",
        ToolExecutionDomain::OrchestratorProcess => "orchestrator_process",
    }
}

fn bounded_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn bounded_usize(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
#[path = "hosted_agent_telemetry_tests.rs"]
mod tests;
