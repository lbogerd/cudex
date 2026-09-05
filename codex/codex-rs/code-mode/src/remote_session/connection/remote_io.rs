//! Adapts the existing exec process stream to the upstream framed stdio driver.
//! Retained-stream loss is terminal: restarting a host must never pretend its JS
//! heap survived. Transient exec transport recovery retains the same process.

use std::sync::Arc;

use codex_exec_server::ExecOutputStream;
use codex_exec_server::ExecProcess;
use codex_exec_server::ExecProcessEvent;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;

use super::Connection;
use super::ConnectionError;
use super::FramedReader;
use super::FramedWriter;
use super::HostProcess;

impl Connection {
    pub(in super::super) async fn from_exec_process(
        process: Arc<dyn ExecProcess>,
    ) -> Result<Self, ConnectionError> {
        let (reader, mut output) = tokio::io::duplex(64 * 1024);
        let (writer, mut input) = tokio::io::duplex(64 * 1024);
        let mut events = process.subscribe_events();
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                match event {
                    ExecProcessEvent::Output(chunk) => {
                        if chunk.stream == ExecOutputStream::Stdout
                            && output.write_all(&chunk.chunk.0).await.is_err()
                        {
                            break;
                        }
                    }
                    ExecProcessEvent::Exited { .. } => {}
                    ExecProcessEvent::Closed { .. } | ExecProcessEvent::Failed(_) => break,
                }
            }
        });
        let writer_process = Arc::clone(&process);
        tokio::spawn(async move {
            let mut buffer = vec![0; 64 * 1024];
            loop {
                match input.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if !matches!(writer_process.write(buffer[..count].to_vec()).await, Ok(response) if response.status == codex_exec_server::WriteStatus::Accepted)
                        {
                            // Closing stdin also makes the framed writer fail; explicitly
                            // stop the host so a silent lost write cannot hang a session.
                            let _ = writer_process.terminate().await;
                            break;
                        }
                    }
                }
            }
        });
        Self::establish(
            FramedReader::new(Box::new(reader) as Box<dyn AsyncRead + Unpin + Send>),
            FramedWriter::new(Box::new(writer) as Box<dyn AsyncWrite + Unpin + Send>),
            HostProcess::Remote(process),
        )
        .await
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "remote_io_tests.rs"]
mod tests;
