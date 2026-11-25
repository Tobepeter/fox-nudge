//! 命令行：同一个程序带命令参数运行时不起界面，经本地 Unix socket 找正在运行的 FoxNudge 办事
//! socket 在数据目录（0600，只有自己的账号能连，不开网络端口），应用启动时建、退出时删
//! 设置里「安装」在 ~/.local/bin/fox-nudge 写一个转发脚本，卸载只删带标记的那个文件
use crate::{log, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    process::Command,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const COMMANDS: &[&str] = &["status", "send", "name", "peers", "pause", "resume", "history", "open", "help"];
const MARK: &str = "# FoxNudge 命令行";
const IDENTIFIER: &str = "com.tobe.fox-nudge";

const HELP: &str = "FoxNudge 命令行

用法：fox-nudge <命令> [参数] [--json] [--launch]

  status              连接状态、是否暂停
  send <文字>          广播一条消息（加密、带身份，和点文案一样）
  send --self <文字>   只发给自己：本机记录并提醒，不经过服务器（Agent 跑完任务用）
  send -              正文从标准输入读，适合带引号、换行的文字
  name [新昵称]        看或改昵称；name --reset 回到系统账户名
  peers               其他电脑谁在线、有没有暂停
  pause [时长]         暂停提醒，默认 30 分钟；时长如 30m、2h、45、morning（到明早 9 点）
  resume              恢复提醒
  history [-n 10]     最近几条消息
  open                打开主窗口

  --json              输出 JSON，给脚本和 Agent 用
  --launch            FoxNudge 没在运行时先打开它
  --                  后面的都当正文，不再识别 --json 这类标记

退出码：0 成功，1 失败，2 FoxNudge 没在运行";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// 和 Tauri 的 app_data_dir 一致；CLI 模式下不启动 Tauri，只能自己拼
pub fn socket_path() -> PathBuf {
    home().join("Library/Application Support").join(IDENTIFIER).join("cli.sock")
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Request {
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    /// send --self：只发给自己（本机），不经过服务器
    #[serde(default)]
    to_self: bool,
}

#[derive(Serialize, Deserialize)]
struct Reply {
    ok: bool,
    text: String,
    #[serde(default)]
    data: Value,
}

impl Reply {
    fn ok(text: impl Into<String>, data: Value) -> Self {
        Self { ok: true, text: text.into(), data }
    }
    fn err(text: impl Into<String>) -> Self {
        Self { ok: false, text: text.into(), data: Value::Null }
    }
}

/// 解析命令行：(请求, --json, --launch)；不带参数或第一个是 - 开头的启动参数（--hidden、-psn_…）返回 None，照常启动应用
/// 其余都当命令，打错的也交给 run 报「未知命令」，不会误开窗口
fn parse(args: &[String]) -> Option<(Request, bool, bool)> {
    let cmd = args.get(1)?;
    let cmd = match cmd.as_str() {
        "-h" | "--help" => "help",
        c if c.starts_with('-') => return None,
        c => c,
    };
    let mut rest = vec![];
    let (mut json, mut launch, mut to_self, mut literal) = (false, false, false, false);
    for a in &args[2..] {
        match a.as_str() {
            _ if literal => rest.push(a.clone()),
            "--" => literal = true,
            "--json" => json = true,
            "--launch" => launch = true,
            "--self" => to_self = true,
            _ => rest.push(a.clone()),
        }
    }
    Some((Request { cmd: cmd.into(), args: rest, to_self }, json, launch))
}

/// main() 最先调用：是 CLI 命令就执行并返回退出码，否则返回 None
pub fn run(args: &[String]) -> Option<i32> {
    let (mut request, json, launch) = parse(args)?;
    if request.cmd == "help" {
        println!("{HELP}");
        return Some(0);
    }
    if !COMMANDS.contains(&request.cmd.as_str()) {
        return Some(fail(json, 1, &format!("未知命令「{}」，fox-nudge help 看用法", request.cmd)));
    }
    // send - ：正文从标准输入读，在这边读完再交给应用
    if request.cmd == "send" && request.args == ["-"] {
        let mut text = String::new();
        if std::io::stdin().read_to_string(&mut text).is_err() {
            return Some(fail(json, 1, "读不了标准输入"));
        }
        request.args = vec![text.trim_end().to_string()];
    }
    let stream = match UnixStream::connect(socket_path()) {
        Ok(s) => s,
        Err(_) if launch => match start_app() {
            Some(s) => s,
            None => return Some(fail(json, 2, "FoxNudge 没能启动")),
        },
        Err(_) => return Some(fail(json, 2, "FoxNudge 没在运行，加 --launch 先打开它")),
    };
    match call(stream, &request) {
        Ok(reply) => {
            if json {
                println!("{}", json!({ "ok": reply.ok, "text": reply.text, "data": reply.data }));
            } else if reply.ok {
                println!("{}", reply.text);
            } else {
                eprintln!("{}", reply.text);
            }
            Some(if reply.ok { 0 } else { 1 })
        }
        Err(e) => Some(fail(json, 1, &format!("和 FoxNudge 通信失败：{e}"))),
    }
}

fn fail(json: bool, code: i32, text: &str) -> i32 {
    if json {
        println!("{}", json!({ "ok": false, "text": text, "data": null }));
    } else {
        eprintln!("{text}");
    }
    code
}

fn start_app() -> Option<UnixStream> {
    Command::new("open").args(["-g", "-b", IDENTIFIER, "--args", "--hidden"]).status().ok()?;
    for _ in 0..50 {
        thread::sleep(Duration::from_millis(100));
        if let Ok(s) = UnixStream::connect(socket_path()) {
            return Some(s);
        }
    }
    None
}

fn call(stream: UnixStream, request: &Request) -> std::io::Result<Reply> {
    // 发送可能要等网络重试，给足时间
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut writer = stream.try_clone()?;
    writeln!(writer, "{}", serde_json::to_string(request)?)?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(std::io::Error::other)
}

// ---------- 应用里的服务端 ----------

/// 应用启动时调用：清掉上次残留的 socket，监听，每个连接一个线程
pub fn serve(app: &AppHandle) {
    let path = socket_path();
    let _ = fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            log::warn("cli", "listen-failed", json!({ "reason": e.to_string() }));
            return;
        }
    };
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    let app = app.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || {
                let _ = answer(&app, stream);
            });
        }
    });
}

