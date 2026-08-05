use std::{
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use ssh2::{CheckResult, HashType, HostKeyType, KnownHostFileKind, MethodType, Session};

use super::{DbError, SshTunnelConfig};

pub struct SshTunnel {
    local_port: u16,
    stopped: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
}

impl SshTunnel {
    pub async fn start(
        config: &SshTunnelConfig,
        destination_host: &str,
        destination_port: u16,
    ) -> Result<Self, DbError> {
        let timeout = Duration::from_secs(config.connect_timeout_secs.unwrap_or(15).clamp(1, 300));
        let config = config.clone();
        let destination_host = destination_host.to_owned();
        let task = tokio::task::spawn_blocking(move || {
            Self::start_blocking(config, destination_host, destination_port)
        });
        tokio::time::timeout(timeout + Duration::from_secs(2), task)
            .await
            .map_err(|_| {
                DbError::Connection(format!(
                    "SSH tunnel setup timed out after {}s",
                    timeout.as_secs()
                ))
            })?
            .map_err(|error| DbError::Connection(format!("SSH tunnel task failed: {error}")))?
    }

    fn start_blocking(
        config: SshTunnelConfig,
        destination_host: String,
        destination_port: u16,
    ) -> Result<Self, DbError> {
        validate_ssh_config(&config)?;
        // Validate the complete route up front. Previously the listener was
        // returned immediately and authentication/forwarding failures inside
        // worker threads were silently discarded.
        test_forwarding(&config, &destination_host, destination_port)?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| DbError::Connection(format!("cannot bind SSH tunnel: {error}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|error| DbError::Connection(error.to_string()))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| DbError::Connection(error.to_string()))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let accept_thread = thread::Builder::new()
            .name(format!("ssh-tunnel-{local_port}"))
            .spawn(move || {
                while !worker_stopped.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((local, _)) => {
                            let config = config.clone();
                            let host = destination_host.clone();
                            thread::spawn(move || {
                                let _ = forward_connection(local, &config, &host, destination_port);
                            });
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| DbError::Connection(format!("cannot start SSH tunnel: {error}")))?;
        Ok(Self {
            local_port,
            stopped,
            accept_thread: Some(accept_thread),
        })
    }

    pub fn local_host(&self) -> &'static str {
        "127.0.0.1"
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.local_port));
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
    }
}

fn validate_ssh_config(config: &SshTunnelConfig) -> Result<(), DbError> {
    if config.host.trim().is_empty() || config.username.trim().is_empty() {
        return Err(DbError::InvalidConfiguration(
            "SSH host and username are required".into(),
        ));
    }
    if config.private_key_path.is_none() && config.password.is_none() {
        // Agent authentication is allowed when no explicit credential is supplied.
        return Ok(());
    }
    if let Some(path) = &config.private_key_path {
        if !expanded_path(path).is_file() {
            return Err(DbError::InvalidConfiguration(format!(
                "SSH private key does not exist: {path}"
            )));
        }
    }
    Ok(())
}

fn forward_connection(
    mut local: TcpStream,
    config: &SshTunnelConfig,
    destination_host: &str,
    destination_port: u16,
) -> Result<(), DbError> {
    let (session, mut channel) = open_forwarding(config, destination_host, destination_port)?;
    session.set_blocking(false);
    local
        .set_nonblocking(true)
        .map_err(|error| DbError::Connection(error.to_string()))?;
    relay(&mut local, &mut channel)?;
    let _ = channel.close();
    let _ = local.shutdown(Shutdown::Both);
    Ok(())
}

fn test_forwarding(
    config: &SshTunnelConfig,
    destination_host: &str,
    destination_port: u16,
) -> Result<(), DbError> {
    // Successfully opening the direct-tcpip channel proves the route. Waiting
    // for a remote close acknowledgement can block on Redis endpoints, which
    // are designed to keep connections open until the client disconnects.
    let (_session, _channel) = open_forwarding(config, destination_host, destination_port)?;
    Ok(())
}

fn open_forwarding(
    config: &SshTunnelConfig,
    destination_host: &str,
    destination_port: u16,
) -> Result<(Session, ssh2::Channel), DbError> {
    let timeout = Duration::from_secs(config.connect_timeout_secs.unwrap_or(15).clamp(1, 300));
    let addresses = (config.host.as_str(), config.port)
        .to_socket_addrs()
        .map_err(|error| {
            DbError::Connection(format!(
                "SSH jump host DNS lookup failed for {}:{}: {error}",
                config.host, config.port
            ))
        })?;
    let mut last_error = None;
    let mut jump = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => {
                jump = Some(stream);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let jump = jump.ok_or_else(|| {
        DbError::Connection(format!(
            "SSH jump host connection to {}:{} timed out or failed after {}s: {}",
            config.host,
            config.port,
            timeout.as_secs(),
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no address resolved".into())
        ))
    })?;
    jump.set_read_timeout(Some(timeout)).ok();
    jump.set_write_timeout(Some(timeout)).ok();
    let mut session = Session::new()
        .map_err(|error| DbError::Connection(format!("SSH session failed: {error}")))?;
    prefer_known_host_key(&session, &config.host, config.port)?;
    session.set_tcp_stream(jump);
    session.handshake().map_err(|error| {
        DbError::Connection(format!(
            "SSH handshake failed after {}s: {error}",
            timeout.as_secs()
        ))
    })?;
    verify_host_key(
        &session,
        &config.host,
        config.port,
        config.accept_new_host_key.unwrap_or(false),
        config.expected_host_key_fingerprint.as_deref(),
    )?;
    authenticate(&session, config)?;
    let channel = session
        .channel_direct_tcpip(destination_host, destination_port, None)
        .map_err(|error| DbError::Connection(format!(
            "SSH forwarding to {destination_host}:{destination_port} was denied or unreachable: {error}"
        )))?;
    Ok((session, channel))
}

/// OpenSSH prefers algorithms for keys already recorded in known_hosts. libssh2
/// otherwise may negotiate (for example) ECDSA while only the server's valid
/// ED25519 key is recorded, which its check API reports as a key mismatch.
fn prefer_known_host_key(session: &Session, host: &str, port: u16) -> Result<(), DbError> {
    let path = known_hosts_path()?;
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| DbError::Connection(format!("cannot read known_hosts: {error}")))?;
    let plain_host = host;
    let port_host = format!("[{host}]:{port}");
    let mut algorithms = Vec::new();
    for line in contents.lines() {
        let mut parts = line.split_whitespace();
        let Some(hosts) = parts.next() else { continue };
        let Some(algorithm) = parts.next() else {
            continue;
        };
        if hosts.starts_with('|') {
            continue;
        }
        let matches_host = hosts
            .split(',')
            .any(|candidate| candidate == port_host || (port == 22 && candidate == plain_host));
        if matches_host
            && is_supported_host_key_algorithm(algorithm)
            && !algorithms.iter().any(|existing| *existing == algorithm)
        {
            algorithms.push(algorithm);
        }
    }
    if !algorithms.is_empty() {
        session
            .method_pref(MethodType::HostKey, &algorithms.join(","))
            .map_err(|error| {
                DbError::Connection(format!(
                    "could not prefer the SSH key recorded in {}: {error}",
                    path.display()
                ))
            })?;
    }
    Ok(())
}

fn is_supported_host_key_algorithm(algorithm: &str) -> bool {
    matches!(
        algorithm,
        "ssh-ed25519"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
            | "ssh-rsa"
    )
}

fn verify_host_key(
    session: &Session,
    host: &str,
    port: u16,
    accept_new: bool,
    expected_fingerprint: Option<&str>,
) -> Result<(), DbError> {
    let known_hosts_path = known_hosts_path()?;
    if !known_hosts_path.is_file() {
        return Err(DbError::Connection(format!(
            "SSH known_hosts file not found: {}",
            known_hosts_path.display()
        )));
    }
    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| DbError::Connection(error.to_string()))?;
    known_hosts
        .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
        .map_err(|error| DbError::Connection(format!("cannot read known_hosts: {error}")))?;
    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| DbError::Connection("SSH server did not provide a host key".into()))?;
    match known_hosts.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound if accept_new => {
            let actual_fingerprint = ssh_host_fingerprint(session);
            if expected_fingerprint != Some(actual_fingerprint.as_str()) {
                return Err(DbError::Connection(format!(
                    "SSH host key changed before it could be trusted; expected {}, received {}",
                    expected_fingerprint.unwrap_or("no approved fingerprint"),
                    actual_fingerprint,
                )));
            }
            let known_host_name = if port == 22 {
                host.to_owned()
            } else {
                format!("[{host}]:{port}")
            };
            known_hosts
                .add(
                    &known_host_name,
                    key,
                    "Added by Database4every1 after user confirmation",
                    key_type.into(),
                )
                .map_err(|error| {
                    DbError::Connection(format!("cannot add SSH host key: {error}"))
                })?;
            known_hosts
                .write_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
                .map_err(|error| {
                    DbError::Connection(format!("cannot update known_hosts: {error}"))
                })?;
            Ok(())
        }
        CheckResult::NotFound => Err(DbError::UnknownSshHostKey {
            host: host.to_owned(),
            port,
            algorithm: host_key_algorithm(key_type).into(),
            fingerprint: ssh_host_fingerprint(session),
        }),
        CheckResult::Mismatch => Err(DbError::Connection(format!(
            "SSH host key mismatch for {host}:{port}"
        ))),
        CheckResult::Failure => Err(DbError::Connection(
            "SSH host-key verification failed".into(),
        )),
    }
}

