use super::StoredSession;
use std::sync::Mutex;

/// Process-local copy of the persisted GitHub session. Cache errors as well as
/// successful reads so a denied or unavailable credential store cannot prompt
/// repeatedly during polling. A successful save or delete replaces the cached
/// result.
struct SessionCache {
    loaded: Option<Result<Option<StoredSession>, String>>,
}

impl SessionCache {
    const fn new() -> Self {
        Self { loaded: None }
    }

    fn get_or_load(
        &mut self,
        load: impl FnOnce() -> Result<Option<StoredSession>, String>,
    ) -> Result<Option<StoredSession>, String> {
        if let Some(session) = &self.loaded {
            return session.clone();
        }
        let session = load();
        self.loaded = Some(session.clone());
        session
    }

    fn replace(&mut self, session: Option<StoredSession>) {
        self.loaded = Some(Ok(session));
    }

    fn reload(
        &mut self,
        load: impl FnOnce() -> Result<Option<StoredSession>, String>,
    ) -> Result<Option<StoredSession>, String> {
        self.loaded = None;
        self.get_or_load(load)
    }
}

static SESSION_CACHE: Mutex<SessionCache> = Mutex::new(SessionCache::new());

// The session lives in the platform credential store under the same service
// and account names on every platform.
#[cfg(not(test))]
mod keychain {
    use super::StoredSession;
    use crate::secrets;

    const SERVICE: &str = "net.megaflora.posto.github";
    const ACCOUNT: &str = "oauth-session";

    pub fn load_session() -> Result<Option<StoredSession>, String> {
        secrets::get(SERVICE, ACCOUNT)?
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn save_session(session: &StoredSession) -> Result<(), String> {
        let value = serde_json::to_string(session).map_err(|error| error.to_string())?;
        secrets::set(SERVICE, ACCOUNT, &value)
    }

    pub fn delete_session() -> Result<(), String> {
        secrets::delete(SERVICE, ACCOUNT)
    }
}

#[cfg(not(test))]
use keychain::{
    delete_session as delete_persisted_session, load_session as load_persisted_session,
    save_session as save_persisted_session,
};

#[cfg(test)]
use test_store::{
    delete_session as delete_persisted_session, load_session as load_persisted_session,
    save_session as save_persisted_session,
};

pub fn load_session() -> Result<Option<StoredSession>, String> {
    SESSION_CACHE
        .lock()
        .map_err(|error| error.to_string())?
        .get_or_load(load_persisted_session)
}

/// Retry the persisted credential read after an explicit user action. The
/// resulting session or error becomes the one cached for the rest of the
/// process, unless the user explicitly retries again.
pub fn reload_session() -> Result<Option<StoredSession>, String> {
    SESSION_CACHE
        .lock()
        .map_err(|error| error.to_string())?
        .reload(load_persisted_session)
}

pub fn save_session(session: &StoredSession) -> Result<(), String> {
    let mut cache = SESSION_CACHE.lock().map_err(|error| error.to_string())?;
    save_persisted_session(session)?;
    cache.replace(Some(session.clone()));
    Ok(())
}

pub fn delete_session() -> Result<(), String> {
    let mut cache = SESSION_CACHE.lock().map_err(|error| error.to_string())?;
    delete_persisted_session()?;
    cache.replace(None);
    Ok(())
}

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
mod tests {
    use super::*;
    use std::cell::Cell;

    fn session(token: &str) -> StoredSession {
        StoredSession {
            token: token.to_string(),
            user: super::super::GitHubUser {
                id: 1,
                login: "octocat".to_string(),
                name: "Octocat".to_string(),
                avatar_url: "https://example.com/avatar".to_string(),
                commit_email: "1+octocat@users.noreply.github.com".to_string(),
            },
        }
    }

    #[test]
    fn cache_loads_persisted_session_once() {
        let reads = Cell::new(0);
        let mut cache = SessionCache::new();

        for _ in 0..2 {
            let loaded = cache
                .get_or_load(|| {
                    reads.set(reads.get() + 1);
                    Ok(Some(session("token")))
                })
                .unwrap();
            assert_eq!(loaded.unwrap().token, "token");
        }

        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn cache_remembers_read_errors_until_replaced() {
        let reads = Cell::new(0);
        let mut cache = SessionCache::new();

        for _ in 0..2 {
            let error = cache
                .get_or_load(|| {
                    reads.set(reads.get() + 1);
                    Err("credential store denied access".to_string())
                })
                .unwrap_err();
            assert_eq!(error, "credential store denied access");
        }
        assert_eq!(reads.get(), 1);

        cache.replace(Some(session("replacement")));
        assert_eq!(
            cache.get_or_load(|| unreachable!()).unwrap().unwrap().token,
            "replacement"
        );
    }

    #[test]
    fn explicit_reload_retries_a_cached_error() {
        let mut cache = SessionCache::new();
        assert!(cache
            .get_or_load(|| Err("credential store denied access".to_string()))
            .is_err());

        let loaded = cache.reload(|| Ok(Some(session("retried")))).unwrap();
        assert_eq!(loaded.unwrap().token, "retried");
        assert_eq!(
            cache.get_or_load(|| unreachable!()).unwrap().unwrap().token,
            "retried"
        );
    }
}
