use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use codex_code_mode_protocol::CodeModeSessionProvider;
use codex_code_mode_protocol::ExecuteRequest;
use codex_code_mode_protocol::FunctionCallOutputContentItem;
use codex_code_mode_protocol::RuntimeResponse;
use codex_code_mode_protocol::host::CapabilitySet;
use codex_code_mode_protocol::host::ClientToHost;
use codex_code_mode_protocol::host::HostHello;
use codex_code_mode_protocol::host::HostRequest;
use codex_code_mode_protocol::host::HostResponse;
use codex_code_mode_protocol::host::HostToClient;
use codex_code_mode_protocol::host::ProtocolVersion;
use codex_code_mode_protocol::host::WireResult;
use codex_exec_server::ExecBackend;
use codex_exec_server::ExecBackendFuture;
use codex_exec_server::ExecOutputStream;
use codex_exec_server::ExecParams;
use codex_exec_server::ExecProcess;
use codex_exec_server::ExecProcessEvent;
use codex_exec_server::ExecProcessEventReceiver;
use codex_exec_server::ExecProcessFuture;
use codex_exec_server::ExecServerError;
use codex_exec_server::ProcessId;
use codex_exec_server::ProcessOutputChunk;
use codex_exec_server::ProcessSignal;
use codex_exec_server::ReadResponse;
use codex_exec_server::StartedExecProcess;
use codex_exec_server::WriteResponse;
use codex_exec_server::WriteStatus;
use codex_protocol::ThreadId;
use pretty_assertions::assert_eq;
use tokio::sync::broadcast;
use tokio::sync::watch;

use super::HostedCodeModeRuntimeIdentity;
use super::HostedEnvironmentCodeModeSessionProvider;
use super::ProcessOwnedCodeModeSession;
use super::ProcessOwnedCodeModeSessionProvider;
use super::resolve_host_program;
use crate::NoopCodeModeSessionDelegate;

#[test]
fn provider_reuses_its_live_process_host() {
    let provider = ProcessOwnedCodeModeSessionProvider::default();

    let first = provider.process_host().expect("owned process host");
    let second = provider.process_host().expect("owned process host");

    assert!(Arc::ptr_eq(&first, &second));
}

#[test]
fn host_program_override_takes_precedence() {
    assert_eq!(
        resolve_host_program(
            Some("custom-code-mode-host".into()),
            Ok(PathBuf::from("/opt/codex/bin/codex")),
        ),
        PathBuf::from("custom-code-mode-host")
    );
}

#[test]
fn host_program_is_next_to_the_main_executable_even_when_missing() {
    let executable_name = if cfg!(windows) {
        "codex-code-mode-host.exe"
    } else {
        "codex-code-mode-host"
    };

    assert_eq!(
        resolve_host_program(
            /*override_path*/ None,
            Ok(PathBuf::from("/opt/codex/bin/codex")),
        ),
        PathBuf::from("/opt/codex/bin").join(executable_name)
    );
}

#[test]
fn host_program_falls_back_to_its_name_when_main_executable_is_unknown() {
    let executable_name = if cfg!(windows) {
        "codex-code-mode-host.exe"
    } else {
        "codex-code-mode-host"
    };

    assert_eq!(
        resolve_host_program(
            /*override_path*/ None,
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "missing executable"
            )),
        ),
        PathBuf::from(executable_name)
    );
}

#[tokio::test]
async fn provider_falls_back_to_in_process_session_when_host_is_missing() {
    let provider = ProcessOwnedCodeModeSessionProvider::with_host_program(
        "codex-code-mode-host-does-not-exist".into(),
    );

    let session = provider
        .create_session(Arc::new(NoopCodeModeSessionDelegate))
        .await
        .expect("missing host should fall back to an in-process session");
    let response = session
        .execute(ExecuteRequest {
            tool_call_id: "call-1".to_string(),
            enabled_tools: Vec::new(),
            source: "text('fallback')".to_string(),
            yield_time_ms: None,
            max_output_tokens: None,
        })
        .await
        .expect("execute fallback session")
        .initial_response()
        .await
        .expect("read fallback response");

    assert_eq!(
        response,
        RuntimeResponse::Result {
            cell_id: codex_code_mode_protocol::CellId::new("1".to_string()),
            content_items: vec![FunctionCallOutputContentItem::InputText {
                text: "fallback".to_string(),
            }],
            error_text: None,
        }
    );
}

