fn main() {
    let microphone = tauri_build::InlinedPlugin::new().commands(&[
        "get_permission_state",
        "prepare_recording",
        "cancel_recording",
        "open_settings",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().plugin("microphone", microphone))
        .expect("failed to build Tauri application");
}
