//! 系统通知和提示音。通知右侧带发送者头像（安装版和 debug 版 .app 才有，tauri dev 的 osascript 不支持图片）
use crate::{data::Message, log, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

/// 等前端画头像的最长时间，超时就不带图照常弹
const AVATAR_WAIT: Duration = Duration::from_secs(1);

fn sender(message: &Message) -> String {
    match &message.sender_name {
        Some(name) if !name.trim().is_empty() => name.clone(),
        _ => "未知发送者".into(),
    }
}

fn settings(app: &AppHandle) -> (bool, String, bool) {
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap();
    (data.settings.notify, data.settings.sound.clone(), data.settings.sound_follow_system)
}

fn audible(sound: &str) -> bool {
    sound != "none" && crate::data::SOUNDS.contains(&sound)
}

fn full_style(app: &AppHandle) -> bool {
    app.state::<AppState>().data.lock().unwrap().settings.notify_style == "full"
}

/// 通知的标题和正文。极简只有消息内容（有标题的消息标题在上、正文在下）；详细的标题是发送者昵称
fn content(message: &Message, full: bool) -> (String, String) {
    if message.status == "undecryptable" {
        return ("收到一条无法解密的消息".into(), "共享密钥和发送方不一致，请在设置里核对".into());
    }
    match (full, message.title.is_empty()) {
        (false, true) => (message.body.clone(), String::new()),
        (false, false) => (message.title.clone(), message.body.clone()),
        (true, true) => (sender(message), message.body.clone()),
        (true, false) => (format!("{} · {}", sender(message), message.title), message.body.clone()),
    }
}

/// 请前端画头像时带的信息，规则和界面上的 <Avatar> 一致
#[derive(Clone, Serialize)]
pub struct AvatarRequest {
    key: String,
    id: Option<String>,
    name: Option<String>,
    avatar: Option<String>,
}

impl AvatarRequest {
    fn of(message: &Message) -> Self {
        let id = message.sender_id.clone();
        let avatar = message.sender_avatar.clone();
        // 名字头像随昵称变化，缓存键里带上昵称的摘要；没有身份的统一用一个机器人头像
        let name_part = if avatar.as_deref() == Some("name") {
            let mut h: u32 = 2166136261;
            for b in message.sender_name.as_deref().unwrap_or_default().bytes() {
                h = (h ^ b as u32).wrapping_mul(16777619);
            }
            format!("-{h:08x}")
        } else {
            String::new()
        };
        let key = match &id {
            None => "unknown".to_string(),
            Some(id) => format!("{}-{}{}", avatar.as_deref().unwrap_or("auto"), id, name_part),
        };
        // 缓存键只留文件名安全的字符
        let key = key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        Self { key, id, name: message.sender_name.clone(), avatar }
    }
}

pub fn message(app: &AppHandle, message: &Message) {
    let full = full_style(app);
    let (title, body) = content(message, full);
    show(app, &title, &body, full.then(|| AvatarRequest::of(message)));
}

/// 一批错过的消息合并成一条提醒，when：离线期间、暂停期间
pub fn batch(app: &AppHandle, when: &str, messages: &[Message]) {
    match messages {
        [] => {}
        [one] => message(app, one),
        many => {
            let last = many.last().unwrap();
            let full = full_style(app);
            let preview = match (last.status == "ok", full) {
                (false, _) => "其中有无法解密的消息".to_string(),
                (true, true) => format!("最新一条来自 {}：{}", sender(last), last.body),
                (true, false) => format!("最新一条：{}", last.body),
            };
            show(app, &format!("{when}收到 {} 条消息", many.len()), &preview, full.then(|| AvatarRequest::of(last)));
        }
    }
}

/// 提示音跟随系统时交给通知一起播放，系统压掉通知（专注模式、共享屏幕等）就一起不响；
/// 不跟随或关了应用内通知时由 FoxNudge 立即播放。通知在后台线程里取到头像（或超时）后再弹，不卡接收流程
fn show(app: &AppHandle, title: &str, body: &str, avatar: Option<AvatarRequest>) {
    let (enabled, sound, follow) = settings(app);
    let with_notification = enabled && follow && audible(&sound);
    if !with_notification {
        play(&sound);
    }
    if !enabled {
        return;
    }
    let (app, title, body) = (app.clone(), title.to_string(), body.to_string());
    std::thread::spawn(move || {
        let image = avatar.filter(|_| !tauri::is_dev()).and_then(|a| avatar_path(&app, a));
        notify_with(&app, &title, &body, image, with_notification.then_some(sound));
    });
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let (app, title, body) = (app.clone(), title.to_string(), body.to_string());
    std::thread::spawn(move || notify_with(&app, &title, &body, None, None));
}

/// 弹一条系统通知。
/// tauri dev 没有 .app 包，通知插件会借用「终端」的身份，终端没有通知授权时系统直接丢弃，
/// 所以 tauri dev 改用系统自带的 osascript 弹（显示为「脚本编辑器」，不支持图片）；
/// 安装版和 debug 版 .app 用新版 UNUserNotificationCenter（mac-usernotifications），右侧能带头像图片
/// sound：随通知播放的系统音效名，None 表示通知不带声音
fn notify_with(app: &AppHandle, title: &str, body: &str, image: Option<PathBuf>, sound: Option<String>) {
    if tauri::is_dev() {
        // 标题、正文、音效作为参数传入，不拼进脚本，免去转义；音效为空时不带声音
        let script = [
            "on run argv",
            "if item 3 of argv is \"\" then",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "else",
            "display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)",
            "end if",
            "end run",
        ];
        let result = std::process::Command::new("/usr/bin/osascript")
            .args(script.iter().flat_map(|line| ["-e", line]))
            .args([title, body, sound.as_deref().unwrap_or("")])
            .output();
        match result {
            Ok(out) if out.status.success() => {}
            Ok(out) => log::warn("alert", "notification-failed", json!({ "error": String::from_utf8_lossy(&out.stderr).trim() })),
            Err(e) => log::warn("alert", "notification-failed", json!({ "error": e.to_string() })),
        }
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let mut notification = mac_usernotifications::Notification::new().title(title).message(body);
        if let Some(path) = image.as_ref().and_then(|p| p.to_str()) {
            notification = notification.image_path(path);
        }
        if let Some(sound) = &sound {
            notification = notification.sound(sound.as_str());
        }
        // 用异步的 send：它的阻塞写法会检查主线程事件循环是否空闲，Tauri 主循环忙时会误判失败
        if let Err(e) = tauri::async_runtime::block_on(mac_usernotifications::send(notification)) {
            log::warn("alert", "notification-failed", json!({ "error": e.to_string() }));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = (image, sound);
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            log::warn("alert", "notification-failed", json!({ "error": e.to_string() }));
        }
    }
}

// —— 头像缓存：app 缓存目录下 avatars/<key>.png；没有就请前端画，最多等 1 秒 ——

fn waiters() -> &'static Mutex<HashMap<String, Vec<mpsc::Sender<()>>>> {
    static WAITERS: OnceLock<Mutex<HashMap<String, Vec<mpsc::Sender<()>>>>> = OnceLock::new();
    WAITERS.get_or_init(Default::default)
}

