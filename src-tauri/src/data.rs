//! 业务数据与凭据：data.json 给界面用，secrets.json 只在 Rust 侧读写，不发给前端
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::OnceLock};

pub const HISTORY_LIMIT: usize = 300;
pub const TEMPLATE_LIMIT: usize = 10;
pub const TEMPLATE_TEXT_LIMIT: usize = 100;
pub const NAME_LIMIT: usize = 24;
pub const BODY_LIMIT: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Settings {
    pub server: String,
    pub topic: String,
    pub encrypt: bool,
    /// stream：长连接；poll：定时轮询
    pub mode: String,
    pub poll_seconds: u32,
    /// 系统提示音名，none 为静音
    pub sound: String,
    pub notify: bool,
    pub shortcut: String,
    /// window：主窗口打开时显示；always；never
    pub dock_mode: String,
    pub theme: String,
    /// 程序化头像风格，按设备 ID 生成
    pub avatar_style: String,
    pub launch_at_login: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            server: "https://notify.tobeei.com".into(),
            topic: "notify-main".into(),
            encrypt: true,
            mode: "stream".into(),
            poll_seconds: 60,
            sound: "Glass".into(),
            notify: true,
            shortcut: "Control+Alt+N".into(),
            dock_mode: "window".into(),
            theme: "system".into(),
            avatar_style: "beam".into(),
            launch_at_login: false,
        }
    }
}
pub const AVATAR_STYLES: [&str; 6] = ["beam", "marble", "bauhaus", "ring", "pixel", "sunset"];
pub const SOUNDS: [&str; 8] = [
    "Glass", "Ping", "Pop", "Purr", "Submarine", "Hero", "Funk", "none",
];
impl Settings {
    pub fn normalize(&mut self) {
        // 地址和主题留空就回到默认值，界面上以灰色占位显示
        let defaults = Settings::default();
        self.server = self.server.trim().trim_end_matches('/').to_string();
        if self.server.is_empty() {
            self.server = defaults.server;
        }
        self.topic = self.topic.trim().to_string();
        if self.topic.is_empty() {
            self.topic = defaults.topic;
        }
        self.poll_seconds = self.poll_seconds.clamp(15, 3600);
    }
    pub fn validate(&self) -> Result<(), String> {
        if !self.server.is_empty()
            && !(self.server.starts_with("https://") || self.server.starts_with("http://"))
        {
            return Err("服务器地址需以 https:// 开头".into());
        }
        if !self.topic.is_empty()
            && !self
                .topic
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("主题只能包含字母、数字、- 和 _".into());
        }
        if self.topic.len() > 64 {
            return Err("主题最长 64 个字符".into());
        }
        if !matches!(self.mode.as_str(), "stream" | "poll") {
            return Err("未知的订阅方式".into());
        }
        if !SOUNDS.contains(&self.sound.as_str()) {
            return Err("未知的提示音".into());
        }
        if !matches!(self.dock_mode.as_str(), "window" | "always" | "never") {
            return Err("未知的 Dock 显示方式".into());
        }
        if !AVATAR_STYLES.contains(&self.avatar_style.as_str()) {
            return Err("未知的头像风格".into());
        }
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            return Err("未知的外观".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Identity {
    /// 首次启动随机生成，清除数据后重新生成
    pub id: String,
    pub name: String,
}
impl Identity {
    pub fn fresh() -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            name: "anonymous".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Template {
    pub id: String,
    /// 文案本身，点一下就原样广播；旧数据的 body 字段兼容读入
    #[serde(alias = "body")]
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Message {
    /// ntfy 消息 ID
    pub id: String,
    /// 秒级时间戳
    pub time: i64,
    pub title: String,
    pub body: String,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub mine: bool,
    pub encrypted: bool,
    /// ok；undecryptable：解不开的密文
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub settings: Settings,
    pub identity: Identity,
    pub templates: Vec<Template>,
    pub messages: Vec<Message>,
    /// 最近收到的 ntfy 消息 ID，重连时作为 since 补收
    pub last_id: Option<String>,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            identity: Identity::fresh(),
            templates: default_templates(),
            messages: vec![],
            last_id: None,
        }
    }
}
pub fn default_templates() -> Vec<Template> {
    ["叮", "来一下", "吃饭啦", "好了", "收到"]
        .into_iter()
        .map(|text| Template {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
        })
        .collect()
}
impl Data {
    /// 新消息按时间插入，同 ID 不重复；返回是否新增
    pub fn push_message(&mut self, message: Message) -> bool {
        if self.messages.iter().any(|m| m.id == message.id) {
            return false;
        }
        let at = self
            .messages
            .iter()
            .position(|m| m.time > message.time)
            .unwrap_or(self.messages.len());
        self.messages.insert(at, message);
        let excess = self.messages.len().saturating_sub(HISTORY_LIMIT);
        self.messages.drain(..excess);
        true
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Secrets {
    pub token: String,
    pub key: String,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}
fn path(name: &str) -> Option<PathBuf> {
    DIR.get().map(|d| d.join(name))
}

pub fn read() -> Data {
    let Some(path) = path("data.json") else {
        return Data::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Data>(&text) {
            Ok(mut data) => {
                if data.identity.id.is_empty() {
                    data.identity = Identity::fresh();
                }
                data
            }
            Err(e) => {
                // 坏文件留底，避免覆盖后无从排查
                let _ = fs::rename(&path, path.with_extension("broken.json"));
                crate::log::error("data", "parse-failed", serde_json::json!({ "error": e.to_string() }));
                Data::default()
            }
        },
        Err(_) => Data::default(),
    }
}

fn write_private(name: &str, text: &str) -> Result<(), String> {
    let path = path(name).ok_or("数据目录不可用")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn save(data: &Data) -> Result<(), String> {
    write_private(
        "data.json",
        &serde_json::to_string_pretty(data).map_err(|e| e.to_string())?,
    )
}

pub fn read_secrets() -> Secrets {
    path("secrets.json")
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}
pub fn save_secrets(secrets: &Secrets) -> Result<(), String> {
    write_private(
        "secrets.json",
        &serde_json::to_string(secrets).map_err(|e| e.to_string())?,
    )
}

/// 清除数据：删掉业务数据、凭据和日志，身份下次启动重新生成
pub fn wipe() -> Result<(), String> {
    for name in ["data.json", "secrets.json", "data.broken.json"] {
        if let Some(p) = path(name) {
            if p.exists() {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(id: &str, time: i64) -> Message {
        Message {
            id: id.into(),
            time,
            title: String::new(),
            body: String::new(),
            sender_id: None,
            sender_name: None,
            mine: false,
            encrypted: false,
            status: "ok".into(),
        }
    }
    #[test]
    fn messages_dedupe_and_sort() {
        let mut data = Data::default();
        assert!(data.push_message(message("b", 2)));
        assert!(data.push_message(message("a", 1)));
        assert!(!data.push_message(message("a", 1)));
        assert_eq!(data.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }
    #[test]
    fn history_is_capped() {
        let mut data = Data::default();
        for i in 0..(HISTORY_LIMIT as i64 + 5) {
            data.push_message(message(&i.to_string(), i));
        }
        assert_eq!(data.messages.len(), HISTORY_LIMIT);
        assert_eq!(data.messages[0].id, "5");
    }
    #[test]
    fn settings_validate() {
        let mut s = Settings::default();
        assert!(s.validate().is_ok());
        s.topic = "bad topic".into();
        assert!(s.validate().is_err());
        s.topic = "ok_topic-1".into();
        s.server = "ftp://x".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn empty_server_and_topic_fall_back_to_defaults() {
        let mut s = Settings { server: "  ".into(), topic: "".into(), ..Settings::default() };
        s.normalize();
        assert_eq!((s.server.as_str(), s.topic.as_str()), ("https://notify.tobeei.com", "notify-main"));
        s.server = "https://x.example/".into();
        s.normalize();
        assert_eq!(s.server, "https://x.example");
    }
    #[test]
    fn old_templates_still_load() {
        let t: Template = serde_json::from_str(r#"{"id":"1","title":"吃饭","body":"吃饭啦"}"#).unwrap();
        assert_eq!(t.text, "吃饭啦");
    }
    #[test]
    fn identity_is_short_random() {
        let a = Identity::fresh();
        assert_eq!(a.id.len(), 12);
        assert_ne!(a.id, Identity::fresh().id);
        assert_eq!(a.name, "anonymous");
    }
}
