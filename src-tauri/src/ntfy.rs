//! ntfy 订阅与发送：长连接 JSON 流为主，轮询备选；断线指数退避重连，带 since 补收
use crate::{
    crypto::{self, Payload, Sender},
    data::{Identity, Message},
    log, AppState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

/// ntfy 默认 45 秒一次心跳，超过这个时间没有任何数据就当作断线
const STALL: Duration = Duration::from_secs(110);
const BACKLOG_GRACE_SECONDS: i64 = 5;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Connection {
    /// unconfigured / connecting / connected / waiting
    pub state: String,
    pub mode: String,
    pub connected_at: Option<i64>,
    pub last_event_at: Option<i64>,
    pub attempts: u32,
    pub retry_at: Option<i64>,
    pub error: String,
}

pub struct Hub {
    pub status: Mutex<Connection>,
    restart: watch::Sender<u64>,
    backlog: Mutex<Vec<Message>>,
    throttle: Mutex<crate::throttle::Throttle>,
    client: reqwest::Client,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            status: Mutex::new(Connection {
                state: "connecting".into(),
                ..Default::default()
            }),
            restart: watch::channel(0).0,
            backlog: Mutex::new(vec![]),
            throttle: Mutex::default(),
            client: reqwest::Client::builder()
                .user_agent(concat!("FoxNudge/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP 客户端"),
        }
    }
}
impl Hub {
    /// 设置变化、手动重连、睡眠唤醒都通过它让订阅重新开始
    pub fn restart(&self, reason: &str) {
        log::info("ntfy", "restart", json!({ "reason": reason }));
        self.restart.send_modify(|g| *g += 1);
    }
}

#[derive(Clone)]
struct Config {
    server: String,
    topic: String,
    token: String,
    mode: String,
    poll_seconds: u32,
}

/// 构建时注入的默认地址、主题（来自 sops 解密出的 .env）；解不开就没有，用户自己填
pub fn builtin_server() -> Option<&'static str> {
    option_env!("FOX_NUDGE_DEFAULT_SERVER").map(|s| s.trim().trim_end_matches('/')).filter(|s| !s.is_empty())
}
pub fn builtin_topic() -> Option<&'static str> {
    option_env!("FOX_NUDGE_DEFAULT_TOPIC").map(str::trim).filter(|s| !s.is_empty())
}

/// 构建时注入的默认访问令牌（来自 sops 解密出的 .env），设置里填了就用设置里的
pub fn builtin_token() -> Option<&'static str> {
    option_env!("FOX_NUDGE_DEFAULT_TOKEN").filter(|t| !t.trim().is_empty())
}

pub fn active_token(app: &AppHandle) -> String {
    let custom = app.state::<AppState>().secrets.lock().unwrap().token.clone();
    if !custom.trim().is_empty() {
        return custom;
    }
    builtin_token().unwrap_or_default().to_string()
}

