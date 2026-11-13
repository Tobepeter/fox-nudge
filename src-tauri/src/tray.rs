//! 菜单栏：连接状态、快捷模板发送、打开主窗口和退出
use crate::{log, AppState};
use serde_json::json;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

const ID: &str = "main";

// 占位图标：已连接是实心圆点，未连接是空心圆环，作为模板图标跟随菜单栏深浅色
fn icon(connected: bool) -> Image<'static> {
    let size = 22usize;
    let mut pixels = vec![0u8; size * size * 4];
    let c = 10.5f32;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let on = if connected { d <= 6.0 } else { (4.2..=6.2).contains(&d) };
            if on {
                pixels[(y * size + x) * 4 + 3] = 255;
            }
        }
    }
    Image::new_owned(pixels, size as u32, size as u32)
}

fn status_text(app: &AppHandle) -> (bool, String) {
    let status = app.state::<AppState>().hub.status.lock().unwrap().clone();
    let text = match status.state.as_str() {
        "connected" => "已连接".to_string(),
        "connecting" => "正在连接…".to_string(),
        "unconfigured" => "未配置服务器".to_string(),
        _ if !status.error.is_empty() => format!("未连接：{}", status.error),
        _ => "未连接".to_string(),
    };
    (status.state == "connected", text)
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
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "status", text, false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &send,
            &MenuItem::with_id(app, "compose", "写消息…", true, None::<&str>)?,
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
        .icon(icon(false))
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
                "quit" => app.exit(0),
                _ => {
                    if let Some(template) = id.strip_prefix("send:") {
                        send_template(app, template.to_string());
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
    let _ = tray.set_icon(Some(icon(connected)));
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(format!("FoxNudge · {text}")));
    if let Ok(menu) = menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}
