#![cfg_attr(test, allow(dead_code))]

mod storage;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Emitter;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_URL: &str = "https://api.github.com";
const DEVICE_CODE_EVENT: &str = "auth-device-code";
const API_VERSION: &str = "2022-11-28";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct GitHubUser {
    pub id: u64,
    pub login: String,
    pub name: String,
    pub avatar_url: String,
    pub commit_email: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct StoredSession {
    token: String,
    user: GitHubUser,
}

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    signed_in: bool,
    user: Option<GitHubUser>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeviceAuthorization {
    user_code: String,
    verification_uri: String,
    expires_in: u64,
}

#[derive(Debug, Serialize)]
pub struct GitHubRepo {
    id: u64,
    owner: String,
    name: String,
    full_name: String,
    private: bool,
    clone_url: String,
    default_branch: String,
    updated_at: String,
}

#[derive(Default)]
pub struct AuthState {
    signing_in: AtomicBool,
}

struct SignInGuard<'a>(&'a AtomicBool);

impl Drop for SignInGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ApiUser {
    id: u64,
    login: String,
    name: Option<String>,
    avatar_url: String,
}

#[derive(Debug, Deserialize)]
struct ApiOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct ApiRepo {
    id: u64,
    owner: ApiOwner,
    name: String,
    full_name: String,
    private: bool,
    clone_url: String,
    default_branch: String,
    updated_at: String,
}

enum PollAction {
    Complete(String),
    Wait(u64),
    Fail(String),
}

struct GitHubClient {
    http: reqwest::Client,
}

impl GitHubClient {
    fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent("Posto")
            .build()
            .map_err(err_str)?;
        Ok(Self { http })
    }

    async fn request_device_code(&self, client_id: &str) -> Result<DeviceCodeResponse, String> {
        let response = self
            .http
            .post(DEVICE_CODE_URL)
            .header("Accept", "application/json")
            .form(&[("client_id", client_id), ("scope", "repo")])
            .send()
            .await
            .map_err(err_str)?
            .error_for_status()
            .map_err(err_str)?;
        response.json().await.map_err(err_str)
    }

    async fn poll_access_token(
        &self,
        client_id: &str,
        device: &DeviceCodeResponse,
    ) -> Result<String, String> {
        let mut interval = device.interval.max(1);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(device.expires_in);
        loop {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            if tokio::time::Instant::now() >= deadline {
                return Err("The GitHub sign-in code expired".to_string());
            }
            let response = self
                .http
                .post(ACCESS_TOKEN_URL)
                .header("Accept", "application/json")
                .form(&[
                    ("client_id", client_id),
                    ("device_code", device.device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await
                .map_err(err_str)?
                .error_for_status()
                .map_err(err_str)?
                .json::<TokenResponse>()
                .await
                .map_err(err_str)?;
            match poll_action(response, interval) {
                PollAction::Complete(token) => return Ok(token),
                PollAction::Wait(next_interval) => interval = next_interval,
                PollAction::Fail(message) => return Err(message),
            }
        }
    }

    async fn user(&self, token: &str) -> Result<GitHubUser, String> {
        let user = self
            .api_get(&format!("{API_URL}/user"), token)
            .await?
            .json::<ApiUser>()
            .await
            .map_err(err_str)?;
        Ok(github_user(user))
    }

    async fn repos(&self, token: &str) -> Result<Vec<GitHubRepo>, String> {
        let mut repos = Vec::new();
        let mut page = 1;
        loop {
            let url = format!(
                "{API_URL}/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page={page}"
            );
            let batch = self
                .api_get(&url, token)
                .await?
                .json::<Vec<ApiRepo>>()
                .await
                .map_err(err_str)?;
            let done = batch.len() < 100;
            repos.extend(batch.into_iter().map(github_repo));
            if done {
                return Ok(repos);
            }
            page += 1;
        }
    }

    async fn api_get(&self, url: &str, token: &str) -> Result<reqwest::Response, String> {
        self.http
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
            .send()
            .await
            .map_err(err_str)?
            .error_for_status()
            .map_err(err_str)
    }
}

fn err_str(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn client_id() -> Result<&'static str, String> {
    option_env!("POSTO_GITHUB_CLIENT_ID")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "GitHub sign-in is not configured for this build".to_string())
}

fn poll_action(response: TokenResponse, interval: u64) -> PollAction {
    if let Some(token) = response.access_token.filter(|token| !token.is_empty()) {
        return PollAction::Complete(token);
    }
    match response.error.as_deref() {
        Some("authorization_pending") => PollAction::Wait(response.interval.unwrap_or(interval)),
        Some("slow_down") => PollAction::Wait(response.interval.unwrap_or(interval) + 5),
        Some("expired_token") => PollAction::Fail("The GitHub sign-in code expired".to_string()),
        Some("access_denied") => PollAction::Fail("GitHub sign-in was cancelled".to_string()),
        Some("incorrect_device_code") => {
            PollAction::Fail("GitHub rejected the sign-in code".to_string())
        }
        Some(_) => PollAction::Fail(
            response
                .error_description
                .unwrap_or_else(|| "GitHub sign-in failed".to_string()),
        ),
        None => PollAction::Fail("GitHub returned an invalid sign-in response".to_string()),
    }
}

fn github_user(user: ApiUser) -> GitHubUser {
    let name = user
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| user.login.clone());
    GitHubUser {
        id: user.id,
        commit_email: format!("{}+{}@users.noreply.github.com", user.id, user.login),
        login: user.login,
        name,
        avatar_url: user.avatar_url,
    }
}