fn config(app: &AppHandle) -> Option<Config> {
    let token = active_token(app);
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap();
    let s = &data.settings;
    let pick = |custom: &str, builtin: Option<&str>| {
        Some(custom).filter(|c| !c.is_empty()).or(builtin).map(String::from)
    };
    let server = pick(&s.server, builtin_server())?;
    let topic = pick(&s.topic, builtin_topic())?;
    Some(Config {
        server,
        topic,
        token,
        mode: s.mode.clone(),
        poll_seconds: s.poll_seconds,
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn set_status(app: &AppHandle, update: impl FnOnce(&mut Connection)) {
    let hub = &app.state::<AppState>().hub;
    let next = {
        let mut status = hub.status.lock().unwrap();
        let before = status.clone();
        update(&mut status);
        if *status == before {
            return;
        }
        status.clone()
    };
    let _ = app.emit("connection", &next);
    crate::tray::refresh(app);
}

enum Failure {
    Auth(String),
    Other(String),
}
impl Failure {
    fn text(&self) -> &str {
        match self {
            Failure::Auth(s) | Failure::Other(s) => s,
        }
    }
}

fn backoff(attempts: u32, auth: bool) -> Duration {
    if auth {
        // 令牌错了重试也没用，放慢，等用户改设置
        return Duration::from_secs(300);
    }
    let base = 2u64.saturating_pow(attempts.min(6)).min(60);
    let jitter = rand::random::<u64>() % 1000;
    Duration::from_millis(base * 1000 + jitter)
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(worker(app.clone()));
    // 睡眠时单调时钟停走，醒来后用墙钟差值发现，立即重连
    std::thread::spawn(move || {
        let tick = Duration::from_secs(5);
        let mut wall = SystemTime::now();
        let mut mono = Instant::now();
        loop {
            std::thread::sleep(tick);
            let wall_gap = wall.elapsed().unwrap_or_default();
            let mono_gap = mono.elapsed();
            wall = SystemTime::now();
            mono = Instant::now();
            if wall_gap > mono_gap + Duration::from_secs(20) {
                log::info("ntfy", "wake-detected", json!({ "slept_s": (wall_gap - mono_gap).as_secs() }));
                app.state::<AppState>().hub.restart("wake");
            }
        }
    });
}

async fn worker(app: AppHandle) {
    let mut restart = app.state::<AppState>().hub.restart.subscribe();
    let mut attempts: u32 = 0;
    loop {
        restart.borrow_and_update();
        let Some(cfg) = config(&app) else {
            set_status(&app, |s| {
                *s = Connection {
                    state: "unconfigured".into(),
                    ..Default::default()
                }
            });
            let _ = restart.changed().await;
            continue;
        };
        set_status(&app, |s| {
            s.state = "connecting".into();
            s.mode = cfg.mode.clone();
            s.retry_at = None;
            s.attempts = attempts;
        });
        let failure = tokio::select! {
            failure = run(&app, &cfg, &mut attempts) => failure,
            _ = restart.changed() => {
                attempts = 0;
                continue;
            }
        };
        attempts += 1;
        let auth = matches!(failure, Failure::Auth(_));
        let delay = backoff(attempts, auth);
        log::warn(
            "ntfy",
            "disconnected",
            json!({ "reason": failure.text(), "attempt": attempts, "retry_ms": delay.as_millis() as u64 }),
        );
        set_status(&app, |s| {
            s.state = "waiting".into();
            s.connected_at = None;
            s.attempts = attempts;
            s.error = failure.text().to_string();
            s.retry_at = Some(now_ms() + delay.as_millis() as i64);
        });
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = restart.changed() => { attempts = 0; }
        }
    }
}

fn since(app: &AppHandle, fallback: Option<i64>) -> Option<String> {
    let last = app.state::<AppState>().data.lock().unwrap().last_id.clone();
    last.or(fallback.map(|t| t.to_string()))
}

fn request(app: &AppHandle, cfg: &Config, path: &str) -> reqwest::RequestBuilder {
    let hub = &app.state::<AppState>().hub;
    let mut req = hub
        .client
        .get(format!("{}/{}/json{}", cfg.server, cfg.topic, path));
    if !cfg.token.is_empty() {
        req = req.bearer_auth(&cfg.token);
    }
    req
}

/// 服务器不认补收游标（ID 过期或不合法）时返回 400：清掉游标，下次不带 since 重连
fn check_cursor(app: &AppHandle, status: reqwest::StatusCode) {
    if status.as_u16() != 400 {
        return;
    }
    let state = app.state::<AppState>();
    let mut data = state.data.lock().unwrap();
    if data.last_id.take().is_some() {
        let _ = crate::data::save(&data);
        log::warn("ntfy", "cursor-reset", json!({ "status": 400 }));
    }
}

fn status_failure(status: reqwest::StatusCode) -> Failure {
    match status.as_u16() {
        401 | 403 => Failure::Auth("令牌无效，或没有这个主题的权限".into()),
        429 => Failure::Other("请求太频繁，被服务器限流".into()),
        code => Failure::Other(format!("服务器返回 {code}")),
    }
}

fn network_failure(e: reqwest::Error) -> Failure {
    let text = if e.is_connect() {
        "连不上服务器".to_string()
    } else if e.is_timeout() {
        "连接超时".to_string()
    } else {
        format!("网络错误：{}", log::redact_text(&e.to_string()))
    };
    Failure::Other(text)
}

async fn run(app: &AppHandle, cfg: &Config, attempts: &mut u32) -> Failure {
    if cfg.mode == "poll" {
        return poll(app, cfg, attempts).await;
    }
    let path = match since(app, None) {
        Some(id) => format!("?since={id}"),
        None => String::new(),
    };
    log::info("ntfy", "connecting", json!({ "mode": "stream", "since_set": !path.is_empty() }));
    let response = match request(app, cfg, &path).send().await {
        Ok(r) => r,
        Err(e) => return network_failure(e),
    };
    if !response.status().is_success() {
        check_cursor(app, response.status());
        return status_failure(response.status());
    }
    let connected = chrono::Utc::now().timestamp();
    *attempts = 0;
    log::info("ntfy", "connected", json!({ "mode": "stream" }));
    set_status(app, |s| {
        s.state = "connected".into();
        s.connected_at = Some(now_ms());
        s.last_event_at = Some(now_ms());
        s.attempts = 0;
        s.error.clear();
        s.retry_at = None;
    });
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = vec![];
    loop {
        let chunk = match tokio::time::timeout(STALL, stream.next()).await {
            Err(_) => return Failure::Other("长时间没有心跳".into()),
            Ok(None) => return Failure::Other("连接被服务器关闭".into()),
            Ok(Some(Err(e))) => return network_failure(e),
            Ok(Some(Ok(chunk))) => chunk,
        };
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let Ok(event) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            set_status(app, |s| s.last_event_at = Some(now_ms() / 10_000 * 10_000));
            if event["event"] == "message" {
                let backlog = event["time"].as_i64().unwrap_or(0) < connected - BACKLOG_GRACE_SECONDS;
                receive(app, &event, backlog, true, true);
            }
        }
    }
}

async fn poll(app: &AppHandle, cfg: &Config, attempts: &mut u32) -> Failure {
    let started = chrono::Utc::now().timestamp();
    let mut first = true;
    loop {
        let since = since(app, Some(started)).unwrap_or_else(|| started.to_string());
        let response = match request(app, cfg, &format!("?poll=1&since={since}"))
            .timeout(Duration::from_secs(20))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return network_failure(e),
        };
        if !response.status().is_success() {
            check_cursor(app, response.status());
            return status_failure(response.status());
        }
        let text = match response.text().await {
            Ok(t) => t,
            Err(e) => return network_failure(e),
        };
        *attempts = 0;
        if first {
            log::info("ntfy", "connected", json!({ "mode": "poll", "interval_s": cfg.poll_seconds }));
        }
        set_status(app, |s| {
            s.state = "connected".into();
            if s.connected_at.is_none() {
                s.connected_at = Some(now_ms());
            }
            s.last_event_at = Some(now_ms());
            s.attempts = 0;
            s.error.clear();
            s.retry_at = None;
        });
        let events: Vec<Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        for event in events.iter().filter(|e| e["event"] == "message") {
            // 首轮补收的是离线期间的消息，合并成一条提醒
            receive(app, event, first, true, true);
        }
        first = false;
        tokio::time::sleep(Duration::from_secs(cfg.poll_seconds as u64)).await;
    }
}

