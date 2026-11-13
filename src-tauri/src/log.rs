//! 诊断日志：每行一个 JSON，写入前脱敏，按分钟限流，按大小轮转
//! 设计照 MediaCrawler Studio 的 StudioLogger，dev 与正式版分文件
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_FILES: usize = 5;
const MAX_PER_MINUTE: u32 = 120;
const MAX_LINE: usize = 32 * 1024;
const NAME: &str = if cfg!(debug_assertions) {
    "fox-nudge-dev"
} else {
    "fox-nudge"
};

struct Logger {
    dir: PathBuf,
    minute: i64,
    count: u32,
    dropped: u32,
    warned: bool,
}

static LOGGER: OnceLock<Mutex<Logger>> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = LOGGER.set(Mutex::new(Logger {
        dir,
        minute: 0,
        count: 0,
        dropped: 0,
        warned: false,
    }));
    std::panic::set_hook(Box::new(|info| {
        error("main", "panic", json!({ "message": info.to_string() }));
    }));
}

pub fn dir() -> Option<PathBuf> {
    LOGGER.get().map(|l| l.lock().unwrap().dir.clone())
}

pub fn info(source: &str, event: &str, detail: Value) {
    write("info", source, event, detail)
}
pub fn warn(source: &str, event: &str, detail: Value) {
    write("warn", source, event, detail)
}
pub fn error(source: &str, event: &str, detail: Value) {
    write("error", source, event, detail)
}

pub fn write(level: &str, source: &str, event: &str, detail: Value) {
    let Some(logger) = LOGGER.get() else { return };
    let Ok(mut logger) = logger.lock() else { return };
    let minute = chrono::Utc::now().timestamp() / 60;
    if logger.minute != minute {
        logger.minute = minute;
        logger.count = 0;
        let dropped = std::mem::take(&mut logger.dropped);
        if dropped > 0 {
            let _ = logger.append("warn", "logger", "rate-limited", json!({ "count": dropped }));
        }
    }
    logger.count += 1;
    if logger.count > MAX_PER_MINUTE {
        logger.dropped += 1;
        return;
    }
    if logger.append(level, source, event, detail).is_err() && !logger.warned {
        // 磁盘故障不影响业务，也不把未脱敏的内容打到控制台
        logger.warned = true;
        eprintln!("FoxNudge: diagnostic log unavailable");
    }
}

impl Logger {
    fn file(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.dir.join(format!("{NAME}.log"))
        } else {
            self.dir.join(format!("{NAME}.{index}.log"))
        }
    }
    fn append(&mut self, level: &str, source: &str, event: &str, detail: Value) -> std::io::Result<()> {
        let level = if matches!(level, "info" | "warn" | "error") { level } else { "error" };
        let mut entry = json!({
            "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": level,
            "source": truncate(&redact_text(source), 80),
            "event": truncate(&redact_text(event), 120),
            "detail": redact(detail),
        });
        let mut line = entry.to_string();
        if line.len() > MAX_LINE {
            entry["detail"] = json!({ "truncated": true });
            line = entry.to_string();
        }
        fs::create_dir_all(&self.dir)?;
        let size = fs::metadata(self.file(0)).map(|m| m.len()).unwrap_or(0);
        if size + line.len() as u64 + 1 > MAX_BYTES {
            let _ = fs::remove_file(self.file(MAX_FILES - 1));
            for i in (0..MAX_FILES - 1).rev() {
                let _ = fs::rename(self.file(i), self.file(i + 1));
            }
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(self.file(0))?;
        writeln!(file, "{line}")
    }
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// 键名命中这些词的值整体隐去：令牌、密钥和消息正文都不进日志
const SECRET_KEYS: [&str; 9] = [
    "token", "secret", "key", "password", "authorization", "body", "message", "title", "text",
];

pub fn redact(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let lower = k.to_lowercase();
                // message_id 这类标识保留
                let secret = SECRET_KEYS.iter().any(|s| lower.contains(s))
                    && !lower.ends_with("id")
                    && !lower.ends_with("count")
                    && !lower.ends_with("set");
                out.insert(k, if secret { json!("[redacted]") } else { redact(v) });
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact).collect()),
        Value::String(s) => Value::String(redact_text(&truncate(&s, 2000))),
        other => other,
    }
}

// ntfy 访问令牌形如 tk_ 加 29 位字母数字，出现在任意字符串里都替换
pub fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if text[i..].starts_with("tk_") {
            let rest = &bytes[i + 3..];
            let n = rest.iter().take_while(|b| b.is_ascii_alphanumeric()).count();
            if n >= 16 {
                out.push_str("tk_***");
                i += 3 + n;
                continue;
            }
        }
        if bytes.len() >= i + 7 && bytes[i..i + 7].eq_ignore_ascii_case(b"bearer ") {
            out.push_str("Bearer ***");
            i += 7;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            continue;
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_tokens_and_content() {
        let v = redact(json!({
            "token": "tk_abc",
            "messageId": "m1",
            "detail": { "body": "hello", "url": "https://x/?auth=tk_0123456789abcdefghijklmnopqrs" },
            "header": "Bearer tk_secret",
        }));
        assert_eq!(v["token"], "[redacted]");
        assert_eq!(v["messageId"], "m1");
        assert_eq!(v["detail"]["body"], "[redacted]");
        assert_eq!(v["detail"]["url"], "https://x/?auth=tk_***");
        assert_eq!(v["header"], "Bearer ***");
    }
    #[test]
    fn keeps_plain_text() {
        assert_eq!(redact_text("连接成功 tk_ok"), "连接成功 tk_ok");
    }
}
