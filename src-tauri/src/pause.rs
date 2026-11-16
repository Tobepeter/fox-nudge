//! 暂停提醒：期间消息照常进历史，只是不弹通知、不响；结束时把错过的合并提醒一次
//! 截止时间存在 data.json，重启后仍然有效；错过的消息只记在内存里，重启后只在历史里
use crate::{data::Message, log, AppState};
use chrono::{Local, TimeZone, Timelike};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Pause {
    missed: Mutex<Vec<Message>>,
    /// 每次暂停或恢复加一，旧的到点任务据此作废
    generation: AtomicU64,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 暂停截止时间（秒），没在暂停返回 None
pub fn until(app: &AppHandle) -> Option<i64> {
    let at = app.state::<AppState>().data.lock().unwrap().paused_until;
    (at > now()).then_some(at)
}

/// 暂停中把消息收进待提醒，返回 true 表示已拦下
pub fn hold(app: &AppHandle, message: &Message) -> bool {
    if until(app).is_none() {
        return false;
    }
    app.state::<AppState>().pause.missed.lock().unwrap().push(message.clone());
    true
}

/// 最长暂停 7 天
const MAX_MINUTES: i64 = 7 * 24 * 60;

/// 时长：morning（下一个早上 9 点）、30m、1h、或纯数字分钟（命令行用）
pub fn deadline(preset: &str, from: chrono::DateTime<Local>) -> Option<i64> {
    let minutes = |text: &str, unit: i64| text.parse::<i64>().ok().map(|n| n * unit).filter(|m| (1..=MAX_MINUTES).contains(m));
    let preset = preset.trim();
    let after = |m: i64| Some(from.timestamp() + m * 60);
    match preset {
        "morning" => {
            let day = from.date_naive();
            let day = if from.hour() < 9 { day } else { day.succ_opt()? };
            Some(Local.from_local_datetime(&day.and_hms_opt(9, 0, 0)?).earliest()?.timestamp())
        }
        _ => {
            if let Some(n) = preset.strip_suffix('h') {
                after(minutes(n, 60)?)
            } else if let Some(n) = preset.strip_suffix('m') {
                after(minutes(n, 1)?)
            } else {
                after(minutes(preset, 1)?)
            }
        }
    }
}

pub fn start(app: &AppHandle, preset: &str) -> Result<i64, String> {
    let at = deadline(preset, Local::now()).ok_or("未知的暂停时长")?;
    set(app, at)?;
    log::info("pause", "start", json!({ "preset": preset, "until": at }));
    schedule(app, at);
    changed(app);
    Ok(at)
}

/// 手动恢复或到点恢复，暂停期间有消息就合并提醒一次；返回之前是否在暂停
pub fn resume(app: &AppHandle, reason: &str) -> bool {
    let state = app.state::<AppState>();
    state.pause.generation.fetch_add(1, Ordering::SeqCst);
    if state.data.lock().unwrap().paused_until == 0 {
        return false;
    }
    let _ = set(app, 0);
    let missed = std::mem::take(&mut *state.pause.missed.lock().unwrap());
    log::info("pause", "resume", json!({ "reason": reason, "missed": missed.len() }));
    crate::alert::batch(app, "暂停期间", &missed);
    changed(app);
    true
}

/// 启动时：已过期的清掉，没过期的接着计时
pub fn init(app: &AppHandle) {
    let at = app.state::<AppState>().data.lock().unwrap().paused_until;
    if at == 0 {
        return;
    }
    if at > now() {
        schedule(app, at);
    } else {
        let _ = set(app, 0);
    }
}

fn set(app: &AppHandle, at: i64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut data = state.data.lock().unwrap();
    data.paused_until = at;
    crate::data::save(&data)
}

fn schedule(app: &AppHandle, at: i64) {
    let generation = app.state::<AppState>().pause.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 睡眠期间计时会停，分段睡、每次按墙钟判断
        loop {
            let left = at - now();
            if left <= 0 {
                break;
            }
            tokio::time::sleep(Duration::from_secs(left.min(30) as u64)).await;
            if app.state::<AppState>().pause.generation.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        resume(&app, "expired");
    });
}

fn changed(app: &AppHandle) {
    crate::notify(app);
    crate::tray::refresh(app);
}

/// 菜单栏用的截止时间文字：今天只写时分，否则带「明天」或日期
pub fn label(at: i64) -> String {
    let Some(at) = Local.timestamp_opt(at, 0).single() else { return String::new() };
    let today = Local::now().date_naive();
    let day = at.date_naive();
    let time = at.format("%H:%M");
    if day == today {
        format!("{time}")
    } else if day == today.succ_opt().unwrap_or(today) {
        format!("明天 {time}")
    } else {
        format!("{} {time}", at.format("%-m月%-d日"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn morning_is_next_nine() {
        let at = |h, m| Local.with_ymd_and_hms(2026, 11, 16, h, m, 0).single().unwrap();
        let nine = at(9, 0).timestamp();
        assert_eq!(deadline("morning", at(2, 0)), Some(nine));
        assert_eq!(deadline("morning", at(9, 0)), Some(nine + 86400));
        assert_eq!(deadline("morning", at(22, 30)), Some(nine + 86400));
        assert_eq!(deadline("1h", at(22, 30)), Some(at(22, 30).timestamp() + 3600));
        let base = at(22, 30).timestamp();
        assert_eq!(deadline("2h", at(22, 30)), Some(base + 7200));
        assert_eq!(deadline("45", at(22, 30)), Some(base + 2700));
        assert_eq!(deadline("45m", at(22, 30)), Some(base + 2700));
        assert_eq!(deadline("0", at(22, 30)), None);
        assert_eq!(deadline("8d", at(22, 30)), None);
        assert_eq!(deadline("200h", at(22, 30)), None);
    }
}
