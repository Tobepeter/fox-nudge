//! 业务数据与凭据：data.json 给界面用，secrets.json 只在 Rust 侧读写，不发给前端
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::OnceLock};

pub const HISTORY_LIMIT: usize = 300;
/// 历史最多保留的天数，超过的自动清掉
pub const HISTORY_DAYS: i64 = 30;
pub const TEMPLATE_LIMIT: usize = 10;
pub const TEMPLATE_TEXT_LIMIT: usize = 100;
pub const NAME_LIMIT: usize = 16;
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
    /// 提示音跟随系统：随通知一起由系统播放，专注模式、共享屏幕、关掉通知声音时一起静音；
    /// 关掉则由 FoxNudge 自己播放，什么情况都会响
    pub sound_follow_system: bool,
    pub notify: bool,
    /// minimal：通知只显示消息内容；full：标题是发送者昵称，右侧带头像
    pub notify_style: String,
    /// window：主窗口打开时显示；always；never
    pub dock_mode: String,
    pub theme: String,
    /// 头像：name 显示昵称文字，其余是按设备 ID 生成的预设风格；首次随机选一套预设
    pub avatar_style: String,
    pub launch_at_login: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            // 留空表示用构建时内置的地址和主题，填了就覆盖
            server: String::new(),
            topic: String::new(),
            encrypt: true,
            mode: "stream".into(),
            poll_seconds: 60,
            sound: "Glass".into(),
            sound_follow_system: true,
            notify: true,
            notify_style: "minimal".into(),
            dock_mode: "window".into(),
            theme: "system".into(),
            avatar_style: random_style(),
            launch_at_login: false,
        }
    }
}
/// DiceBear 头像风格，和前端 src/lib/avatar-styles.ts 一致；前 6 套是 CC0 拟人风格，首次从中随机
pub const AVATAR_STYLES: [&str; 30] = [
    "lorelei", "notionists", "openPeeps", "loreleiNeutral", "notionistsNeutral", "thumbs",
    "adventurer", "adventurerNeutral", "avataaars", "avataaarsNeutral", "bigEars", "bigEarsNeutral",
    "bigSmile", "micah", "miniavs", "personas", "dylan", "toonHead", "funEmoji", "croodles",
    "croodlesNeutral", "bottts", "botttsNeutral", "pixelArt", "pixelArtNeutral", "glass", "icons",
    "identicon", "rings", "shapes",
];
const HUMAN_STYLES: usize = 6;
pub const ANONYMOUS: &str = "anonymous";

/// 默认昵称：系统账户短名（whoami 那个，不是登录界面上的全名），取不到时才用 anonymous
pub fn default_name() -> String {
    std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| {
            let home = std::env::var("HOME").ok()?;
            Some(std::path::Path::new(&home).file_name()?.to_string_lossy().into_owned())
        })
        .and_then(|n| clean_name(&n))
        .unwrap_or_else(|| ANONYMOUS.into())
}

/// 随机选一套预设头像风格
pub fn random_style() -> String {
    AVATAR_STYLES[rand::random::<usize>() % HUMAN_STYLES].to_string()
}

/// 昵称清洗：只留各国文字、数字、空格和 - _ . ·，合并空白，最多 16 个字；
/// 清洗后为空或等于 anonymous（不分大小写）都回到兜底，返回 None
pub fn clean_name(input: &str) -> Option<String> {
    let kept: String = input
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| c.is_alphanumeric() || " -_.·".contains(*c))
        .collect();
    let name: String = kept.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(NAME_LIMIT).collect::<String>().trim().to_string();
    if name.is_empty() || name.eq_ignore_ascii_case(ANONYMOUS) {
        None
    } else {
        Some(name)
    }
}
pub const SOUNDS: [&str; 8] = [
    "Glass", "Ping", "Pop", "Purr", "Submarine", "Hero", "Funk", "none",
];
impl Settings {
    pub fn normalize(&mut self) {
        // 旧版本的头像风格名不再支持时，随机换一套新的
        if self.avatar_style != "name" && !AVATAR_STYLES.contains(&self.avatar_style.as_str()) {
            self.avatar_style = random_style();
        }
        // 和内置值相同的视为没有覆盖，存成空
        self.server = self.server.trim().trim_end_matches('/').to_string();
        if Some(self.server.as_str()) == crate::ntfy::builtin_server() {
            self.server.clear();
        }
        self.topic = self.topic.trim().to_string();
        if Some(self.topic.as_str()) == crate::ntfy::builtin_topic() {
            self.topic.clear();
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
        if !matches!(self.notify_style.as_str(), "minimal" | "full") {
            return Err("未知的通知样式".into());
        }
        if !SOUNDS.contains(&self.sound.as_str()) {
            return Err("未知的提示音".into());
        }
        if !matches!(self.dock_mode.as_str(), "window" | "always" | "never") {
            return Err("未知的 Dock 显示方式".into());
        }
        if self.avatar_style != "name" && !AVATAR_STYLES.contains(&self.avatar_style.as_str()) {
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
            name: default_name(),
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
    /// 发送者选的头像风格，旧消息和 curl 发的没有；旧的 data.json 里缺这个字段也能读
    #[serde(default)]
    pub sender_avatar: Option<String>,
    pub mine: bool,
    pub encrypted: bool,
    /// ok；undecryptable：解不开的密文
    pub status: String,
    /// 仅自己：没经过服务器，只在本机记录和提醒
    #[serde(default)]
    pub to_self: bool,
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
    /// 「最近发过」只显示这个时间（秒）之后发的；清空最近只改它，不删历史
    pub recent_cleared_at: i64,
    /// 暂停提醒到这个时间（秒），0 表示没暂停
    pub paused_until: i64,
    /// 看过新手引导；旧数据没有这个字段，算已经看过，只有新装和清除数据后才弹
    #[serde(default = "yes")]
    pub welcomed: bool,
}
fn yes() -> bool {
    true
}
impl Default for Data {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            identity: Identity::fresh(),
            templates: default_templates(),
            messages: vec![],
            last_id: None,
            recent_cleared_at: 0,
            paused_until: 0,
            welcomed: false,
        }
    }
}
pub fn default_templates() -> Vec<Template> {
    ["ding", "hi", "叮", "来一下", "吃饭啦", "收到"]
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
        self.prune(chrono::Utc::now().timestamp());
        true
    }

