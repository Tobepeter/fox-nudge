mod alert;
mod crypto;
mod data;
#[cfg(debug_assertions)]
mod debug;
mod log;
mod ntfy;
mod throttle;
mod tray;

use data::{Data, Identity, Message, Secrets, Settings, Template};
use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

pub struct AppState {
    pub data: Mutex<Data>,
    pub secrets: Mutex<Secrets>,
    pub hub: ntfy::Hub,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
struct Snapshot {
    settings: Settings,
    identity: Identity,
    templates: Vec<Template>,
    messages: Vec<Message>,
    connection: ntfy::Connection,
    /// 以下来源：custom 设置里填的；builtin 构建时内置；none 没有
    server_source: String,
    topic_source: String,
    token_source: String,
    key_source: String,
    recent_cleared_at: i64,
    version: String,
    dev: bool,
}

fn source(custom: &str, builtin: Option<&str>) -> String {
    if !custom.trim().is_empty() {
        "custom"
    } else if builtin.is_some() {
        "builtin"
    } else {
        "none"
    }
    .into()
}

fn snapshot(app: &tauri::AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap().clone();
    let secrets = state.secrets.lock().unwrap().clone();
    let connection = state.hub.status.lock().unwrap().clone();
    let server_source = source(&data.settings.server, ntfy::builtin_server());
    let topic_source = source(&data.settings.topic, ntfy::builtin_topic());
    Snapshot {
        settings: data.settings,
        identity: data.identity,
        templates: data.templates,
        messages: data.messages,
        connection,
        server_source,
        topic_source,
        token_source: if !secrets.token.trim().is_empty() {
            "custom"
        } else if ntfy::builtin_token().is_some() {
            "builtin"
        } else {
            "none"
        }
        .into(),
        key_source: if !secrets.key.trim().is_empty() {
            "custom"
        } else if crypto::builtin_key().is_some() {
            "builtin"
        } else {
            "none"
        }
        .into(),
        recent_cleared_at: data.recent_cleared_at,
        version: env!("CARGO_PKG_VERSION").into(),
        dev: cfg!(debug_assertions),
    }
}

pub fn notify(app: &tauri::AppHandle) {
    let _ = app.emit("snapshot", snapshot(app));
}

pub fn show(app: &tauri::AppHandle) {
    apply_dock(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 后台发送失败时窗口可能看不见，用通知告诉用户
pub fn alert_error(app: &tauri::AppHandle, text: &str) {
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        let _ = app.emit("error", text);
    } else {
        alert::notify(app, "发送失败", text);
    }
}

/// 开发版的 Dock 图标换成方形原图（icons/dev.png），安装版走 icon.icns 由系统显示圆角，
/// 两者在 Dock 里一眼可分。必须在 RunEvent::Ready 之后调用：tauri dev 会在 Ready 时用 icon.icns 覆盖一次
#[cfg(all(debug_assertions, target_os = "macos"))]
fn dev_icon() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(main) = MainThreadMarker::new() else { return };
    let bytes = NSData::with_bytes(include_bytes!("../icons/dev.png"));
    if let Some(image) = NSImage::initWithData(main.alloc(), &bytes) {
        unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image)) };
    }
}

fn apply_dock(app: &tauri::AppHandle, window_visible: bool) {
    let mode = app.state::<AppState>().data.lock().unwrap().settings.dock_mode.clone();
    let visible = mode == "always" || (mode == "window" && window_visible);
    let _ = app.set_activation_policy(if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    });
}

fn apply_theme(app: &tauri::AppHandle, theme: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(match theme {
            "dark" => Some(tauri::Theme::Dark),
            "light" => Some(tauri::Theme::Light),
            _ => None,
        });
    }
}

fn save(app: &tauri::AppHandle, update: impl FnOnce(&mut Data)) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut data = state.data.lock().unwrap();
    let mut next = data.clone();
    update(&mut next);
    data::save(&next)?;
    *data = next;
    Ok(())
}