/// 退出时删掉 socket；被互顶 SIGTERM 时删不掉，下次启动会先清
pub fn stop() {
    let _ = fs::remove_file(socket_path());
}

fn answer(app: &AppHandle, stream: UnixStream) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(request) => {
            log::info("cli", "command", json!({ "cmd": request.cmd }));
            handle(app, request)
        }
        Err(_) => Reply::err("看不懂的请求"),
    };
    writeln!(writer, "{}", serde_json::to_string(&reply)?)
}

fn handle(app: &AppHandle, request: Request) -> Reply {
    let args = request.args.clone();
    match request.cmd.as_str() {
        "status" => status(app),
        "send" => {
            let text = args.join(" ");
            if text.trim().is_empty() {
                return Reply::err("要发送的文字是空的");
            }
            let result = if request.to_self {
                crate::ntfy::deliver_self(app, String::new(), text)
            } else {
                tauri::async_runtime::block_on(crate::ntfy::publish(app, String::new(), text))
            };
            match result {
                Ok(m) => Reply::ok(if m.to_self { "已发给自己" } else { "已发送" }, json!({ "id": m.id })),
                Err(e) => Reply::err(format!("发送失败：{e}")),
            }
        }
        "name" => name(app, &args),
        "peers" => peers(app),
        "pause" => {
            let preset = args.first().map(String::as_str).unwrap_or("30m");
            match crate::pause::start(app, preset) {
                Ok(at) => Reply::ok(format!("已暂停提醒至 {}", crate::pause::label(at)), json!({ "until": at })),
                Err(_) => Reply::err(format!("看不懂的时长「{preset}」，可以用 30m、2h、45、morning")),
            }
        }
        "resume" => {
            if crate::pause::resume(app, "cli") {
                Reply::ok("已恢复提醒", Value::Null)
            } else {
                Reply::ok("本来就没有暂停", Value::Null)
            }
        }
        "history" => history(app, &args),
        "open" => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || crate::show(&handle));
            Reply::ok("已打开", Value::Null)
        }
        other => Reply::err(format!("未知命令「{other}」")),
    }
}