fn cache_file(app: &AppHandle, key: &str) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("avatars").join(format!("{key}.png")))
}

fn avatar_path(app: &AppHandle, request: AvatarRequest) -> Option<PathBuf> {
    let path = cache_file(app, &request.key)?;
    if path.exists() {
        return Some(path);
    }
    let (send, receive) = mpsc::channel();
    waiters().lock().unwrap().entry(request.key.clone()).or_default().push(send);
    let _ = app.emit("avatar-request", &request);
    let _ = receive.recv_timeout(AVATAR_WAIT);
    if path.exists() {
        Some(path)
    } else {
        log::warn("alert", "avatar-timeout", json!({ "key": request.key }));
        None
    }
}

/// 前端画好头像后回传 PNG（base64），写进缓存并唤醒等待的通知
#[tauri::command]
pub fn avatar_ready(app: AppHandle, key: String, png: String) -> Result<(), String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("头像缓存键不合法".into());
    }
    let bytes = STANDARD.decode(png.trim()).map_err(|e| e.to_string())?;
    let path = cache_file(&app, &key).ok_or("缓存目录不可用")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    for send in waiters().lock().unwrap().remove(&key).unwrap_or_default() {
        let _ = send.send(());
    }
    Ok(())
}

// —— 通知权限：新版接口能查状态、触发系统的「是否允许」弹窗；tauri dev 没有应用包，用不了 ——

