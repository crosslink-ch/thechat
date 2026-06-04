//! End-to-end check that the dev-logs pipeline writes Promtail-compatible
//! JSON lines to `desktop.log` (see deployment/local/promtail.yml). Lives in
//! an integration test so registering the global logger doesn't conflict with
//! the unit tests in the lib.

#[test]
fn dev_log_target_writes_promtail_json_lines() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("THECHAT_DEV_LOGS_DIR", dir.path());

    let app = tauri::test::mock_builder()
        .plugin(thechat_lib::log_plugin_builder().build())
        .build(tauri::generate_context!())
        .unwrap();

    log::info!(target: "webview", "hello from the dev log test");

    let contents = std::fs::read_to_string(dir.path().join("desktop.log")).unwrap();
    let line = contents
        .lines()
        .find(|l| l.contains("hello from the dev log test"))
        .expect("log line should be written to desktop.log");

    let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
    assert_eq!(parsed["level"], "info");
    assert_eq!(parsed["target"], "webview");
    assert_eq!(parsed["msg"], "hello from the dev log test");
    assert!(parsed["time"].as_u64().unwrap() > 0);

    drop(app);
}