#[tokio::test]
async fn shutdown_before_open_does_not_spawn_the_host() {
    let session = ProcessOwnedCodeModeSession::new();

    session.shutdown().await.expect("shutdown session");
    let error = session
        .execute(codex_code_mode_protocol::ExecuteRequest {
            tool_call_id: "call-1".to_string(),
            enabled_tools: Vec::new(),
            source: "text('unreachable')".to_string(),
            yield_time_ms: None,
            max_output_tokens: None,
        })
        .await
        .err()
        .expect("shutdown session should reject execution");

    assert_eq!(error, "code mode session is shutting down");
}

#[derive(Clone, Copy)]
enum FakeHostBehavior {
    Healthy,
    StderrHandshake,
    MalformedHandshake,
}

struct FakeExecBackend {
    starts: AtomicUsize,
    params: Mutex<Vec<ExecParams>>,
    process: Arc<FakeExecProcess>,
    fail_start: bool,
}

impl FakeExecBackend {
    fn new(behavior: FakeHostBehavior) -> Self {
        Self {
            starts: AtomicUsize::new(0),
            params: Mutex::new(Vec::new()),
            process: Arc::new(FakeExecProcess::new(behavior)),
            fail_start: false,
        }
    }

    fn failing() -> Self {
        Self {
            fail_start: true,
            ..Self::new(FakeHostBehavior::Healthy)
        }
    }
}

impl ExecBackend for FakeExecBackend {
    fn start(&self, params: ExecParams) -> ExecBackendFuture<'_> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.params.lock().expect("params lock").push(params);
        Box::pin(async move {
            if self.fail_start {
                Err(ExecServerError::Protocol("fake start failure".to_string()))
            } else {
                Ok(StartedExecProcess {
                    process: self.process.clone(),
                })
            }
        })
    }
}

struct FakeExecProcess {
    process_id: ProcessId,
    events: broadcast::Sender<ExecProcessEvent>,
    wake_tx: watch::Sender<u64>,
    input: Mutex<Vec<u8>>,
    behavior: FakeHostBehavior,
    sequence: AtomicUsize,
    signal_count: AtomicUsize,
    terminate_count: AtomicUsize,
    quiesced: AtomicBool,
}

impl FakeExecProcess {
    fn new(behavior: FakeHostBehavior) -> Self {
        let (events, _) = ExecProcessEventReceiver::channel(32);
        let (wake_tx, _) = watch::channel(0);
        Self {
            process_id: ProcessId::new("fake"),
            events,
            wake_tx,
            input: Mutex::new(Vec::new()),
            behavior,
            sequence: AtomicUsize::new(1),
            signal_count: AtomicUsize::new(0),
            terminate_count: AtomicUsize::new(0),
            quiesced: AtomicBool::new(false),
        }
    }