#[tauri::command]
fn get_snapshot(app: tauri::AppHandle) -> Snapshot {
    snapshot(&app)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, mut settings: Settings) -> Result<(), String> {
    settings.normalize();
    settings.validate()?;
    let anonymous = app.state::<AppState>().data.lock().unwrap().identity.name == data::ANONYMOUS;
    if anonymous && settings.avatar_style == "name" {
        settings.avatar_style = data::random_style();
    }
    let previous = app.state::<AppState>().data.lock().unwrap().settings.clone();
    if settings.launch_at_login != previous.launch_at_login {
        if tauri::is_dev() && settings.launch_at_login {
            return Err("开发版不注册登录启动，请在安装版里开启".into());
        }
        let autolaunch = app.autolaunch();
        if settings.launch_at_login {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        }
        .map_err(|e| format!("登录启动设置失败：{e}"))?;
    }
    // 只记改了哪些项，不记值
    let (Ok(serde_json::Value::Object(a)), Ok(serde_json::Value::Object(b))) =
        (serde_json::to_value(&previous), serde_json::to_value(&settings))
    else {
        return Err("设置无法序列化".into());
    };
    let changed: Vec<_> = b.iter().filter(|(k, v)| a.get(*k) != Some(v)).map(|(k, _)| k.clone()).collect();
    if !changed.is_empty() {
        log::info("settings", "changed", json!({ "keys": changed }));
    }
    let reconnect = settings.server != previous.server
        || settings.topic != previous.topic
        || settings.mode != previous.mode
        || settings.poll_seconds != previous.poll_seconds;
    let topic_changed = settings.server != previous.server || settings.topic != previous.topic;
    save(&app, |d| {
        d.settings = settings.clone();
        if topic_changed {
            // 换了服务器或主题，旧的消息 ID 没有意义
            d.last_id = None;
        }
    })?;
    apply_theme(&app, &settings.theme);
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    apply_dock(&app, visible);
    if reconnect {
        app.state::<AppState>().hub.restart("settings");
    }
    notify(&app);
    Ok(())
}

#[tauri::command]
fn save_identity(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let name = data::clean_name(&name);
    save(&app, |d| {
        d.identity.name = name.clone().unwrap_or_else(|| data::ANONYMOUS.into());
        // 回到兜底名字时，“名字”头像没法用了，自动换成随机一套预设
        if name.is_none() && d.settings.avatar_style == "name" {
            d.settings.avatar_style = data::random_style();
        }
    })?;
    log::info("settings", "identity-changed", json!({}));
    notify(&app);
    Ok(())
}

#[tauri::command]
fn save_templates(app: tauri::AppHandle, templates: Vec<Template>) -> Result<(), String> {
    if templates.len() > data::TEMPLATE_LIMIT {
        return Err(format!("文案最多 {} 条", data::TEMPLATE_LIMIT));
    }
    let mut next = vec![];
    for mut t in templates {
        t.text = t.text.trim().to_string();
        if t.text.is_empty() {
            return Err("文案不能为空".into());
        }
        if t.text.chars().count() > data::TEMPLATE_TEXT_LIMIT {
            return Err(format!("文案最长 {} 个字", data::TEMPLATE_TEXT_LIMIT));
        }
        if t.id.is_empty() {
            t.id = uuid::Uuid::new_v4().to_string();
        }
        next.push(t);
    }
    save(&app, |d| d.templates = next)?;
    tray::refresh(&app);
    notify(&app);
    Ok(())
}

/// 恢复默认文案
#[tauri::command]
fn reset_templates(app: tauri::AppHandle) -> Result<(), String> {
    save(&app, |d| d.templates = data::default_templates())?;
    log::info("data", "templates-reset", json!({}));
    tray::refresh(&app);
    notify(&app);
    Ok(())
}

/// 重置设置：恢复默认设置并同步快捷键、登录启动、Dock 和订阅；昵称、文案、历史、令牌和密钥保留
#[tauri::command]
fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    save_settings(app, Settings::default())
}

#[tauri::command]
fn set_secret(app: tauri::AppHandle, kind: String, value: String) -> Result<(), String> {
    let value = value.trim().to_string();
    let state = app.state::<AppState>();
    let mut secrets = state.secrets.lock().unwrap().clone();
    match kind.as_str() {
        "token" => secrets.token = value,
        "key" => secrets.key = value,
        _ => return Err("未知的凭据".into()),
    }
    data::save_secrets(&secrets)?;
    *state.secrets.lock().unwrap() = secrets;
    log::info("settings", "secret-changed", json!({ "kind": kind }));
    if kind == "token" {
        state.hub.restart("token");
    }
    notify(&app);
    Ok(())
}

#[tauri::command]
fn generate_key() -> String {
    crypto::generate()
}

#[tauri::command]
async fn send(app: tauri::AppHandle, title: String, body: String) -> Result<Message, String> {
    ntfy::publish(&app, title, body).await
}

#[tauri::command]
fn reconnect(app: tauri::AppHandle) {
    app.state::<AppState>().hub.restart("manual");
}

