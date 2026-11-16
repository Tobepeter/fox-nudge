//! 菜单栏：连接状态、快捷模板发送、暂停提醒、打开主窗口和退出
use crate::{log, AppState};
use serde_json::json;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

const ID: &str = "main";
const PAUSE_PRESETS: &[(&str, &str)] = &[("30m", "30 分钟"), ("1h", "1 小时"), ("morning", "到明早 9 点")];

// 菜单栏图标（候选 A，Codex 手写 SVG 导出的 36px 模板图）：已连接实心铃铛，未连接空心铃铛；
// 暂停提醒时叠一道斜杠。系统按 18pt 高度显示，并随菜单栏深浅色自动反色。源文件在 icons/tray/*.svg
fn icon(connected: bool, paused: bool) -> Image<'static> {
    let bytes: &[u8] = match (connected, paused) {
        (true, false) => include_bytes!("../icons/tray/connected.png"),
        (false, false) => include_bytes!("../icons/tray/disconnected.png"),
        (true, true) => include_bytes!("../icons/tray/paused-connected.png"),
        (false, true) => include_bytes!("../icons/tray/paused-disconnected.png"),
    };
    Image::from_bytes(bytes).expect("菜单栏图标").to_owned()
}

fn status_text(app: &AppHandle) -> (bool, String) {
    let status = app.state::<AppState>().hub.status.lock().unwrap().clone();
    (status.state == "connected", connection_label(&status))
}

/// 连接状态文字，菜单栏和命令行共用
pub fn connection_label(status: &crate::ntfy::Connection) -> String {
    match status.state.as_str() {
        "connected" => "已连接".to_string(),
        "connecting" => "正在连接…".to_string(),
        "unconfigured" => "未配置服务器".to_string(),
        _ if !status.error.is_empty() => format!("未连接：{}", status.error),
        _ => "未连接".to_string(),
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let (_, text) = status_text(app);
    let templates = app.state::<AppState>().data.lock().unwrap().templates.clone();
    let send = Submenu::with_id(app, "send", "广播", !templates.is_empty())?;
    for t in &templates {
        let label: String = t.text.chars().take(16).collect();
        let label = if t.text.chars().count() > 16 { format!("{label}…") } else { label };
        send.append(&MenuItem::with_id(app, format!("send:{}", t.id), label, true, None::<&str>)?)?;
    }
    let paused = crate::pause::until(app);
    let title = match paused {
        Some(at) => format!("已暂停提醒至 {}", crate::pause::label(at)),
        None => "暂停提醒".into(),
    };
    let pause = Submenu::with_id(app, "pause", title, true)?;
    if paused.is_some() {
        pause.append(&MenuItem::with_id(app, "resume", "恢复提醒", true, None::<&str>)?)?;
        pause.append(&PredefinedMenuItem::separator(app)?)?;
    }
    for (preset, label) in PAUSE_PRESETS {
        pause.append(&MenuItem::with_id(app, format!("pause:{preset}"), *label, true, None::<&str>)?)?;
    }
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "status", text, false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &send,
            &MenuItem::with_id(app, "compose", "写消息…", true, None::<&str>)?,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "open", "打开 FoxNudge", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?,
            &MenuItem::with_id(app, "reconnect", "重新连接", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出 FoxNudge", true, None::<&str>)?,
        ],
    )
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(icon(false, crate::pause::until(app).is_some()))
        .icon_as_template(true)
        .tooltip("FoxNudge")
        .menu(&menu(app)?)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => crate::show(app),
                "compose" => {
                    crate::show(app);
                    let _ = app.emit("navigate", "send");
                    let _ = app.emit("compose", ());
                }
                "settings" => {
                    crate::show(app);
                    let _ = app.emit("navigate", "settings");
                }
                "reconnect" => app.state::<AppState>().hub.restart("manual"),
                "resume" => {
                    crate::pause::resume(app, "manual");
                }
                "quit" => app.exit(0),
                _ => {
                    if let Some(template) = id.strip_prefix("send:") {
                        send_template(app, template.to_string());
                    } else if let Some(preset) = id.strip_prefix("pause:") {
                        let _ = crate::pause::start(app, preset);
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn send_template(app: &AppHandle, id: String) {
    let template = app
        .state::<AppState>()
        .data
        .lock()
        .unwrap()
        .templates
        .iter()
        .find(|t| t.id == id)
        .cloned();
    let Some(template) = template else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::ntfy::publish(&app, String::new(), template.text).await {
            log::warn("tray", "send-failed", json!({ "reason": e }));
            crate::alert_error(&app, &e);
        }
    });
}

/// 连接状态或模板变化后刷新菜单和图标
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    let (connected, text) = status_text(app);
    let _ = tray.set_icon(Some(icon(connected, crate::pause::until(app).is_some())));
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(format!("FoxNudge · {text}")));
    if let Ok(menu) = menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}
