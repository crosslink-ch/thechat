//! Windows-only WebView2 adapter. All COM objects stay on the WebView UI thread.
//! App consent never changes Windows privacy settings or saved browser decisions.
use super::policy::{Request, Session, Trust, INTENT_TTL};
use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Manager, Webview};
use tauri_plugin_opener::OpenerExt;
use webview2_com::{
    take_pwstr, FrameChildFrameCreatedEventHandler, FrameCreatedEventHandler,
    FramePermissionRequestedEventHandler, GetNonDefaultPermissionSettingsCompletedHandler,
    Microsoft::Web::WebView2::Win32::*, NavigationStartingEventHandler,
    PermissionRequestedEventHandler,
};
use windows::core::{Interface, BOOL, PWSTR};
use windows::Win32::Foundation::E_FAIL;

type Shared = Arc<Mutex<Session>>;
struct MicrophoneState {
    session: Shared,
    trust: Trust,
}
const UNAVAILABLE: &str = "Secure microphone permission handling is unavailable. Update Microsoft Edge WebView2 and restart TheChat.";
const CANCELLED: &str = "Recording was cancelled or the app document changed. Click Record again.";

// One registration per main WebView. Keeping tokens allows explicit teardown;
// frame handlers are owned by their frames and released when those frames die.
struct Registration {
    core: ICoreWebView2,
    permission: i64,
    frames: i64,
    navigation: i64,
    source_changed: i64,
}
impl Drop for Registration {
    fn drop(&mut self) {
        unsafe {
            let _ = self.core.remove_PermissionRequested(self.permission);
            let _ = self.core.remove_NavigationStarting(self.navigation);
            let _ = self.core.remove_SourceChanged(self.source_changed);
            if let Ok(core) = self.core.cast::<ICoreWebView2_4>() {
                let _ = core.remove_FrameCreated(self.frames);
            }
        }
    }
}
thread_local! { static REGISTRATION: RefCell<Option<Registration>> = const { RefCell::new(None) }; }

fn disable(session: &Shared) {
    if let Ok(mut session) = session.lock() {
        session.ready = false;
        session.invalidate();
    }
    log::warn!("{UNAVAILABLE}");
}
fn source(core: &ICoreWebView2) -> windows::core::Result<String> {
    unsafe {
        let mut uri = PWSTR::null();
        core.Source(&mut uri)?;
        Ok(take_pwstr(uri))
    }
}

// State() on PermissionRequestedEventArgs is DEFAULT, not the saved setting.
// Read Profile4 instead, and do not write/reset any profile setting (even allows).
fn saved_denial(
    core: &ICoreWebView2,
    trust: Trust,
    done: impl FnOnce(windows::core::Result<bool>) + 'static,
) -> windows::core::Result<()> {
    unsafe {
        let profile = core
            .cast::<ICoreWebView2_13>()?
            .Profile()?
            .cast::<ICoreWebView2Profile4>()?;
        profile.GetNonDefaultPermissionSettings(
            &GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(
                move |error, settings| {
                    let result = (|| {
                        error?;
                        let settings =
                            settings.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
                        let mut count = 0;
                        settings.Count(&mut count)?;
                        for index in 0..count {
                            let setting = settings.GetValueAtIndex(index)?;
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                            setting.PermissionKind(&mut kind)?;
                            if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                                continue;
                            }
                            let mut uri = PWSTR::null();
                            setting.PermissionOrigin(&mut uri)?;
                            if !trust.matches(&take_pwstr(uri)) {
                                continue;
                            }
                            let mut state = COREWEBVIEW2_PERMISSION_STATE_DEFAULT;
                            setting.PermissionState(&mut state)?;
                            if state == COREWEBVIEW2_PERMISSION_STATE_DENY {
                                return Ok(true);
                            }
                        }
                        Ok(false)
                    })();
                    done(result);
                    Ok(())
                },
            )),
        )
    }
}

struct Deferral(ICoreWebView2Deferral);
impl Drop for Deferral {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Complete();
        }
    }
}