fn ssh_host_fingerprint(session: &Session) -> String {
    session
        .host_key_hash(HashType::Sha256)
        .map(|hash| format!("SHA256:{}", STANDARD_NO_PAD.encode(hash)))
        .unwrap_or_else(|| "SHA256:unavailable".into())
}

fn host_key_algorithm(key_type: HostKeyType) -> &'static str {
    match key_type {
        HostKeyType::Rsa => "RSA",
        HostKeyType::Dss => "DSA",
        HostKeyType::Ecdsa256 => "ECDSA-256",
        HostKeyType::Ecdsa384 => "ECDSA-384",
        HostKeyType::Ecdsa521 => "ECDSA-521",
        HostKeyType::Ed25519 => "ED25519",
        HostKeyType::Unknown => "UNKNOWN",
    }
}

fn known_hosts_path() -> Result<PathBuf, DbError> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| DbError::Connection("cannot locate SSH known_hosts".into()))
}

fn authenticate(session: &Session, config: &SshTunnelConfig) -> Result<(), DbError> {
    if let Some(private_key) = &config.private_key_path {
        let private_key = expanded_path(private_key);
        session
            .userauth_pubkey_file(
                &config.username,
                None,
                &private_key,
                config.private_key_passphrase.as_deref(),
            )
            .map_err(|error| {
                DbError::Connection(format!("SSH key authentication failed: {error}"))
            })?;
    } else if let Some(password) = &config.password {
        session
            .userauth_password(&config.username, password)
            .map_err(|error| {
                DbError::Connection(format!("SSH password authentication failed: {error}"))
            })?;
    } else {
        session.userauth_agent(&config.username).map_err(|error| {
            DbError::Connection(format!("SSH agent authentication failed: {error}"))
        })?;
    }
    if !session.authenticated() {
        return Err(DbError::Connection(
            "SSH authentication was rejected".into(),
        ));
    }
    Ok(())
}

