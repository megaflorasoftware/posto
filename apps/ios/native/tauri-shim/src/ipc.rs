//! Streaming responses from a running command to the host app.

use std::cell::RefCell;
use std::fmt;
use std::marker::PhantomData;

use serde::de::{self, Deserialize, Deserializer, Visitor};
use serde::Serialize;

use crate::AppHandle;

/// What Tauri's JavaScript `Channel` serializes to.
const CHANNEL_PREFIX: &str = "__CHANNEL__:";

/// The event that carries every channel message to the host, with the
/// payload `{"id": <channel id>, "message": <message>}`.
pub const CHANNEL_EVENT: &str = "channel";

thread_local! {
    static INVOKE_APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
}

/// Runs `f` with `app` as the app that channels deserialized inside it
/// deliver to. The bridge deserializes command arguments in here, which is
/// how a [`Channel`] reaches the host without the webview Tauri would use.
pub fn with_invoke_app<R>(app: &AppHandle, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<AppHandle>);

    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            INVOKE_APP.with(|current| *current.borrow_mut() = previous);
        }
    }

    let previous = INVOKE_APP.with(|current| current.borrow_mut().replace(app.clone()));
    let _restore = Restore(previous);
    f()
}

/// A command argument that streams messages back to the caller. The caller
/// passes a numeric channel id (or Tauri's `"__CHANNEL__:<id>"` string);
/// each [`Channel::send`] is emitted as [`CHANNEL_EVENT`]. A `null` channel
/// accepts and drops every message.
pub struct Channel<TSend = serde_json::Value> {
    id: u32,
    app: Option<AppHandle>,
    phantom: PhantomData<fn(TSend)>,
}

impl<TSend> Channel<TSend> {
    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn send(&self, data: TSend) -> crate::Result<()>
    where
        TSend: Serialize,
    {
        let Some(app) = &self.app else {
            return Ok(());
        };
        let message = serde_json::to_string(&data)?;
        app.emit_json(
            CHANNEL_EVENT,
            &format!(r#"{{"id":{},"message":{message}}}"#, self.id),
        )
    }
}

impl<TSend> Clone for Channel<TSend> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            app: self.app.clone(),
            phantom: PhantomData,
        }
    }
}

impl<TSend> fmt::Debug for Channel<TSend> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Channel")
            .field("id", &self.id)
            .field("detached", &self.app.is_none())
            .finish()
    }
}

impl<'de, TSend> Deserialize<'de> for Channel<TSend> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let Some(id) = deserializer.deserialize_any(ChannelIdVisitor)? else {
            return Ok(Self {
                id: 0,
                app: None,
                phantom: PhantomData,
            });
        };
        let app = INVOKE_APP
            .with(|current| current.borrow().clone())
            .ok_or_else(|| {
                de::Error::custom("a Channel can only be deserialized while a command is invoked")
            })?;
        Ok(Self {
            id,
            app: Some(app),
            phantom: PhantomData,
        })
    }
}

struct ChannelIdVisitor;

impl<'de> Visitor<'de> for ChannelIdVisitor {
    type Value = Option<u32>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a channel id, \"__CHANNEL__:<id>\", or null")
    }

    fn visit_u64<E: de::Error>(self, id: u64) -> Result<Self::Value, E> {
        u32::try_from(id)
            .map(Some)
            .map_err(|_| E::custom("invalid channel ID"))
    }

    fn visit_i64<E: de::Error>(self, id: i64) -> Result<Self::Value, E> {
        u32::try_from(id)
            .map(Some)
            .map_err(|_| E::custom("invalid channel ID"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        value
            .strip_prefix(CHANNEL_PREFIX)
            .ok_or_else(|| E::custom("invalid channel string"))?
            .parse()
            .map(Some)
            .map_err(|_| E::custom("invalid channel ID"))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Builder;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    type Events = Arc<Mutex<Vec<(String, String)>>>;

    fn recording_app() -> (AppHandle, Events) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let app = Builder::default()
            .on_event(move |event, payload| {
                sink.lock()
                    .unwrap()
                    .push((event.to_string(), payload.to_string()));
            })
            .build();
        (app, events)
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Progress {
        done_count: u32,
    }

    #[test]
    fn sends_arrive_as_channel_events() {
        let (app, events) = recording_app();
        let channel: Channel<Progress> =
            with_invoke_app(&app, || serde_json::from_value(json!(7))).unwrap();
        channel.send(Progress { done_count: 1 }).unwrap();
        channel.clone().send(Progress { done_count: 2 }).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, CHANNEL_EVENT);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&events[1].1).unwrap(),
            json!({ "id": 7, "message": { "doneCount": 2 } })
        );
    }

    #[test]
    fn accepts_tauri_channel_strings_and_null() {
        let (app, events) = recording_app();
        let tauri: Channel<u8> =
            with_invoke_app(&app, || serde_json::from_value(json!("__CHANNEL__:42"))).unwrap();
        assert_eq!(tauri.id(), 42);
        let detached: Channel<u8> =
            with_invoke_app(&app, || serde_json::from_value(json!(null))).unwrap();
        detached.send(1).unwrap();
        assert_eq!(events.lock().unwrap().len(), 0);
    }

    #[test]
    fn rejects_channels_outside_an_invoke() {
        assert!(serde_json::from_value::<Channel<u8>>(json!(1)).is_err());
        assert!(serde_json::from_value::<Channel<u8>>(json!("1")).is_err());
    }
}
