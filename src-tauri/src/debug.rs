//! DEV 调试：本机探针 HTTP 入口和模拟收消息，正式构建不编译
use crate::{crypto, ntfy, AppState};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 5193;
static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<Value>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<Value>>> {
    PENDING.get_or_init(Default::default)
}

/// scripts/probe.mjs 把表达式 POST 到这里，在主窗口里求值后返回 JSON；d 指代 window.__DEBUG__
pub fn start(app: &AppHandle) {
    let port = std::env::var("FOX_NUDGE_PROBE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[probe] 端口 {port} 不可用：{e}");
            return;
        }
    };
    eprintln!("[probe] http://127.0.0.1:{port}/eval");
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = handle(&app, stream);
            });
        }
    });
}

fn handle(app: &AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header.trim().is_empty() {
            break;
        }
        if let Some(v) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length.min(1 << 20)];
    reader.read_exact(&mut body)?;
    let result = if line.starts_with("POST /eval") {
        evaluate(app, &String::from_utf8_lossy(&body))
    } else {
        json!({ "ok": false, "error": "只支持 POST /eval" })
    };
    let text = result.to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        text.len(),
        text
    )
}

fn evaluate(app: &AppHandle, expression: &str) -> Value {
    let Some(window) = app.get_webview_window("main") else {
        return json!({ "ok": false, "error": "主窗口不存在" });
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (send, receive) = mpsc::channel();
    pending().lock().unwrap().insert(id.clone(), send);
    let script = format!(
        r#"(async () => {{
  const id = {id:?}
  const d = window.__DEBUG__
  let reply
  try {{
    const value = await ({expression}
)
    reply = {{ id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }}
  }} catch (e) {{
    reply = {{ id, ok: false, error: String(e) + (e && e.stack ? '\n' + e.stack : '') }}
  }}
  window.__TAURI_INTERNALS__.invoke('debug_reply', {{ reply }})
}})()"#
    );
    if let Err(e) = window.eval(&script) {
        pending().lock().unwrap().remove(&id);
        return json!({ "ok": false, "error": e.to_string() });
    }
    let result = receive
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or_else(|_| json!({ "ok": false, "error": "等待页面返回超时，页面可能还没加载或表达式没有结束" }));
    pending().lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn debug_reply(reply: Value) {
    let id = reply["id"].as_str().unwrap_or_default().to_string();
    if let Some(send) = pending().lock().unwrap().remove(&id) {
        let _ = send.send(reply);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inject {
    #[serde(default)]
    title: String,
    body: String,
    #[serde(default)]
    sender_name: Option<String>,
    /// 不同发送者用不同 ID，头像才会不同
    #[serde(default)]
    sender_id: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    /// 像 curl 发的一样不带身份
    #[serde(default)]
    anonymous: bool,
    /// 多少秒之前收到，用来铺开历史时间
    #[serde(default)]
    ago: Option<i64>,
    /// 不弹通知不响，填充示例历史用
    #[serde(default)]
    silent: bool,
    #[serde(default)]
    encrypted: bool,
    /// 当作离线期间补收的消息，走合并提醒
    #[serde(default)]
    backlog: bool,
    /// 用一个错的密钥加密，模拟密钥不一致
    #[serde(default)]
    wrong_key: bool,
}

/// 模拟收到一条消息，走和真实订阅相同的去重、存盘、提醒流程
#[tauri::command]
pub fn debug_inject(app: AppHandle, message: Inject) -> Result<String, String> {
    let id = format!("debug-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let now = chrono::Utc::now().timestamp();
    let name = message.sender_name.unwrap_or_else(|| "调试".into());
    let sender_id = message.sender_id.unwrap_or_else(|| "debug-sender".into());
    let avatar = message.avatar.unwrap_or_default();
    let tags = if message.anonymous || message.encrypted || message.wrong_key {
        vec![]
    } else {
        // 和真实明文消息一样把发送者放在标签里
        vec![
            "fn1".to_string(),
            format!("fnid-{sender_id}"),
            format!("fnname-{}", B64.encode(&name)),
            format!("fnav-{avatar}"),
        ]
    };
    let text = if message.encrypted || message.wrong_key {
        let key = if message.wrong_key {
            "wrong-key".to_string()
        } else {
            ntfy::active_key(&app).ok_or("还没有共享密钥")?
        };
        crypto::seal(
            &key,
            &crypto::Payload {
                v: 1,
                from: crypto::Sender { id: sender_id, name, avatar },
                title: message.title,
                body: message.body,
            },
        )?
    } else {
        message.body
    };
    let event = json!({
        "id": id,
        "time": now - message.ago.unwrap_or(if message.backlog { 600 } else { 0 }),
        "event": "message",
        "message": text,
        "title": "",
        "tags": tags,
    });
    ntfy::receive(&app, &event, message.backlog, false, !message.silent);
    Ok(id)
}

/// 模拟断线，验证重连
#[tauri::command]
pub fn debug_disconnect(app: AppHandle) {
    app.state::<AppState>().hub.restart("debug");
}

/// 一次填满历史，看内容最多时的样子：分布在过去 30 天，多个发送者，含自己发的；静默、只写一次盘
#[tauri::command]
pub fn debug_fill_history(app: AppHandle, count: usize) -> usize {
    use rand::Rng;
    let state = app.state::<AppState>();
    let mut data = state.data.lock().unwrap();
    let me = data.identity.clone();
    let my_avatar = data.settings.avatar_style.clone();
    // 含昵称上限（16 个字）的发送者，看名字列怎么截断
    let senders = [
        ("debug-xiaoming", "小明", "name"),
        ("debug-ahu", "阿狐", "openPeeps"),
        ("debug-lucy", "Lucy", "notionists"),
        ("debug-tobe", "tobe", "lorelei"),
        ("debug-long-cn", "欧阳慕容东方西门北冥南宫上官司马", "name"),
        ("debug-long-en", "Alexander Wright", "adventurer"),
    ];
    // 正文上限 500 字、文案上限 100 字的样例
    let longest = "这是一条写满 500 字的消息，用来看历史和悬停提示在内容最长时的样子。".repeat(20).chars().take(crate::data::BODY_LIMIT).collect::<String>();
    let medium = "这条刚好一百个字，和文案的长度上限一样，用来看最近发过和文案两边在内容最长时怎么截断。".repeat(3).chars().take(crate::data::TEMPLATE_TEXT_LIMIT).collect::<String>();
    let texts = [
        "叮", "来一下", "吃饭啦", "好了", "收到", "马上到", "在吗", "下午三点开会别忘了", "构建完成，可以看了",
        "帮我看下这个报错", "今天早点走", "快递到了", "喝水", "会议改到明天上午", "这是一条比较长的消息，用来看历史里一行放不下的时候怎么截断显示，后面还有很多字",
    ];
    let now = chrono::Utc::now().timestamp();
    let span = crate::data::HISTORY_DAYS * 24 * 3600 - 3600;
    let mut rng = rand::thread_rng();
    for i in 0..count {
        let text = match rng.gen_range(0..20) {
            0 => longest.clone(),
            1 => medium.clone(),
            _ => texts[rng.gen_range(0..texts.len())].to_string(),
        };
        let roll = rng.gen_range(0..10);
        let (sender_id, sender_name, avatar, mine) = match roll {
            0..=2 => (Some(me.id.clone()), Some(me.name.clone()), Some(my_avatar.clone()), true),
            3 => (None, None, None, false),
            _ => {
                let (id, name, avatar) = senders[rng.gen_range(0..senders.len())];
                (Some(id.to_string()), Some(name.to_string()), Some(avatar.to_string()), false)
            }
        };
        data.push_message(crate::data::Message {
            id: format!("debug-fill-{}-{i}", &uuid::Uuid::new_v4().simple().to_string()[..6]),
            time: now - rng.gen_range(60..span),
            title: String::new(),
            body: text,
            sender_id,
            sender_name,
            sender_avatar: avatar,
            mine,
            encrypted: true,
            status: "ok".into(),
        });
    }
    let total = data.messages.len();
    let _ = crate::data::save(&data);
    drop(data);
    crate::notify(&app);
    total
}