pub fn decode(event: &Value, identity: &Identity, key: Option<&str>) -> Option<Message> {
    if event["event"] != "message" {
        return None;
    }
    let id = event["id"].as_str()?.to_string();
    let time = event["time"].as_i64().unwrap_or_else(|| chrono::Utc::now().timestamp());
    let text = event["message"].as_str().unwrap_or_default();
    if crypto::is_sealed(text) {
        let opened = key.and_then(|k| crypto::open(k, text));
        return Some(match opened {
            Some(p) => Message {
                id,
                time,
                title: p.title,
                body: p.body,
                mine: p.from.id == identity.id,
                sender_id: Some(p.from.id),
                sender_name: Some(p.from.name),
                sender_avatar: Some(p.from.avatar).filter(|a| !a.is_empty()),
                encrypted: true,
                status: "ok".into(),
            },
            None => Message {
                id,
                time,
                title: String::new(),
                body: String::new(),
                sender_id: None,
                sender_name: None,
                sender_avatar: None,
                mine: false,
                encrypted: true,
                status: "undecryptable".into(),
            },
        });
    }
    let tags: Vec<&str> = event["tags"]
        .as_array()
        .map(|t| t.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let tag = |prefix: &str| tags.iter().find_map(|t| t.strip_prefix(prefix)).map(String::from);
    let sender_id = tag("fnid-");
    let sender_name = tag("fnname-")
        .and_then(|n| B64.decode(n).ok())
        .and_then(|b| String::from_utf8(b).ok());
    let sender_avatar = tag("fnav-");
    Some(Message {
        id,
        time,
        title: event["title"].as_str().unwrap_or_default().to_string(),
        body: text.to_string(),
        mine: sender_id.as_deref() == Some(identity.id.as_str()),
        sender_id,
        sender_name,
        sender_avatar,
        encrypted: false,
        status: "ok".into(),
    })
}

pub fn active_key(app: &AppHandle) -> Option<String> {
    let custom = app.state::<AppState>().secrets.lock().unwrap().key.clone();
    if !custom.trim().is_empty() {
        return Some(custom);
    }
    crypto::builtin_key().map(String::from)
}

/// 收到的消息统一从这里进：去重、存盘、通知界面、提醒
/// cursor：是否把这条记为补收游标；模拟消息不是服务器上的 ID，不能当游标
/// alert：是否提醒；调试填充示例历史时关掉
pub fn receive(app: &AppHandle, event: &Value, backlog: bool, cursor: bool, alert: bool) {
    let state = app.state::<AppState>();
    let key = active_key(app);
    let message = {
        let identity = state.data.lock().unwrap().identity.clone();
        decode(event, &identity, key.as_deref())
    };
    let Some(message) = message else { return };
    let added = {
        let mut data = state.data.lock().unwrap();
        if cursor {
            data.last_id = Some(message.id.clone());
        }
        let added = data.push_message(message.clone());
        let _ = crate::data::save(&data);
        added
    };
    if !added {
        // 自己发的消息经订阅回来了，说明收发链路是通的
        if message.mine {
            let _ = app.emit("echo", &message.id);
        }
        return;
    }
    log::info(
        "message",
        "received",
        json!({
            "messageId": message.id,
            "encrypted": message.encrypted,
            "status": message.status,
            "mine": message.mine,
            "backlog": backlog,
        }),
    );
    if message.status == "undecryptable" {
        log::warn("message", "undecryptable", json!({ "messageId": message.id }));
    }
    let _ = app.emit("message", &message);
    crate::notify(app);
    if message.mine || !alert {
        return;
    }
    if backlog {
        let first = {
            let mut pending = state.hub.backlog.lock().unwrap();
            pending.push(message);
            pending.len() == 1
        };
        if first {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let pending = std::mem::take(&mut *app.state::<AppState>().hub.backlog.lock().unwrap());
                crate::alert::backlog(&app, &pending);
            });
        }
    } else {
        crate::alert::message(app, &message);
    }
}

