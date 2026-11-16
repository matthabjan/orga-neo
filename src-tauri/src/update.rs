//! Update check and install, run on this side so the UI only ever sees short
//! error codes and the window's CSP stays closed to the network.
//!
//! The check sorts failures into three cases (see [`classify`]):
//! - no release yet (`latest.json` answers 404) counts as "no update",
//! - no connection gives `update_offline`,
//! - anything else gives `update_check_failed`; the details go to the log.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// The update found by the last check, waiting for `update_install`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// How a failed check is shown to the user.
#[derive(Debug, PartialEq)]
enum CheckFailure {
    /// The endpoint answered, but without a manifest: no release published yet.
    NoRelease,
    /// GitHub could not be reached at all.
    Offline,
    /// Unreadable manifest, missing platform entry and the like.
    Other,
}

/// Sort an updater error. The plugin turns every non-2xx answer (the 404 of
/// `releases/latest/download/latest.json` while there is no release, but also
/// a 5xx) into `ReleaseNotFound` without keeping the status code, and reports
/// transport failures as `Reqwest`.
fn classify(err: &Error) -> CheckFailure {
    match err {
        Error::ReleaseNotFound => CheckFailure::NoRelease,
        Error::Reqwest(e) if e.is_connect() || e.is_timeout() || e.is_request() => CheckFailure::Offline,
        _ => CheckFailure::Other,
    }
}

/// Look for a newer version. `Ok(Some(version))` when there is one.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let found = app
        .updater()
        .map_err(|e| {
            log::error!("Update check failed: {e}");
            "update_check_failed".to_string()
        })?
        .check()
        .await;
    let found = match found {
        Ok(found) => found,
        Err(e) => match classify(&e) {
            CheckFailure::NoRelease => {
                log::info!("Update check: no release published");
                None
            }
            CheckFailure::Offline => {
                log::warn!("Update check: GitHub not reachable: {e}");
                return Err("update_offline".into());
            }
            CheckFailure::Other => {
                log::error!("Update check failed: {e:?}");
                return Err("update_check_failed".into());
            }
        },
    };
    let version = found.as_ref().map(|u| u.version.clone());
    *app.state::<PendingUpdate>().0.lock().unwrap() = found;
    Ok(version)
}

/// Progress of `update_install`, sent to the UI.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum InstallEvent {
    /// `total` is the download size in bytes, if known.
    Started { total: Option<u64> },
    Progress { chunk: usize },
    Installing,
}

/// Download and install the update found by the last check. The caller
/// restarts the app afterwards (on Windows the installer already closed it).
pub async fn install<R: Runtime>(app: &AppHandle<R>, on_event: Channel<InstallEvent>) -> Result<(), String> {
    let update = app.state::<PendingUpdate>().0.lock().unwrap().clone().ok_or("update_failed")?;
    let mut started = false;
    update
        .download_and_install(
            |chunk, total| {
                if !started {
                    started = true;
                    let _ = on_event.send(InstallEvent::Started { total });
                }
                let _ = on_event.send(InstallEvent::Progress { chunk });
            },
            || {
                let _ = on_event.send(InstallEvent::Installing);
            },
        )
        .await
        .map_err(|e| {
            log::error!("Update failed: {e:?}");
            "update_failed".to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    /// A one-shot local server that answers the first request with `reply`
    /// (or never answers when `None`).
    fn serve_once(reply: Option<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/latest.json", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = conn.read(&mut buf);
            match reply {
                Some(reply) => {
                    let _ = conn.write_all(reply.as_bytes());
                }
                None => std::thread::sleep(Duration::from_secs(2)),
            }
        });
        url
    }

    /// Fetch `url` the way the updater does and return its error.
    fn fetch_error(url: &str) -> Error {
        let _ = rustls::crypto::ring::default_provider().install_default();
        tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder().timeout(Duration::from_millis(200)).build().unwrap();
            let res = client.get(url).send().await?;
            res.json::<serde_json::Value>().await?;
            Ok::<(), reqwest::Error>(())
        })
        .unwrap_err()
        .into()
    }

    #[test]
    fn missing_release_counts_as_no_update() {
        assert_eq!(classify(&Error::ReleaseNotFound), CheckFailure::NoRelease);
    }

    #[test]
    fn refused_connection_is_offline() {
        // A port that was just free and is closed again.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = fetch_error(&format!("http://127.0.0.1:{port}/latest.json"));
        assert_eq!(classify(&err), CheckFailure::Offline);
    }

    #[test]
    fn timeout_is_offline() {
        let err = fetch_error(&serve_once(None));
        assert_eq!(classify(&err), CheckFailure::Offline);
    }

    #[test]
    fn unreadable_manifest_is_other() {
        let url = serve_once(Some("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot json!"));
        assert_eq!(classify(&fetch_error(&url)), CheckFailure::Other);
        let bad_json = serde_json::from_str::<u8>("{}").unwrap_err();
        assert_eq!(classify(&Error::Serialization(bad_json)), CheckFailure::Other);
        assert_eq!(classify(&Error::TargetNotFound("windows-x86_64".into())), CheckFailure::Other);
    }
}