fn github_repo(repo: ApiRepo) -> GitHubRepo {
    GitHubRepo {
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
        clone_url: repo.clone_url,
        default_branch: repo.default_branch,
        updated_at: repo.updated_at,
    }
}

pub(crate) fn stored_token() -> Result<String, String> {
    storage::load_session()?
        .map(|session| session.token)
        .ok_or_else(|| "Not signed in to GitHub".to_string())
}

pub(crate) fn stored_identity() -> Result<(String, String), String> {
    storage::load_session()?
        .map(|session| (session.user.name, session.user.commit_email))
        .ok_or_else(|| "Not signed in to GitHub".to_string())
}

#[tauri::command]
pub async fn auth_status() -> Result<AuthStatus, String> {
    let session = tauri::async_runtime::spawn_blocking(storage::load_session)
        .await
        .map_err(err_str)??;
    Ok(AuthStatus {
        signed_in: session.is_some(),
        user: session.map(|session| session.user),
    })
}

/// Starts GitHub's device flow. The public code and verification URL are
/// emitted as `auth-device-code`; this command resolves after authorization.
#[tauri::command]
pub async fn sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<GitHubUser, String> {
    if state
        .signing_in
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A GitHub sign-in is already in progress".to_string());
    }
    let _guard = SignInGuard(&state.signing_in);
    let client_id = client_id()?;
    let github = GitHubClient::new()?;
    let device = github.request_device_code(client_id).await?;
    app.emit(
        DEVICE_CODE_EVENT,
        DeviceAuthorization {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            expires_in: device.expires_in,
        },
    )
    .map_err(err_str)?;
    let token = github.poll_access_token(client_id, &device).await?;
    let user = github.user(&token).await?;
    let session = StoredSession {
        token,
        user: user.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || storage::save_session(&session))
        .await
        .map_err(err_str)??;
    Ok(user)
}

#[tauri::command]
pub async fn sign_out() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(storage::delete_session)
        .await
        .map_err(err_str)??;
    Ok(())
}

#[tauri::command]
pub async fn list_user_repos() -> Result<Vec<GitHubRepo>, String> {
    let token = tauri::async_runtime::spawn_blocking(stored_token)
        .await
        .map_err(err_str)??;
    GitHubClient::new()?.repos(&token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_response(error: Option<&str>, interval: Option<u64>) -> TokenResponse {
        TokenResponse {
            access_token: None,
            error: error.map(str::to_string),
            error_description: None,
            interval,
        }
    }

    #[test]
    fn profile_uses_github_noreply_identity_and_login_fallback() {
        let user = github_user(ApiUser {
            id: 42,
            login: "octocat".into(),
            name: Some("  ".into()),
            avatar_url: "https://example.com/avatar".into(),
        });
        assert_eq!(user.name, "octocat");
        assert_eq!(user.commit_email, "42+octocat@users.noreply.github.com");
    }

    #[test]
    fn device_poll_honors_pending_interval_and_slow_down() {
        assert!(matches!(
            poll_action(token_response(Some("authorization_pending"), Some(7)), 5),
            PollAction::Wait(7)
        ));
        assert!(matches!(
            poll_action(token_response(Some("slow_down"), None), 5),
            PollAction::Wait(10)
        ));
    }

    #[test]
    fn device_poll_maps_terminal_errors() {
        assert!(matches!(
            poll_action(token_response(Some("expired_token"), None), 5),
            PollAction::Fail(message) if message.contains("expired")
        ));
        assert!(matches!(
            poll_action(token_response(Some("access_denied"), None), 5),
            PollAction::Fail(message) if message.contains("cancelled")
        ));
    }
}