pub async fn publish(app: &AppHandle, title: String, body: String) -> Result<Message, String> {
    let body = body.trim().to_string();
    let title = title.trim().to_string();
    if body.is_empty() {
        return Err("消息不能为空".into());
    }
    if body.chars().count() > crate::data::BODY_LIMIT {
        return Err(format!("消息最长 {} 个字", crate::data::BODY_LIMIT));
    }
    let cfg = config(app).ok_or("请先在设置里填写服务器和主题")?;
    // 客户端节流：连发几条后冷却逐级加长，界面只提示不显示时间
    if let Err(wait) = app.state::<AppState>().hub.throttle.lock().unwrap().check(Instant::now()) {
        log::warn("message", "throttled", json!({ "wait_ms": wait.as_millis() as u64 }));
        return Err("发得太快了，稍后再试".into());
    }
    let (identity, encrypt, avatar) = {
        let state = app.state::<AppState>();
        let data = state.data.lock().unwrap();
        (data.identity.clone(), data.settings.encrypt, data.settings.avatar_style.clone())
    };
    let request = if encrypt {
        let key = active_key(app).ok_or("加密已开启，但还没有共享密钥，请在设置里填写")?;
        let sealed = crypto::seal(
            &key,
            &Payload {
                v: 1,
                from: Sender { id: identity.id.clone(), name: identity.name.clone(), avatar: avatar.clone() },
                title: title.clone(),
                body: body.clone(),
            },
        )?;
        json!({ "topic": cfg.topic, "message": sealed, "tags": ["fnx1"] })
    } else {
        let mut value = json!({
            "topic": cfg.topic,
            "message": body,
            "tags": [
                "fn1",
                format!("fnid-{}", identity.id),
                format!("fnname-{}", B64.encode(&identity.name)),
                format!("fnav-{avatar}"),
            ],
        });
        if !title.is_empty() {
            value["title"] = json!(title);
        }
        value
    };
    let hub = &app.state::<AppState>().hub;
    let mut req = hub
        .client
        .post(format!("{}/", cfg.server))
        .timeout(Duration::from_secs(15))
        .json(&request);
    if !cfg.token.is_empty() {
        req = req.bearer_auth(&cfg.token);
    }
    let response = req.send().await.map_err(|e| {
        let failure = network_failure(e);
        log::warn("message", "send-failed", json!({ "reason": failure.text() }));
        failure.text().to_string()
    })?;
    if !response.status().is_success() {
        let failure = status_failure(response.status());
        log::warn("message", "send-failed", json!({ "reason": failure.text() }));
        return Err(failure.text().to_string());
    }
    let event: Value = response.json().await.map_err(|e| e.to_string())?;
    let key = active_key(app);
    let message = decode(&event, &identity, key.as_deref()).ok_or("服务器返回的消息无法识别")?;
    log::info("message", "sent", json!({ "messageId": message.id, "encrypted": encrypt }));
    {
        let state = app.state::<AppState>();
        let mut data = state.data.lock().unwrap();
        data.push_message(message.clone());
        let _ = crate::data::save(&data);
    }
    crate::notify(app);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn me() -> Identity {
        Identity { id: "me123".into(), name: "tobe".into() }
    }
    #[test]
    fn decodes_sealed_messages() {
        let sealed = crypto::seal(
            "k",
            &Payload { v: 1, from: Sender { id: "me123".into(), name: "tobe".into(), avatar: "ring".into() }, title: "t".into(), body: "b".into() },
        )
        .unwrap();
        let event = json!({ "id": "x1", "time": 10, "event": "message", "message": sealed });
        let m = decode(&event, &me(), Some("k")).unwrap();
        assert!(m.mine && m.encrypted && m.status == "ok" && m.body == "b");
        assert_eq!(m.sender_avatar.as_deref(), Some("ring"));
        let m = decode(&event, &me(), Some("other")).unwrap();
        assert_eq!(m.status, "undecryptable");
        let m = decode(&event, &me(), None).unwrap();
        assert_eq!(m.status, "undecryptable");
    }
    #[test]
    fn decodes_plain_messages_with_and_without_identity() {
        let event = json!({
            "id": "x2", "time": 11, "event": "message", "message": "hi", "title": "T",
            "tags": ["fn1", "fnid-other", format!("fnname-{}", B64.encode("小明")), "fnav-pixel"],
        });
        let m = decode(&event, &me(), None).unwrap();
        assert_eq!((m.mine, m.sender_name.as_deref(), m.title.as_str()), (false, Some("小明"), "T"));
        assert_eq!(m.sender_avatar.as_deref(), Some("pixel"));
        let curl = json!({ "id": "x3", "time": 12, "event": "message", "message": "from curl" });
        let m = decode(&curl, &me(), None).unwrap();
        assert!(m.sender_id.is_none() && !m.mine && m.body == "from curl");
        assert!(decode(&json!({ "event": "keepalive", "id": "k" }), &me(), None).is_none());
    }
    #[test]
    fn backoff_grows_and_caps() {
        assert!(backoff(1, false) < Duration::from_secs(4));
        assert!(backoff(10, false) <= Duration::from_secs(61));
        assert_eq!(backoff(1, true), Duration::from_secs(300));
    }
}