fn status(app: &AppHandle) -> Reply {
    let state = app.state::<AppState>();
    let connection = state.hub.status.lock().unwrap().clone();
    let name = state.data.lock().unwrap().identity.name.clone();
    let paused = crate::pause::until(app);
    let online = crate::presence::peers(app).iter().filter(|p| p.online).count();
    let mut text = crate::tray::connection_label(&connection);
    if let Some(at) = paused {
        text += &format!(" · 已暂停提醒至 {}", crate::pause::label(at));
    }
    text += &format!(" · 另有 {online} 台在线");
    Reply::ok(
        text,
        json!({
            "connection": connection.state,
            "error": connection.error,
            "pausedUntil": paused,
            "name": name,
            "peersOnline": online,
            "build": if cfg!(debug_assertions) { "dev" } else { "release" },
            "version": env!("CARGO_PKG_VERSION"),
        }),
    )
}

/// 不带参数看昵称；带了就改，和设置里改名同一套规则；--reset 回到系统账户名
fn name(app: &AppHandle, args: &[String]) -> Reply {
    let current = || app.state::<AppState>().data.lock().unwrap().identity.name.clone();
    if args.is_empty() {
        let name = current();
        return Reply::ok(name.clone(), json!({ "name": name }));
    }
    let input = if args == ["--reset"] { String::new() } else { args.join(" ") };
    match crate::save_identity(app.clone(), input) {
        Ok(()) => {
            let name = current();
            Reply::ok(format!("昵称改成了「{name}」"), json!({ "name": name }))
        }
        Err(e) => Reply::err(format!("改昵称失败：{e}")),
    }
}

fn peers(app: &AppHandle) -> Reply {
    let list = crate::presence::peers(app);
    let limited = crate::presence::limited(app);
    let now = chrono::Utc::now().timestamp();
    let mut lines: Vec<String> = list
        .iter()
        .map(|p| {
            let state = if !p.online {
                let minutes = (now - p.last_seen) / 60;
                match minutes {
                    m if m < 60 => format!("{m} 分钟前在线"),
                    m if m < 24 * 60 => format!("{} 小时前在线", m / 60),
                    m => format!("{} 天前在线", m / 60 / 24),
                }
            } else if p.paused {
                "在线 · 暂停提醒中".into()
            } else {
                "在线".into()
            };
            format!("{}  {state}", p.name)
        })
        .collect();
    if lines.is_empty() {
        lines.push("暂时没有其他设备在线".into());
    }
    if limited {
        lines.push("（在线心跳正被服务器限流，名单可能过时）".into());
    }
    Reply::ok(lines.join("\n"), json!({ "peers": list, "limited": limited }))
}

fn history(app: &AppHandle, args: &[String]) -> Reply {
    let n = args
        .iter()
        .position(|a| a == "-n")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10)
        .clamp(1, 100);
    let messages = app.state::<AppState>().data.lock().unwrap().messages.clone();
    let latest: Vec<_> = messages.iter().rev().take(n).collect();
    if latest.is_empty() {
        return Reply::ok("还没有消息", json!([]));
    }
    let lines: Vec<String> = latest
        .iter()
        .map(|m| {
            let time = chrono::DateTime::from_timestamp(m.time, 0)
                .map(|t| t.with_timezone(&chrono::Local).format("%m-%d %H:%M").to_string())
                .unwrap_or_default();
            let who = if m.to_self { "仅自己".to_string() } else if m.mine { "我".to_string() } else { m.sender_name.clone().unwrap_or_else(|| "未知".into()) };
            format!("{time}  {who}：{}", m.body)
        })
        .collect();
    Reply::ok(lines.join("\n"), serde_json::to_value(&latest).unwrap_or_default())
}

