#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use codex_code_mode_protocol::host::CapabilitySet;
use codex_code_mode_protocol::host::EncodedFrame;
use codex_code_mode_protocol::host::HostHello;
use codex_code_mode_protocol::host::HostToClient;
use codex_code_mode_protocol::host::ProtocolVersion;
use codex_exec_server::Environment;
use codex_exec_server::ExecParams;
use codex_exec_server::ProcessId;
use codex_utils_path_uri::PathUri;

use super::Connection;

#[tokio::test]
async fn exec_stdio_handshake_and_drop_stop_the_owned_process_group() {
    let hello = EncodedFrame::encode(&HostToClient::HostHello(HostHello::new(
        ProtocolVersion::V1,
        CapabilitySet::empty(),
    )))
    .unwrap()
    .into_framed_bytes();
    let escaped = hello
        .iter()
        .map(|byte| format!("\\{byte:03o}"))
        .collect::<String>();
    let environment = Environment::default_for_tests();
    let started = environment
        .get_exec_backend()
        .start(ExecParams {
            process_id: ProcessId::new("hosted-stdio-test"),
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                format!("printf '%b' '{escaped}'; /bin/cat >/dev/null"),
            ],
            cwd: PathUri::from_host_native_path(std::env::current_dir().unwrap()).unwrap(),
            env_policy: None,
            shell_snapshot: None,
            env: HashMap::new(),
            tty: false,
            pipe_stdin: true,
            arg0: None,
            sandbox: None,
            enforce_managed_network: false,
            managed_network: None,
            network_proxy: None,
        })
        .await
        .unwrap();
    let connection = Connection::from_exec_process(Arc::clone(&started.process))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(connection.is_alive());
    drop(connection);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if started
                .process
                .read(None, Some(1024), Some(100))
                .await
                .unwrap()
                .quiesced
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("dropping connection must stop and confirm the process group");
}