    /// 淘汰：先去掉超过 30 天的，再只留最近 300 条（按时间排序，最旧的在前）
    pub fn prune(&mut self, now: i64) {
        let oldest = now - HISTORY_DAYS * 24 * 3600;
        self.messages.retain(|m| m.time >= oldest);
        let excess = self.messages.len().saturating_sub(HISTORY_LIMIT);
        self.messages.drain(..excess);
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
                // 旧版本把默认地址和主题写进了数据，和内置值相同的转成“用内置”
                data.settings.normalize();
                data.prune(chrono::Utc::now().timestamp());
                if data.identity.id.is_empty() {
                    data.identity = Identity::fresh();
                }
                // 旧版本没设昵称时存的是 anonymous，换成系统账户名
                if data.identity.name == ANONYMOUS {
                    data.identity.name = default_name();
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
            sender_avatar: None,
            to_self: false,
            mine: false,
            encrypted: false,
            status: "ok".into(),
        }
    }
    #[test]
    fn messages_dedupe_and_sort() {
        let mut data = Data::default();
        let t = chrono::Utc::now().timestamp();
        assert!(data.push_message(message("b", t + 2)));
        assert!(data.push_message(message("a", t + 1)));
        assert!(!data.push_message(message("a", t + 1)));
        assert_eq!(data.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }
    #[test]
    fn history_drops_old_messages() {
        let now = 100 * 24 * 3600;
        let mut data = Data::default();
        data.messages = vec![message("old", now - 31 * 24 * 3600), message("new", now - 24 * 3600)];
        data.prune(now);
        assert_eq!(data.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["new"]);
    }
    #[test]
    fn history_is_capped() {
        let mut data = Data::default();
        let base = chrono::Utc::now().timestamp() - 3600;
        for i in 0..(HISTORY_LIMIT as i64 + 5) {
            data.push_message(message(&i.to_string(), base + i));
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
    fn names_are_cleaned_and_capped() {
        assert_eq!(clean_name("  tobe  "), Some("tobe".into()));
        assert_eq!(clean_name("Anonymous"), None);
        assert_eq!(clean_name("  "), None);
        assert_eq!(clean_name("<script>小\n狐"), Some("script小 狐".into()));
        assert_eq!(clean_name("a\u{200b}b🦊c"), Some("abc".into()));
        assert_eq!(clean_name("我的名字特别特别特别特别特别特别长").unwrap().chars().count(), NAME_LIMIT);
        assert_eq!(clean_name("x-1_y.z·w"), Some("x-1_y.z·w".into()));
    }
    #[test]
    fn avatar_style_accepts_name_and_presets() {
        let mut s = Settings::default();
        assert!(AVATAR_STYLES.contains(&s.avatar_style.as_str()));
        s.avatar_style = "name".into();
        assert!(s.validate().is_ok());
        s.avatar_style = "unknown".into();
        assert!(s.validate().is_err());
        s.normalize();
        assert!(AVATAR_STYLES.contains(&s.avatar_style.as_str()), "旧风格名规范化成新预设");
    }
    #[test]
    fn server_and_topic_are_overrides() {
        let s = Settings::default();
        assert_eq!((s.server.as_str(), s.topic.as_str()), ("", ""), "默认不写死，走内置配置");
        let mut s = Settings { server: " https://x.example/ ".into(), topic: " t1 ".into(), ..Settings::default() };
        s.normalize();
        assert_eq!((s.server.as_str(), s.topic.as_str()), ("https://x.example", "t1"));
    }
    #[test]
    fn old_messages_without_avatar_still_load() {
        let m: Message = serde_json::from_str(
            r#"{"id":"1","time":1,"title":"","body":"b","senderId":null,"senderName":null,"mine":false,"encrypted":true,"status":"ok"}"#,
        )
        .unwrap();
        assert_eq!(m.sender_avatar, None);
    }
    #[test]
    fn old_templates_still_load() {
        let t: Template = serde_json::from_str(r#"{"id":"1","title":"吃饭","body":"吃饭啦"}"#).unwrap();
        assert_eq!(t.text, "吃饭啦");
    }
    #[test]
    fn welcome_only_for_fresh_data() {
        assert!(!Data::default().welcomed);
        let old: Data = serde_json::from_str("{}").unwrap();
        assert!(old.welcomed, "旧数据没有这个字段，算已经看过");
    }
    #[test]
    fn identity_is_short_random() {
        let a = Identity::fresh();
        assert_eq!(a.id.len(), 12);
        assert_ne!(a.id, Identity::fresh().id);
        assert_eq!(a.name, default_name());
    }
}
