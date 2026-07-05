use russh::client;
use russh::ChannelMsg;
use std::sync::Arc;
use std::time::Duration;

use crate::commands::settings::load_runtime_ssh_host;

use super::*;

pub(crate) async fn open_ssh_shell_channel(
    handle: &client::Handle<LiveAgentSshClient>,
    size: TerminalSize,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH channel open failed: {error}"))?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            u32::from(size.cols),
            u32::from(size.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("SSH PTY request failed: {error}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|error| format!("SSH shell request failed: {error}"))?;
    Ok(channel)
}

pub(crate) async fn open_sftp_connection_for_host(
    ssh_host_id: &str,
) -> Result<TerminalSftpConnection, String> {
    let host_config = load_runtime_ssh_host(ssh_host_id)?
        .ok_or_else(|| format!("SSH host not found: {}", ssh_host_id.trim()))?;
    if host_config.host.trim().is_empty() {
        return Err("SSH host is required".to_string());
    }
    if host_config.username.trim().is_empty() {
        return Err("SSH username is required".to_string());
    }

    let auth = resolve_ssh_auth_material(&host_config)?;
    let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
    let mut handle = match connect_ssh_handle(&host_config, Arc::clone(&captured_host_key)).await {
        Ok(handle) => handle,
        Err(error) => {
            if captured_host_key.lock().await.is_some() {
                return Err("SSH host key requires confirmation before opening SFTP".to_string());
            }
            return Err(error);
        }
    };

    match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
        SshAuthOutcome::Authenticated => {}
        SshAuthOutcome::KeyboardInteractivePrompt(_) => {
            let _ = handle
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "Keyboard-interactive SFTP authentication requires Bash prompt first",
                    "en",
                )
                .await;
            return Err(
                "SSH keyboard-interactive authentication requires opening Bash first".to_string(),
            );
        }
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SFTP channel open failed: {error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("SFTP subsystem request failed: {error}"))?;
    let session = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("SFTP session failed: {error}"))?;
    Ok(TerminalSftpConnection {
        _handle: handle,
        session,
    })
}

pub(crate) async fn run_ssh_exec_channel(
    runtime: &Arc<SshSessionRuntime>,
    command: String,
    max_bytes: usize,
) -> Result<TerminalSshExecResponse, String> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut exit_code = None;
    let mut exit_signal = None;

    let channel = {
        let handle = runtime.handle.lock().await;
        let Some(handle) = handle.as_ref() else {
            return Err("SSH connection is not connected".to_string());
        };
        handle
            .channel_open_session()
            .await
            .map_err(|error| format!("SSH exec channel open failed: {error}"))?
    };
    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|error| format!("SSH exec request failed: {error}"))?;
    let (mut read_half, _write_half) = channel.split();

    loop {
        match read_half.wait().await {
            Some(ChannelMsg::Data { data }) => {
                append_limited(&mut stdout, data.as_ref(), max_bytes, &mut stdout_truncated);
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                append_limited(&mut stderr, data.as_ref(), max_bytes, &mut stderr_truncated);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(exit_status);
            }
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                exit_signal = Some(format!("{signal_name:?}"));
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }

    Ok(TerminalSshExecResponse {
        session_id: String::new(),
        command: String::new(),
        cwd: None,
        exit_code,
        exit_signal,
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        stdout_truncated,
        stderr_truncated,
        timed_out: false,
        duration_ms: 0,
    })
}

pub(crate) fn normalize_ssh_exec_timeout(timeout_ms: Option<u64>) -> Duration {
    let requested = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(SSH_EXEC_DEFAULT_TIMEOUT);
    requested.clamp(Duration::from_secs(1), SSH_EXEC_MAX_TIMEOUT)
}

pub(crate) fn normalize_ssh_exec_max_bytes(max_bytes: Option<usize>) -> usize {
    max_bytes
        .filter(|value| *value > 0)
        .unwrap_or(SSH_EXEC_DEFAULT_MAX_BYTES)
        .clamp(4 * 1024, SSH_EXEC_MAX_BYTES)
}

pub(crate) fn append_limited(
    buffer: &mut Vec<u8>,
    data: &[u8],
    max_bytes: usize,
    truncated: &mut bool,
) {
    if buffer.len() >= max_bytes {
        if !data.is_empty() {
            *truncated = true;
        }
        return;
    }
    let remaining = max_bytes - buffer.len();
    if data.len() > remaining {
        buffer.extend_from_slice(&data[..remaining]);
        *truncated = true;
    } else {
        buffer.extend_from_slice(data);
    }
}

pub(crate) fn wrap_ssh_exec_command(command: &str, cwd: Option<&str>) -> String {
    match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(cwd) => format!("cd {} && {}", shell_single_quote(cwd), command),
        None => command.to_string(),
    }
}

pub(crate) fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