// ---------- 设置里的安装与卸载 ----------

fn install_path() -> PathBuf {
    home().join(".local/bin/fox-nudge")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// installed：装的是 FoxNudge 的脚本；foreign：同名文件不是我们装的；none：没装
    state: String,
    path: String,
    /// 脚本指向的程序，开发版里是 target/debug
    target: String,
}

fn script(target: &str) -> String {
    format!("#!/bin/sh\n{MARK}（由 FoxNudge 设置安装，卸载会删除这个文件）\nexec \"{target}\" \"$@\"\n")
}

fn current_target() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
pub fn cli_status() -> CliStatus {
    let path = install_path();
    let (state, target) = match fs::read_to_string(&path) {
        Ok(text) if text.contains(MARK) => {
            let target = text.lines().find_map(|l| l.strip_prefix("exec \"")).and_then(|l| l.split('"').next()).unwrap_or_default();
            ("installed", target.to_string())
        }
        Ok(_) => ("foreign", String::new()),
        Err(_) if path.exists() => ("foreign", String::new()),
        Err(_) => ("none", String::new()),
    };
    CliStatus { state: state.into(), path: path.display().to_string(), target }
}

#[tauri::command]
pub fn install_cli() -> Result<CliStatus, String> {
    let path = install_path();
    if cli_status().state == "foreign" {
        return Err(format!("{} 已存在，不是 FoxNudge 装的，没有覆盖", path.display()));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, script(&current_target())).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    log::info("cli", "installed", json!({}));
    Ok(cli_status())
}

#[tauri::command]
pub fn uninstall_cli() -> Result<CliStatus, String> {
    if cli_status().state == "installed" {
        fs::remove_file(install_path()).map_err(|e| e.to_string())?;
        log::info("cli", "uninstalled", json!({}));
    }
    Ok(cli_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_commands_and_flags() {
        let (r, json, launch) = parse(&args(&["fox-nudge", "send", "吃饭", "啦", "--json"])).unwrap();
        assert_eq!(r, Request { cmd: "send".into(), args: args(&["吃饭", "啦"]), to_self: false });
        assert!(json && !launch);
        let (r, _, _) = parse(&args(&["fox-nudge", "send", "--self", "跑完了"])).unwrap();
        assert!(r.to_self);
        assert_eq!(r.args, args(&["跑完了"]));
        let (r, _, launch) = parse(&args(&["fox-nudge", "pause", "--launch"])).unwrap();
        assert_eq!(r.cmd, "pause");
        assert!(r.args.is_empty() && launch);
        assert_eq!(parse(&args(&["fox-nudge", "--help"])).unwrap().0.cmd, "help");
        // -- 之后原样当正文
        let (r, json, _) = parse(&args(&["fox-nudge", "send", "--", "记得加", "--self", "--json"])).unwrap();
        assert!(!r.to_self && !json);
        assert_eq!(r.args, args(&["记得加", "--self", "--json"]));
        // 打错的命令也解析出来，由 run 报未知命令，不当成启动
        assert_eq!(parse(&args(&["fox-nudge", "stauts"])).unwrap().0.cmd, "stauts");
        // 应用自己的启动参数不算命令
        assert!(parse(&args(&["fox-nudge"])).is_none());
        assert!(parse(&args(&["fox-nudge", "--hidden"])).is_none());
        assert!(parse(&args(&["fox-nudge", "-psn_0_12345"])).is_none());
    }

    #[test]
    fn script_points_to_target() {
        let text = script("/Applications/FoxNudge.app/Contents/MacOS/fox-nudge");
        assert!(text.contains(MARK));
        assert!(text.contains("exec \"/Applications/FoxNudge.app/Contents/MacOS/fox-nudge\" \"$@\""));
    }
}