    fn publish(&self, stream: ExecOutputStream, bytes: Vec<u8>) {
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst) as u64;
        let _ = self
            .events
            .send(ExecProcessEvent::Output(ProcessOutputChunk {
                seq,
                stream,
                chunk: bytes.into(),
            }));
    }

    fn frame(message: &HostToClient) -> Vec<u8> {
        let payload = serde_json::to_vec(message).expect("encode fake host frame");
        let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
        frame.extend(payload);
        frame
    }

    fn consume_frames(&self, chunk: Vec<u8>) {
        let mut input = self.input.lock().expect("input lock");
        input.extend(chunk);
        loop {
            if input.len() < 4 {
                return;
            }
            let length = u32::from_le_bytes(input[..4].try_into().expect("frame prefix")) as usize;
            if input.len() < length + 4 {
                return;
            }
            let payload = input[4..length + 4].to_vec();
            input.drain(..length + 4);
            drop(input);
            self.respond(serde_json::from_slice(&payload).expect("decode client frame"));
            input = self.input.lock().expect("input lock");
        }
    }

    fn respond(&self, message: ClientToHost) {
        let response = match message {
            ClientToHost::ClientHello(_) => {
                HostToClient::HostHello(HostHello::new(ProtocolVersion::V1, CapabilitySet::empty()))
            }
            ClientToHost::Request {
                id,
                request: HostRequest::OpenSession { session_id },
            } => HostToClient::Response {
                id,
                result: WireResult::Ok {
                    value: HostResponse::SessionReady { session_id },
                },
            },
            ClientToHost::Request {
                id,
                request: HostRequest::ShutdownSession { session_id },
            } => HostToClient::Response {
                id,
                result: WireResult::Ok {
                    value: HostResponse::SessionClosed { session_id },
                },
            },
            other => panic!("unexpected fake host request: {other:?}"),
        };
        let frame = if matches!(self.behavior, FakeHostBehavior::MalformedHandshake)
            && matches!(response, HostToClient::HostHello(_))
        {
            let payload = b"not-json";
            let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
            frame.extend(payload);
            frame
        } else {
            Self::frame(&response)
        };
        let stream = if matches!(self.behavior, FakeHostBehavior::StderrHandshake)
            && matches!(response, HostToClient::HostHello(_))
        {
            ExecOutputStream::Stderr
        } else {
            ExecOutputStream::Stdout
        };
        // Split the handshake to exercise framing across output events.
        if matches!(response, HostToClient::HostHello(_)) && frame.len() > 5 {
            self.publish(stream, frame[..3].to_vec());
            self.publish(stream, frame[3..].to_vec());
        } else {
            self.publish(stream, frame);
        }
    }
}

impl ExecProcess for FakeExecProcess {
    fn process_id(&self) -> &ProcessId {
        &self.process_id
    }

    fn subscribe_wake(&self) -> watch::Receiver<u64> {
        self.wake_tx.subscribe()
    }

    fn subscribe_events(&self) -> ExecProcessEventReceiver {
        ExecProcessEventReceiver::subscribe(&self.events)
    }

