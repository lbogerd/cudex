use super::*;
use codex_otel::MetricsConfig;
use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use opentelemetry_sdk::metrics::data::AggregatedMetrics;
use opentelemetry_sdk::metrics::data::MetricData;
use pretty_assertions::assert_eq;
use std::collections::BTreeMap;

#[test]
fn denied_tool_domain_metric_uses_only_the_coarse_domain() {
    let metrics = MetricsClient::new(
        MetricsConfig::in_memory(
            "test",
            "codex-core",
            env!("CARGO_PKG_VERSION"),
            InMemoryMetricExporter::default(),
        )
        .with_runtime_reader(),
    )
    .expect("in-memory metrics client");
    let telemetry = HostedAgentTelemetry {
        metrics: Some(metrics.clone()),
    };
    telemetry.record_denied_tool_domain(&ToolExecutionDomain::EnvironmentBoundMcp {
        server: "high-cardinality-server".to_string(),
        environment_id: "opaque-environment-id".to_string(),
    });

    let snapshot = metrics.snapshot().expect("runtime metrics snapshot");
    let metric = snapshot
        .scope_metrics()
        .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
        .find(|metric| metric.name() == DENIED_TOOL_DOMAIN_METRIC)
        .expect("denied domain metric");
    let AggregatedMetrics::U64(data) = metric.data() else {
        panic!("unexpected metric data type");
    };
    let MetricData::Sum(sum) = data else {
        panic!("unexpected metric aggregation");
    };
    let points = sum.data_points().collect::<Vec<_>>();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].value(), 1);
    assert_eq!(
        points[0]
            .attributes()
            .map(|attribute: &KeyValue| (
                attribute.key.as_str().to_string(),
                attribute.value.as_str().to_string(),
            ))
            .collect::<BTreeMap<_, _>>(),
        BTreeMap::from([("domain".to_string(), "environment_bound_mcp".to_string(),)])
    );
}
