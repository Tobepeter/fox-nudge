//! 在线状态：在消息主题旁边另开 {主题}-presence，发不进缓存的心跳（Cache: no），服务器不存，只转给此刻在订阅的人
//! 连上先说 hello，别人收到回 here，一打开就有名单；之后每分钟 beat，暂停、改昵称头像时立刻补一次；正常退出说 bye
//! 超过 OFFLINE_SECONDS 没听到就算离线（睡眠、断网、被强制结束都是这样）
//! 内容和消息一样用共享密钥加密，没有密钥时明文；旧版本不订阅这个主题，不受影响
use crate::{
    crypto::{self, Sender},
    log, ntfy, AppState,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{sync::Notify, time::Instant};

const BEAT: Duration = Duration::from_secs(60);
/// 大约两次半心跳没听到就算离线
const OFFLINE_SECONDS: i64 = 150;
/// ntfy 45 秒一次保活，加上自己的心跳回声，超过这个时间没有数据就当作断线
const STALL: Duration = Duration::from_secs(110);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub avatar: String,
    pub online: bool,
    /// 对方暂停了提醒，发过去不会响
    pub paused: bool,
    /// 最后一次听到的时间（秒）
    pub last_seen: i64,
}

#[derive(Serialize, Deserialize)]
struct Beat {
    v: u8,
    /// hello 刚上线；here 回应 hello；beat 定时；bye 正常退出
    kind: String,
    from: Sender,
    #[serde(default)]
    paused: bool,
}

#[derive(Default)]
pub struct Presence {
    peers: Mutex<BTreeMap<String, Peer>>,
    poke: Notify,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn topic(cfg: &ntfy::Config) -> String {
    format!("{}-presence", cfg.topic)
}

/// 在线的在前，其余按最后听到的时间
pub fn peers(app: &AppHandle) -> Vec<Peer> {
    let mut list: Vec<Peer> = app.state::<AppState>().presence.peers.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| b.online.cmp(&a.online).then(b.last_seen.cmp(&a.last_seen)).then(a.name.cmp(&b.name)));
    list
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(worker(app.clone()));
    tauri::async_runtime::spawn(sweep(app));
}

/// 暂停、改昵称头像之后立刻补一次心跳，别人马上能看到
pub fn poke(app: &AppHandle) {
    app.state::<AppState>().presence.poke.notify_one();
}

/// 名单有变化（上线、下线、改名、暂停）才通知界面，只是刷新时间不通知
fn update(app: &AppHandle, peer: Peer) {
    let changed = {
        let state = app.state::<AppState>();
        let mut peers = state.presence.peers.lock().unwrap();
        let changed = match peers.get(&peer.id) {
            Some(p) => (&p.name, &p.avatar, p.online, p.paused) != (&peer.name, &peer.avatar, peer.online, peer.paused),
            None => true,
        };
        peers.insert(peer.id.clone(), peer);
        changed
    };
    if changed {
        crate::notify(app);
    }
}

fn clear(app: &AppHandle) {
    let had = {
        let state = app.state::<AppState>();
        let mut peers = state.presence.peers.lock().unwrap();
        let had = !peers.is_empty();
        peers.clear();
        had
    };
    if had {
        crate::notify(app);
    }
}

/// 太久没听到的标成离线
async fn sweep(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let cutoff = now() - OFFLINE_SECONDS;
        let changed = {
            let state = app.state::<AppState>();
            let mut peers = state.presence.peers.lock().unwrap();
            let mut changed = false;
            for p in peers.values_mut().filter(|p| p.online && p.last_seen < cutoff) {
                p.online = false;
                changed = true;
            }
            changed
        };
        if changed {
            crate::notify(&app);
        }
    }
}

async fn worker(app: AppHandle) {
    let mut restart = app.state::<AppState>().hub.restarts();
    let mut attempts: u32 = 0;
    let mut current: Option<(String, String)> = None;
    loop {
        restart.borrow_and_update();
        let cfg = ntfy::config(&app);
        // 换了服务器或主题，旧名单没有意义
        let place = cfg.as_ref().map(|c| (c.server.clone(), c.topic.clone()));
        if place != current {
            clear(&app);
            current = place;
        }
        let Some(cfg) = cfg else {
            let _ = restart.changed().await;
            continue;
        };
        let reason = tokio::select! {
            reason = run(&app, &cfg, &mut attempts) => reason,
            _ = restart.changed() => {
                attempts = 0;
                continue;
            }
        };
        attempts += 1;
        let delay = ntfy::backoff(attempts, false);
        log::warn("presence", "disconnected", json!({ "reason": reason, "retry_ms": delay.as_millis() as u64 }));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = restart.changed() => { attempts = 0; }
        }
    }
}

