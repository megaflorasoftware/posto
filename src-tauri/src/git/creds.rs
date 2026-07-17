use git2::{Cred, CredentialType, RemoteCallbacks};
use std::path::PathBuf;

/// Platform seam for network authentication. Shared git code never branches
/// on the platform; it takes whatever `platform_creds()` hands it.
/// `attempt` counts prior tries within one operation, letting a provider
/// walk through multiple candidates (agent, then key files, …).
pub trait CredentialProvider {
    fn credential(
        &self,
        config: &git2::Config,
        url: &str,
        username_from_url: Option<&str>,
        allowed: CredentialType,
        attempt: usize,
    ) -> Result<Cred, git2::Error>;
}

/// Desktop: defer to the user's own git setup — the configured credential
/// helpers (osxkeychain, manager, gh, …) for HTTPS; for ssh remotes the
/// ssh-agent first, then the default key files OpenSSH would try (the agent
/// is often empty on macOS, where CLI git loads ~/.ssh keys directly).
pub struct DesktopCreds;

/// Default OpenSSH identity files, in OpenSSH's own preference order.
fn default_ssh_keys() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .filter(|p| p.exists())
        .collect()
}

impl CredentialProvider for DesktopCreds {
    fn credential(
        &self,
        config: &git2::Config,
        url: &str,
        username_from_url: Option<&str>,
        allowed: CredentialType,
        attempt: usize,
    ) -> Result<Cred, git2::Error> {
        if allowed.contains(CredentialType::SSH_KEY) {
            let username = username_from_url.unwrap_or("git");
            if attempt == 0 {
                return Cred::ssh_key_from_agent(username);
            }
            let keys = default_ssh_keys();
            if let Some(key) = keys.get(attempt - 1) {
                let public = key.with_extension("pub");
                return Cred::ssh_key(username, public.exists().then_some(&public), key, None);
            }
            return Err(git2::Error::from_str(
                "ssh authentication failed — add your key to the ssh-agent, or switch the remote to HTTPS",
            ));
        }
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            let mut helper = git2::CredentialHelper::new(url);
            helper.config(config);
            if let Some(username) = username_from_url {
                helper.username(Some(username));
            }
            if let Some((username, password)) = helper.execute() {
                return Cred::userpass_plaintext(&username, &password);
            }
            return Err(git2::Error::from_str(
                "no stored credentials for this remote — sign in with your git credential helper",
            ));
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str("no supported authentication method"))
    }
}

/// Mobile: replaced by the stored OAuth token in Phase 3. Until then any
/// network operation fails with a clear message.
#[cfg(mobile)]
pub struct MobileCreds;

#[cfg(mobile)]
impl CredentialProvider for MobileCreds {
    fn credential(
        &self,
        _config: &git2::Config,
        _url: &str,
        _username_from_url: Option<&str>,
        _allowed: CredentialType,
        _attempt: usize,
    ) -> Result<Cred, git2::Error> {
        Err(git2::Error::from_str("not signed in"))
    }
}

#[cfg(desktop)]
pub fn platform_creds() -> impl CredentialProvider {
    DesktopCreds
}

#[cfg(mobile)]
pub fn platform_creds() -> impl CredentialProvider {
    MobileCreds
}

/// How many candidate credentials one operation may offer before giving up.
/// The cap matters: libgit2 re-asks the callback after every rejected
/// credential, and a provider that keeps returning the same bad answer
/// would loop forever.
const MAX_ATTEMPTS: usize = 6;

/// Remote callbacks wired to a credential provider.
pub fn remote_callbacks<'a>(
    config: git2::Config,
    provider: impl CredentialProvider + 'a,
) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    let mut attempts = 0;
    callbacks.credentials(move |url, username_from_url, allowed| {
        if attempts >= MAX_ATTEMPTS {
            return Err(git2::Error::from_str(
                "authentication failed — check your git credentials for this remote",
            ));
        }
        attempts += 1;
        provider.credential(&config, url, username_from_url, allowed, attempts - 1)
    });
    callbacks
}