/// unsupported（tauri dev）/ notDetermined / denied / authorized
#[tauri::command]
pub async fn notification_status() -> String {
    if tauri::is_dev() {
        return "unsupported".into();
    }
    #[cfg(target_os = "macos")]
    {
        use mac_usernotifications::AuthorizationStatus as S;
        return match mac_usernotifications::get_notification_settings().await {
            Ok(settings) => match settings.authorization_status {
                S::NotDetermined => "notDetermined",
                S::Denied => "denied",
                _ => "authorized",
            }
            .into(),
            Err(e) => {
                log::warn("alert", "permission-status-failed", json!({ "error": e.to_string() }));
                "unsupported".into()
            }
        };
    }
    #[allow(unreachable_code)]
    "authorized".into()
}

/// 触发系统的「是否允许」弹窗；系统只问一次，之后只能去系统设置里改
#[tauri::command]
pub async fn request_notifications() -> String {
    #[cfg(target_os = "macos")]
    if !tauri::is_dev() {
        match mac_usernotifications::request_auth().await {
            Ok(granted) => log::info("alert", "permission-requested", json!({ "granted": granted })),
            Err(e) => log::warn("alert", "permission-request-failed", json!({ "error": e.to_string() })),
        }
    }
    notification_status().await
}

/// 打开系统设置里 FoxNudge 的通知设置
#[tauri::command]
pub fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    let url = format!("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={}", app.config().identifier);
    std::process::Command::new("/usr/bin/open").arg(url).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// 按当前通知样式发一条预览，用自己的昵称和头像，连提示音一起
#[tauri::command]
pub fn preview_notification(app: AppHandle) {
    let (identity, avatar) = {
        let state = app.state::<AppState>();
        let data = state.data.lock().unwrap();
        (data.identity.clone(), data.settings.avatar_style.clone())
    };
    let sample = Message {
        id: "preview".into(),
        time: chrono::Utc::now().timestamp(),
        title: String::new(),
        body: "这是一条预览消息".into(),
        sender_id: Some(identity.id),
        sender_name: Some(identity.name),
        sender_avatar: Some(avatar),
        to_self: false,
        mine: false,
        encrypted: true,
        status: "ok".into(),
    };
    message(&app, &sample);
}

/// 用系统自带的提示音，afplay 在后台线程里跑完并回收
pub fn play(sound: &str) {
    if !audible(sound) {
        return;
    }
    let path = format!("/System/Library/Sounds/{sound}.aiff");
    std::thread::spawn(move || {
        if let Err(e) = std::process::Command::new("/usr/bin/afplay").arg(&path).status() {
            log::warn("alert", "sound-failed", json!({ "error": e.to_string() }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn msg(id: Option<&str>, name: Option<&str>, avatar: Option<&str>) -> Message {
        Message {
            id: "m".into(),
            time: 0,
            title: String::new(),
            body: String::new(),
            sender_id: id.map(String::from),
            sender_name: name.map(String::from),
            sender_avatar: avatar.map(String::from),
            to_self: false,
            mine: false,
            encrypted: true,
            status: "ok".into(),
        }
    }
    #[test]
    fn minimal_shows_only_content() {
        let mut m = msg(Some("abc"), Some("小明"), Some("lorelei"));
        m.body = "吃饭啦".into();
        assert_eq!(content(&m, false), ("吃饭啦".to_string(), String::new()));
        assert_eq!(content(&m, true), ("小明".to_string(), "吃饭啦".to_string()));
        m.title = "提醒".into();
        assert_eq!(content(&m, false), ("提醒".to_string(), "吃饭啦".to_string()));
        assert_eq!(content(&m, true), ("小明 · 提醒".to_string(), "吃饭啦".to_string()));
    }
    #[test]
    fn avatar_keys_are_file_safe_and_track_names() {
        assert_eq!(AvatarRequest::of(&msg(None, None, None)).key, "unknown");
        assert_eq!(AvatarRequest::of(&msg(Some("abc"), Some("x"), Some("lorelei"))).key, "lorelei-abc");
        let a = AvatarRequest::of(&msg(Some("abc"), Some("小明"), Some("name"))).key;
        let b = AvatarRequest::of(&msg(Some("abc"), Some("小红"), Some("name"))).key;
        assert_ne!(a, b, "名字头像随昵称变化");
        let odd = AvatarRequest::of(&msg(Some("a/../b"), None, Some("x y"))).key;
        assert!(odd.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