fn permission(
    core: ICoreWebView2,
    args: ICoreWebView2PermissionRequestedEventArgs,
    session: Shared,
    trust: Trust,
) -> windows::core::Result<()> {
    unsafe {
        let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
        args.PermissionKind(&mut kind)?;
        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
            && kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA
        {
            return Ok(());
        }
        let args3 = match args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
            Ok(args) => args,
            Err(_) => {
                disable(&session);
                return Ok(());
            } // normal engine consent, never a fallback grant
        };
        args3.SetSavesInProfile(false)?;
        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; // fail closed on all later errors
        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
            if let Ok(mut state) = session.lock() {
                state.invalidate();
            }
            return Ok(());
        }
        let mut gesture = BOOL::default();
        args.IsUserInitiated(&mut gesture)?;
        if !gesture.as_bool() {
            if let Ok(mut state) = session.lock() {
                state.invalidate();
            }
            log::warn!("Microphone request denied: WebView2 did not preserve native user activation. Click Record again; no automatic permission fallback is used.");
            return Ok(());
        }
        let mut uri = PWSTR::null();
        args.Uri(&mut uri)?;
        let uri = take_pwstr(uri);
        let generation = session
            .lock()
            .map_err(|_| windows::core::Error::from(E_FAIL))?
            .generation;
        let deferral = Deferral(args.GetDeferral()?);
        let current = core.clone();
        let failed = session.clone();
        let lookup_trust = trust.clone();
        let result = saved_denial(&core, lookup_trust, move |denied| {
            // The live top-level source and generation are checked AFTER the async profile read.
            if let Some((saved_denied, source)) = denied.ok().zip(source(&current).ok()) {
                if let Ok(mut state) = session.lock() {
                    if state.authorize(
                        &trust,
                        &Request {
                            window: "main",
                            source: &source,
                            uri: &uri,
                            microphone_only: true,
                            top_frame: true,
                            user_initiated: gesture.as_bool(),
                            saved_denied,
                            generation,
                        },
                        Instant::now(),
                    ) {
                        // Serialize the final grant with cancellation. No lock spans await/IPC.
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    }
                }
            }
            drop(deferral); // exactly once, including all lookup/read/validation failures
        });
        if result.is_err() {
            disable(&failed);
        }
        result
    }
}

fn protect_frame(frame: ICoreWebView2Frame, session: Shared) -> windows::core::Result<()> {
    unsafe {
        let frame3 = frame.cast::<ICoreWebView2Frame3>()?;
        // The root FrameCreated event only covers direct children. Require nested-frame
        // discovery too; older runtimes disable the enhanced path rather than guessing.
        let frame7 = frame.cast::<ICoreWebView2Frame7>()?;
        let mut token = 0;
        let failed = session.clone();
        frame3.add_PermissionRequested(
            &FramePermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let result = (|| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                        args.PermissionKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        {
                            // Do not let even a same-origin frame bubble into the root grant.
                            args.SetHandled(true)?;
                            match args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                                Ok(args3) => {
                                    args3.SetSavesInProfile(false)?;
                                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                                }
                                Err(_) => disable(&failed),
                            }
                        }
                    } else {
                        disable(&failed);
                    }
                    Ok(())
                })();
                if result.is_err() {
                    disable(&failed);
                }
                result
            })),
            &mut token,
        )?;
        frame7.add_FrameCreated(
            &FrameChildFrameCreatedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    if args
                        .Frame()
                        .and_then(|frame| protect_frame(frame, session.clone()))
                        .is_err()
                    {
                        disable(&session);
                    }
                } else {
                    disable(&session);
                }
                Ok(())
            })),
            &mut token,
        )?;
        Ok(())
    }
}

fn install(core: ICoreWebView2, session: Shared, trust: Trust) -> windows::core::Result<()> {
    unsafe {
        // Profile support is required before prepareRecording can remember consent.
        core.cast::<ICoreWebView2_13>()?
            .Profile()?
            .cast::<ICoreWebView2Profile4>()?;
        let core4 = core.cast::<ICoreWebView2_4>()?;
        let mut registration = Registration {
            core: core.clone(),
            permission: 0,
            frames: 0,
            navigation: 0,
            source_changed: 0,
        };
        let frames = session.clone();
        core4.add_FrameCreated(
            &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    if args
                        .Frame()
                        .and_then(|frame| protect_frame(frame, frames.clone()))
                        .is_err()
                    {
                        disable(&frames);
                    }
                } else {
                    disable(&frames);
                }
                Ok(())
            })),
            &mut registration.frames,
        )?;
        let navigation = session.clone();
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, _| {
                if let Ok(mut session) = navigation.lock() {
                    session.invalidate();
                }
                Ok(())
            })),
            &mut registration.navigation,
        )?;
        let changed = session.clone();
        core.add_SourceChanged(
            &webview2_com::SourceChangedEventHandler::create(Box::new(move |_, _| {
                // Includes same-document history/hash navigation, not only page loads.
                if let Ok(mut session) = changed.lock() {
                    session.invalidate();
                }
                Ok(())
            })),
            &mut registration.source_changed,
        )?;
        let requests = session.clone();
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |core, args| {
                match (core, args) {
                    (Some(core), Some(args)) => {
                        let result = permission(core, args, requests.clone(), trust.clone());
                        if result.is_err() {
                            disable(&requests);
                        }
                        result
                    }
                    _ => {
                        disable(&requests);
                        Ok(())
                    }
                }
            })),
            &mut registration.permission,
        )?;
        REGISTRATION.with(|slot| {
            *slot.borrow_mut() = Some(registration);
        });
        session
            .lock()
            .map_err(|_| windows::core::Error::from(E_FAIL))?
            .ready = true;
        Ok(())
    }
}