/// 清空「最近发过」：只记下时间点，历史不删；撤销时传回原来的时间点
#[tauri::command]
fn set_recent_cleared(app: tauri::AppHandle, at: i64) -> Result<(), String> {
    save(&app, |d| d.recent_cleared_at = at)?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn clear_history(app: tauri::AppHandle) -> Result<(), String> {
    save(&app, |d| d.messages.clear())?;
    log::info("data", "history-cleared", json!({}));
    notify(&app);
    Ok(())
}

/// 清除数据：身份、模板、历史、设置和凭据都回到初始状态，日志一并删除
#[tauri::command]
fn wipe_data(app: tauri::AppHandle) -> Result<(), String> {
    if !tauri::is_dev() {
        let _ = app.autolaunch().disable();
    }
    data::wipe()?;
    if let Some(dir) = log::dir() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    // 通知用的头像缓存
    if let Ok(dir) = app.path().app_cache_dir() {
        let _ = std::fs::remove_dir_all(dir.join("avatars"));
    }
    let fresh = Data::default();
    data::save(&fresh)?;
    let theme = fresh.settings.theme.clone();
    {
        let state = app.state::<AppState>();
        *state.data.lock().unwrap() = fresh;
        *state.secrets.lock().unwrap() = Secrets::default();
    }
    apply_theme(&app, &theme);
    log::info("data", "wiped", json!({}));
    app.state::<AppState>().hub.restart("wipe");
    tray::refresh(&app);
    notify(&app);
    Ok(())
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
    let dir = log::dir().ok_or("日志目录不可用")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("/usr/bin/open")
        .arg(&dir)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn test_sound(sound: String) {
    alert::play(&sound);
}

#[tauri::command]
fn test_notification(app: tauri::AppHandle) {
    alert::notify(&app, "FoxNudge", "系统通知已开启");
}

/// 前端只上报自己的 warn / error，经同一份脱敏写入日志
#[tauri::command]
fn log_client(level: String, event: String, detail: serde_json::Value) {
    let level = if level == "warn" { "warn" } else { "error" };
    log::write(level, "renderer", &event, detail);
}

fn main() {
    let launched = std::time::Instant::now();
    let hidden = std::env::args().any(|a| a == "--hidden");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show(&handle));
        }))
        .plugin(log::plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ));
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_snapshot,
        save_settings,
        save_identity,
        save_templates,
        reset_templates,
        reset_settings,
        set_secret,
        generate_key,
        send,
        reconnect,
        clear_history,
        set_recent_cleared,
        wipe_data,
        open_logs,
        test_sound,
        test_notification,
        log_client,
        alert::avatar_ready,
        debug::debug_reply,
        debug::debug_inject,
        debug::debug_disconnect,
        debug::debug_clear_mock,
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_snapshot,
        save_settings,
        save_identity,
        save_templates,
        reset_templates,
        reset_settings,
        set_secret,
        generate_key,
        send,
        reconnect,
        clear_history,
        set_recent_cleared,
        wipe_data,
        open_logs,
        test_sound,
        test_notification,
        log_client,
        alert::avatar_ready,
    ]);
    let app = builder
        .setup(move |app| {
            let handle = app.handle().clone();
            log::init(app.path().app_log_dir()?);
            data::init(app.path().app_data_dir()?);
            let data = data::read();
            let _ = data::save(&data);
            let theme = data.settings.theme.clone();
            app.manage(AppState {
                data: Mutex::new(data),
                secrets: Mutex::new(data::read_secrets()),
                hub: ntfy::Hub::default(),
            });
            log::info(
                "main",
                "launch",
                json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "build": if cfg!(debug_assertions) { "dev" } else { "release" },
                    "hidden": hidden,
                }),
            );
            apply_theme(&handle, &theme);
            tray::init(&handle)?;
            ntfy::start(handle.clone());
            #[cfg(debug_assertions)]
            debug::start(&handle);
            if let Some(w) = app.get_webview_window("main") {
                let window = w.clone();
                let handle = handle.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // 关窗只隐藏，菜单栏、订阅和快捷键继续工作
                        api.prevent_close();
                        let _ = window.hide();
                        apply_dock(&handle, false);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("FoxNudge failed to initialize");
    app.run(move |app, event| match event {
        RunEvent::Ready => {
            // 开发版换成方形图标，和安装版区分
            #[cfg(all(debug_assertions, target_os = "macos"))]
            dev_icon();
            log::info("main", "ready", json!({ "ms": launched.elapsed().as_millis() as u64 }));
            if hidden {
                apply_dock(app, false);
            } else {
                show(app);
            }
        }
        RunEvent::Reopen { .. } => show(app),
        RunEvent::Exit => log::info("main", "exit", json!({})),
        _ => {}
    });
}