async fn run(app: &AppHandle, cfg: &ntfy::Config, attempts: &mut u32) -> String {
    let state = app.state::<AppState>();
    let mut req = state.hub.client().get(format!("{}/{}/json", cfg.server, topic(cfg)));
    if !cfg.token.is_empty() {
        req = req.bearer_auth(&cfg.token);
    }
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => return log::redact_text(&e.to_string()),
    };
    if !response.status().is_success() {
        return format!("服务器返回 {}", response.status().as_u16());
    }
    *attempts = 0;
    log::info("presence", "connected", json!({}));
    send(app, cfg, "hello").await;
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = vec![];
    let mut beat = tokio::time::interval_at(Instant::now() + BEAT, BEAT);
    let mut deadline = Instant::now() + STALL;
    loop {
        tokio::select! {
            next = stream.next() => {
                let chunk = match next {
                    None => return "连接被服务器关闭".into(),
                    Some(Err(e)) => return log::redact_text(&e.to_string()),
                    Some(Ok(chunk)) => chunk,
                };
                deadline = Instant::now() + STALL;
                buffer.extend_from_slice(&chunk);
                while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=pos).collect();
                    let Ok(event) = serde_json::from_slice::<Value>(&line) else { continue };
                    if event["event"] != "message" {
                        continue;
                    }
                    if hear(app, event["message"].as_str().unwrap_or_default()).as_deref() == Some("hello") {
                        // 稍微错开，几台同时回应时不扎堆
                        let (app, cfg) = (app.clone(), cfg.clone());
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(200 + rand::random::<u64>() % 1500)).await;
                            send(&app, &cfg, "here").await;
                        });
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline) => return "长时间没有心跳".into(),
            _ = beat.tick() => send(app, cfg, "beat").await,
            _ = state.presence.poke.notified() => send(app, cfg, "beat").await,
        }
    }
}

/// 解出一条在线消息并更新名单，返回它的 kind；自己发的、解不开的忽略
fn hear(app: &AppHandle, text: &str) -> Option<String> {
    let beat: Beat = if crypto::is_sealed(text) {
        crypto::open_any(&ntfy::active_key(app)?, text)?
    } else {
        serde_json::from_str(text).ok()?
    };
    let me = app.state::<AppState>().data.lock().unwrap().identity.id.clone();
    if beat.from.id.is_empty() || beat.from.id == me {
        return None;
    }
    update(
        app,
        Peer {
            id: beat.from.id,
            name: beat.from.name,
            avatar: beat.from.avatar,
            online: beat.kind != "bye",
            paused: beat.paused,
            last_seen: now(),
        },
    );
    Some(beat.kind)
}

fn payload(app: &AppHandle, kind: &str) -> Option<String> {
    let (identity, avatar) = {
        let state = app.state::<AppState>();
        let data = state.data.lock().unwrap();
        (data.identity.clone(), data.settings.avatar_style.clone())
    };
    let beat = Beat {
        v: 1,
        kind: kind.into(),
        from: Sender { id: identity.id, name: identity.name, avatar },
        paused: crate::pause::until(app).is_some(),
    };
    match ntfy::active_key(app) {
        Some(key) => crypto::seal_any(&key, &beat).ok(),
        None => serde_json::to_string(&beat).ok(),
    }
}

async fn send(app: &AppHandle, cfg: &ntfy::Config, kind: &str) {
    let Some(body) = payload(app, kind) else { return };
    let mut req = app
        .state::<AppState>()
        .hub
        .client()
        .post(format!("{}/{}", cfg.server, topic(cfg)))
        // 不进服务器缓存：只给此刻在线的人，之后连上的也不会补收到旧心跳
        .header("Cache", "no")
        .timeout(Duration::from_secs(10))
        .body(body);
    if !cfg.token.is_empty() {
        req = req.bearer_auth(&cfg.token);
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => log::warn("presence", "send-failed", json!({ "kind": kind, "status": r.status().as_u16() })),
        Err(e) => log::warn("presence", "send-failed", json!({ "kind": kind, "detail": log::redact_text(&e.to_string()) })),
    }
}

/// 正常退出时说一声，别人马上变成离线；最多等 1.5 秒，发不出去就靠超时
pub fn bye(app: &AppHandle) {
    let Some(cfg) = ntfy::config(app) else { return };
    let app = app.clone();
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(Duration::from_millis(1500), send(&app, &cfg, "bye")).await;
    });
}