async fn inspect(webview: Webview, prepare: bool) -> Result<&'static str, String> {
    let started = Instant::now();
    let state = webview.state::<MicrophoneState>();
    let session = state.session.clone();
    let trust = state.trust.clone();
    let generation = session.lock().map_err(|_| UNAVAILABLE)?.generation;
    // Reading Webview.url() may dispatch to the UI thread: never hold the policy mutex across it.
    let caller_source = webview.url().map_err(|_| CANCELLED)?;
    if !session.lock().map_err(|_| UNAVAILABLE)?.can_prepare(
        &trust,
        caller_source.as_str(),
        webview.label(),
        generation,
        false,
    ) {
        return Err(UNAVAILABLE.into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview.with_webview(move |platform| {
        let result = unsafe { platform.controller().CoreWebView2() };
        let Ok(core) = result else { let _ = tx.send(Err(UNAVAILABLE.to_string())); return; };
        let current = core.clone();
        let lookup_trust = trust.clone();
        // If starting the callback fails, dropping tx also rejects the awaiting IPC.
        let _ = saved_denial(&core, lookup_trust, move |denied| {
            let result = (|| {
                let denied = denied.map_err(|_| UNAVAILABLE)?;
                let source = source(&current).map_err(|_| CANCELLED)?;
                let mut state = session.lock().map_err(|_| UNAVAILABLE)?;
                if !state.can_prepare(&trust, &source, "main", generation, false) { return Err(CANCELLED.to_string()); }
                if denied {
                    state.invalidate();
                    return if prepare { Err("Microphone access was previously blocked in this WebView profile. TheChat will not override that choice.".into()) } else { Ok("denied") };
                }
                if prepare && (tx.is_closed() || !state.complete_prepare(started, Instant::now())) { return Err(CANCELLED.to_string()); }
                Ok(if state.consent { "granted" } else { "prompt" })
            })();
            let _ = tx.send(result);
        });
    }).map_err(|_| UNAVAILABLE)?;
    tokio::time::timeout(INTENT_TTL, rx)
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
        .map_err(|_| UNAVAILABLE.to_string())?
}

#[tauri::command]
async fn get_permission_state(webview: Webview) -> Result<&'static str, String> {
    inspect(webview, false).await
}
#[tauri::command]
async fn prepare_recording(webview: Webview) -> Result<(), String> {
    inspect(webview, true).await.map(|_| ())
}
#[tauri::command]
fn cancel_recording(webview: Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err(CANCELLED.into());
    }
    webview
        .state::<MicrophoneState>()
        .session
        .lock()
        .map_err(|_| UNAVAILABLE)?
        .invalidate();
    Ok(())
}
#[tauri::command]
fn open_settings(webview: Webview) -> Result<(), String> {
    let state = webview.state::<MicrophoneState>();
    if webview.label() != "main"
        || !state
            .trust
            .matches(webview.url().map_err(|_| CANCELLED)?.as_str())
    {
        return Err(CANCELLED.into());
    }
    webview
        .app_handle()
        .opener()
        .open_url("ms-settings:privacy-microphone", None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("microphone")
        .invoke_handler(tauri::generate_handler![get_permission_state, prepare_recording, cancel_recording, open_settings])
        .setup(|app, _| {
            let config = app.config();
            let secure = config.app.windows.iter().find(|window| window.label == "main").is_some_and(|window| window.use_https_scheme);
            let packaged = url::Url::parse(if secure { "https://tauri.localhost" } else { "http://tauri.localhost" })?;
            let origin = if tauri::is_dev() { config.build.dev_url.clone().unwrap_or(packaged) } else { packaged };
            app.manage(MicrophoneState { session: Arc::new(Mutex::new(Session::default())), trust: Trust(origin) });
            Ok(())
        })
        .on_webview_ready(|webview| {
            if webview.label() != "main" { return; }
            let state = webview.state::<MicrophoneState>();
            let session = state.session.clone();
            let failed = session.clone();
            let trust = state.trust.clone();
            if webview.with_webview(move |platform| {
                let result = unsafe { platform.controller().CoreWebView2() }.and_then(|core| install(core, session.clone(), trust));
                if result.is_err() { disable(&session); }
            }).is_err() { disable(&failed); }
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main") {
                disable(&app.state::<MicrophoneState>().session);
                REGISTRATION.with(|slot| { slot.borrow_mut().take(); });
            }
        })
        .build()
}
