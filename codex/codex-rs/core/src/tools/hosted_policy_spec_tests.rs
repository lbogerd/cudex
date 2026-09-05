use std::sync::Arc;

use codex_features::Feature;
use codex_protocol::config_types::WebSearchMode;
use codex_tools::ToolSpec;
use pretty_assertions::assert_eq;

use crate::session::tests::make_session_and_context;

#[tokio::test]
async fn hosted_sessions_never_advertise_provider_native_search() {
    for mode in [WebSearchMode::Cached, WebSearchMode::Live] {
        let (_session, mut turn) = make_session_and_context().await;
        let mut config = (*turn.config).clone();
        config.web_search_mode.set(mode).unwrap();
        turn.config = Arc::new(config.clone());
        // Ensure the test provider normally offers this tool for both search modes.
        assert!(!super::hosted_model_tool_specs(&turn, turn.model_info(), &[]).is_empty());

        config.features.enable(Feature::HostedAgents).unwrap();
        // Deliberately leave Live/Cached selected to simulate a turn override: the
        // hosted boundary must hold independently of the initial Disabled setting.
        turn.config = Arc::new(config);
        assert_eq!(
            super::hosted_model_tool_specs(&turn, turn.model_info(), &[]),
            Vec::<ToolSpec>::new()
        );
    }
}
