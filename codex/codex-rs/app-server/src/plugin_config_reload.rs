//! Adapts existing config loaders for blocking plugin-upgrade workers.
//! Reloads must use the same normal or fallback entry point as the initial load.

use crate::config_manager::ConfigManager;
use codex_core_plugins::ConfigLayerReload;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::sync::Arc;

/// The config-loading path used to select marketplaces for startup tasks.
pub(crate) enum PluginStartupConfig {
    Current,
}

pub(crate) fn for_cwd(manager: ConfigManager, cwd: AbsolutePathBuf) -> ConfigLayerReload {
    let runtime = tokio::runtime::Handle::current();
    Arc::new(move || runtime.block_on(manager.load_config_layers_for_cwd(cwd.clone())))
}