fn expanded_path(path: &str) -> PathBuf {
    if let Some(relative) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(relative);
        }
    }
    Path::new(path).to_path_buf()
}

fn relay(local: &mut TcpStream, channel: &mut ssh2::Channel) -> Result<(), DbError> {
    let mut local_to_ssh = Vec::new();
    let mut ssh_to_local = Vec::new();
    let mut local_eof = false;
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let mut progressed = false;
        if !local_eof && local_to_ssh.is_empty() {
            match local.read(&mut buffer) {
                Ok(0) => {
                    local_eof = true;
                    let _ = channel.send_eof();
                }
                Ok(count) => {
                    local_to_ssh.extend_from_slice(&buffer[..count]);
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(DbError::Connection(error.to_string())),
            }
        }
        if !local_to_ssh.is_empty() {
            match channel.write(&local_to_ssh) {
                Ok(count) => {
                    local_to_ssh.drain(..count);
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(DbError::Connection(error.to_string())),
            }
        }
        if ssh_to_local.is_empty() && !channel.eof() {
            match channel.read(&mut buffer) {
                Ok(0) => {}
                Ok(count) => {
                    ssh_to_local.extend_from_slice(&buffer[..count]);
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(DbError::Connection(error.to_string())),
            }
        }
        if !ssh_to_local.is_empty() {
            match local.write(&ssh_to_local) {
                Ok(count) => {
                    ssh_to_local.drain(..count);
                    progressed = true;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(DbError::Connection(error.to_string())),
            }
        }
        if local_eof && channel.eof() && local_to_ssh.is_empty() && ssh_to_local.is_empty() {
            return Ok(());
        }
        if !progressed {
            thread::sleep(Duration::from_millis(2));
        }
    }
}
