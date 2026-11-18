//! Reads and writes secrets in the platform credential store: the macOS and iOS
//! Keychain, Windows Credential Manager, Android Keystore, or Secret Service.

#[cfg(any(target_os = "ios", target_os = "android"))]
mod platform {
    use keyring_core::{CredentialStore, Entry, Error};
    use std::sync::{Arc, OnceLock};

    #[cfg(target_os = "ios")]
    fn create_store() -> Result<Arc<CredentialStore>, String> {
        apple_native_keyring_store::protected::Store::new()
            .map(|store| store as Arc<CredentialStore>)
            .map_err(|error| error.to_string())
    }

    #[cfg(target_os = "android")]
    fn create_store() -> Result<Arc<CredentialStore>, String> {
        android_native_keyring_store::Store::new()
            .map(|store| store as Arc<CredentialStore>)
            .map_err(|error| error.to_string())
    }

    fn entry(service: &str, account: &str) -> Result<Entry, String> {
        static STORE: OnceLock<Result<Arc<CredentialStore>, String>> = OnceLock::new();
        let store = STORE
            .get_or_init(create_store)
            .as_ref()
            .map_err(Clone::clone)?;
        store
            .build(service, account, None)
            .map_err(|error| error.to_string())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        match entry(service, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
        entry(service, account)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

// The `keyring` crate selects the native store per desktop platform and
// registers it on first use.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use keyring::{Entry, Error};

    fn entry(service: &str, account: &str) -> Result<Entry, String> {
        Entry::new(service, account).map_err(|error| error.to_string())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        match entry(service, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
        entry(service, account)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

pub use platform::{delete, get, set};