    fn read(
        &self,
        _after_seq: Option<u64>,
        _max_bytes: Option<usize>,
        _wait_ms: Option<u64>,
    ) -> ExecProcessFuture<'_, ReadResponse> {
        Box::pin(async move {
            Ok(ReadResponse {
                chunks: Vec::new(),
                next_seq: self.sequence.load(Ordering::SeqCst) as u64,
                exited: self.quiesced.load(Ordering::SeqCst),
                exit_code: self.quiesced.load(Ordering::SeqCst).then_some(0),
                closed: self.quiesced.load(Ordering::SeqCst),
                quiesced: self.quiesced.load(Ordering::SeqCst),
                failure: None,
                sandbox_denied: false,
            })
        })
    }

    fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse> {
        Box::pin(async move {
            self.consume_frames(chunk);
            Ok(WriteResponse {
                status: WriteStatus::Accepted,
            })
        })
    }

    fn signal(&self, signal: ProcessSignal) -> ExecProcessFuture<'_, ()> {
        assert_eq!(signal, ProcessSignal::Interrupt);
        self.signal_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn terminate(&self) -> ExecProcessFuture<'_, ()> {
        self.terminate_count.fetch_add(1, Ordering::SeqCst);
        self.quiesced.store(true, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

fn hosted_identity() -> HostedCodeModeRuntimeIdentity {
    HostedCodeModeRuntimeIdentity {
        thread_id: ThreadId::new(),
        lease_id: "lease-a".to_string(),
        environment_id: "environment-a".to_string(),
        connection_generation: 7,
    }
}

#[tokio::test]
async fn hosted_provider_uses_exact_minimal_exec_params_and_one_process() {
    let backend = Arc::new(FakeExecBackend::new(FakeHostBehavior::Healthy));
    let identity = hosted_identity();
    let provider = HostedEnvironmentCodeModeSessionProvider::start(
        identity.clone(),
        backend.clone(),
        "file:///workspace/project".parse().expect("cwd URI"),
    )
    .await
    .expect("start hosted provider");

    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    let params = backend.params.lock().expect("params lock");
    let params = params.first().expect("start params");
    assert_eq!(
        params.argv,
        vec![
            "/usr/local/bin/codex-code-mode-host",
            "--hosted-singleton",
            "--identity",
            "fe5c10c7509005399b9f18df7d5521e2",
        ]
    );
    assert_eq!(
        params.process_id.as_str(),
        "hosted-code-mode-fe5c10c7509005399b9f18df7d5521e2"
    );
    assert_eq!(params.cwd.to_string(), "file:///workspace/project");
    assert!(!params.tty);
    assert!(params.pipe_stdin);
    assert!(params.sandbox.is_none());
    assert!(!params.enforce_managed_network);
    assert_eq!(params.env.len(), 4);
    assert_eq!(params.env["CODEX_HOSTED_CODE_MODE"], "1");
    assert_eq!(params.env["CODEX_HOSTED_LEASE_ID"], identity.lease_id);
    assert_eq!(
        params.env["CODEX_HOSTED_ENVIRONMENT_ID"],
        identity.environment_id
    );
    assert_eq!(params.env["CODEX_HOSTED_CONNECTION_GENERATION"], "7");
    let policy = params.env_policy.as_ref().expect("minimal env policy");
    assert!(policy.r#set.is_empty() && policy.include_only.is_empty() && policy.exclude.is_empty());
    let _session = provider
        .create_session(Arc::new(NoopCodeModeSessionDelegate))
        .await
        .expect("create one logical session");
    let error = provider
        .create_session(Arc::new(NoopCodeModeSessionDelegate))
        .await
        .err()
        .expect("second session rejected");
    assert_eq!(
        error,
        "hosted code-mode provider permits one logical agent session"
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn hosted_provider_fails_closed_on_start_or_handshake_failure() {
    let start_backend = Arc::new(FakeExecBackend::failing());
    let error = HostedEnvironmentCodeModeSessionProvider::start(
        hosted_identity(),
        start_backend,
        "file:///workspace".parse().expect("cwd URI"),
    )
    .await
    .err()
    .expect("start failure");
    assert!(error.contains("fake start failure"));

    let handshake_backend = Arc::new(FakeExecBackend::new(FakeHostBehavior::MalformedHandshake));
    let error = HostedEnvironmentCodeModeSessionProvider::start(
        hosted_identity(),
        handshake_backend.clone(),
        "file:///workspace".parse().expect("cwd URI"),
    )
    .await
    .err()
    .expect("handshake failure");
    assert!(error.contains("failed to read code-mode host hello"));
    assert_eq!(
        handshake_backend
            .process
            .signal_count
            .load(Ordering::SeqCst),
        1
    );
    assert_eq!(
        handshake_backend
            .process
            .terminate_count
            .load(Ordering::SeqCst),
        1
    );
    assert!(handshake_backend.process.quiesced.load(Ordering::SeqCst));
}

#[tokio::test]
async fn stderr_cannot_complete_the_hosted_handshake() {
    tokio::time::pause();
    let backend = Arc::new(FakeExecBackend::new(FakeHostBehavior::StderrHandshake));
    let start = HostedEnvironmentCodeModeSessionProvider::start(
        hosted_identity(),
        backend.clone(),
        "file:///workspace".parse().expect("cwd URI"),
    );
    tokio::pin!(start);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(1), &mut start)
            .await
            .is_err()
    );
    tokio::time::advance(std::time::Duration::from_secs(11)).await;
    let error = start.await.err().expect("stderr-only handshake times out");
    assert!(error.contains("timed out negotiating"));
    assert_eq!(backend.process.terminate_count.load(Ordering::SeqCst), 1);
    assert!(backend.process.quiesced.load(Ordering::SeqCst));
}
