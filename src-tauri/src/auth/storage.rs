use super::StoredSession;

#[cfg(target_os = "ios")]
mod platform {
    use keyring_core::CredentialStore;
    use std::sync::Arc;

    pub fn create_store() -> Result<Arc<CredentialStore>, String> {
        apple_native_keyring_store::protected::Store::new()
            .map(|store| store as Arc<CredentialStore>)
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "android")]
mod platform {
    use keyring_core::CredentialStore;
    use std::sync::Arc;

    pub fn create_store() -> Result<Arc<CredentialStore>, String> {
        android_native_keyring_store::Store::new()
            .map(|store| store as Arc<CredentialStore>)
            .map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn entry() -> Result<keyring_core::Entry, String> {
    use keyring_core::CredentialStore;
    use std::sync::{Arc, OnceLock};

    const SERVICE: &str = "com.henryfellerhoff.posto.github";
    const USER: &str = "oauth-session";
    static STORE: OnceLock<Result<Arc<CredentialStore>, String>> = OnceLock::new();

    let store = STORE
        .get_or_init(platform::create_store)
        .as_ref()
        .map_err(Clone::clone)?;
    store
        .build(SERVICE, USER, None)
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn load_session() -> Result<Option<StoredSession>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn save_session(session: &StoredSession) -> Result<(), String> {
    let value = serde_json::to_string(session).map_err(|error| error.to_string())?;
    entry()?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn delete_session() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

// Desktop stores the session in the OS keychain via the `keyring` crate, which
// selects the native store per platform (macOS Keychain, Windows Credential
// Manager, *nix Secret Service) and registers it on first use. Same service and
// account names as the mobile keychain entry, for consistency.
#[cfg(all(not(any(target_os = "ios", target_os = "android")), not(test)))]
mod desktop_keychain {
    use super::StoredSession;

    const SERVICE: &str = "com.henryfellerhoff.posto.github";
    const ACCOUNT: &str = "oauth-session";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())
    }

    pub fn load_session() -> Result<Option<StoredSession>, String> {
        match entry()?.get_password() {
            Ok(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|error| error.to_string()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn save_session(session: &StoredSession) -> Result<(), String> {
        let value = serde_json::to_string(session).map_err(|error| error.to_string())?;
        entry()?
            .set_password(&value)
            .map_err(|error| error.to_string())
    }

    pub fn delete_session() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(all(not(any(target_os = "ios", target_os = "android")), not(test)))]
pub use desktop_keychain::{delete_session, load_session, save_session};

#[cfg(test)]
mod test_store {
    use super::StoredSession;
    use std::sync::Mutex;

    static SESSION: Mutex<Option<StoredSession>> = Mutex::new(None);

    pub fn load_session() -> Result<Option<StoredSession>, String> {
        Ok(SESSION.lock().map_err(|error| error.to_string())?.clone())
    }

    pub fn save_session(session: &StoredSession) -> Result<(), String> {
        *SESSION.lock().map_err(|error| error.to_string())? = Some(session.clone());
        Ok(())
    }

    pub fn delete_session() -> Result<(), String> {
        *SESSION.lock().map_err(|error| error.to_string())? = None;
        Ok(())
    }
}

#[cfg(test)]
pub use test_store::{delete_session, load_session, save_session};
