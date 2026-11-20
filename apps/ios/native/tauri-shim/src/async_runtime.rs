//! Tauri's global async runtime: one multi-thread tokio runtime, started on
//! first use and never shut down.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};

use tokio::runtime::Runtime;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("posto-async")
            .build()
            .expect("failed to start the async runtime")
    })
}

/// Awaits a spawned task. As in Tauri, the output is wrapped in a
/// [`crate::Result`] that fails when the task panicked or was cancelled.
#[derive(Debug)]
pub struct JoinHandle<T>(tokio::task::JoinHandle<T>);

impl<T> JoinHandle<T> {
    pub fn abort(&self) {
        self.0.abort();
    }
}

impl<T> Future for JoinHandle<T> {
    type Output = crate::Result<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx).map_err(Into::into)
    }
}

pub fn spawn<F>(task: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    JoinHandle(runtime().spawn(task))
}

pub fn spawn_blocking<F, R>(func: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    JoinHandle(runtime().spawn_blocking(func))
}

/// Runs a future to completion on the runtime, blocking the calling thread.
pub fn block_on<F: Future>(task: F) -> F::Output {
    runtime().block_on(task)
}

#[cfg(test)]
mod tests {
    #[test]
    fn blocking_tasks_resolve_to_results() {
        let value = super::block_on(super::spawn_blocking(|| 2 + 2)).unwrap();
        assert_eq!(value, 4);
    }

    #[test]
    fn panicking_tasks_resolve_to_join_errors() {
        let task = super::spawn(async {
            if true {
                panic!("boom");
            }
        });
        let error = super::block_on(task).unwrap_err();
        assert!(matches!(error, crate::Error::JoinError(_)));
    }
}
