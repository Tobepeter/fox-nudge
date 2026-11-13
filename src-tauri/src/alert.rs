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
    let (notify, sound) = settings(app);
    if notify {
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            log::warn("alert", "notification-failed", json!({ "error": e.to_string() }));
        }
    }
    play(&sound);
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
