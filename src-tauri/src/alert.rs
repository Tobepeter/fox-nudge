//! 系统通知和提示音
use crate::{data::Message, log, AppState};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

fn sender(message: &Message) -> String {
    match &message.sender_name {
        Some(name) if !name.trim().is_empty() => name.clone(),
        _ => "未知发送者".into(),
    }
}

fn settings(app: &AppHandle) -> (bool, String) {
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap();
    (data.settings.notify, data.settings.sound.clone())
}

pub fn message(app: &AppHandle, message: &Message) {
    let (title, body) = if message.status == "undecryptable" {
        ("收到一条无法解密的消息".to_string(), "共享密钥和发送方不一致，请在设置里核对".to_string())
    } else if message.title.is_empty() {
        (sender(message), message.body.clone())
    } else {
        (format!("{} · {}", sender(message), message.title), message.body.clone())
    };
    show(app, &title, &body);
}

pub fn backlog(app: &AppHandle, messages: &[Message]) {
    match messages {
        [] => {}
        [one] => message(app, one),
        many => {
            let last = many.last().unwrap();
            let preview = if last.status == "ok" {
                format!("最新一条来自 {}：{}", sender(last), last.body)
            } else {
                "其中有无法解密的消息".into()
            };
            show(app, &format!("离线期间收到 {} 条消息", many.len()), &preview);
        }
    }
}

fn show(app: &AppHandle, title: &str, body: &str) {
    let (enabled, sound) = settings(app);
    if enabled {
        notify(app, title, body);
    }
    play(&sound);
}

/// 弹一条系统通知。
/// 开发版没有 .app 包，通知插件会借用「终端」的身份，终端没有通知授权时系统直接丢弃，
/// 所以开发版改用系统自带的 osascript 弹（显示为「脚本编辑器」）；安装版走插件，用 FoxNudge 自己的身份
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if cfg!(debug_assertions) {
        let (title, body) = (title.to_string(), body.to_string());
        std::thread::spawn(move || {
            // 标题和正文作为参数传入，不拼进脚本，免去转义
            let result = std::process::Command::new("/usr/bin/osascript")
                .args(["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"])
                .args([&title, &body])
                .output();
            match result {
                Ok(out) if out.status.success() => {}
                Ok(out) => log::warn("alert", "notification-failed", json!({ "error": String::from_utf8_lossy(&out.stderr).trim() })),
                Err(e) => log::warn("alert", "notification-failed", json!({ "error": e.to_string() })),
            }
        });
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn("alert", "notification-failed", json!({ "error": e.to_string() }));
    }
}

/// 用系统自带的提示音，afplay 在后台线程里跑完并回收
pub fn play(sound: &str) {
    if sound == "none" || !crate::data::SOUNDS.contains(&sound) {
        return;
    }
    let path = format!("/System/Library/Sounds/{sound}.aiff");
    std::thread::spawn(move || {
        if let Err(e) = std::process::Command::new("/usr/bin/afplay").arg(&path).status() {
            log::warn("alert", "sound-failed", json!({ "error": e.to_string() }));
        }
    });
}
