//! 发送节流：短时间连发前几条不限，之后冷却逐级翻倍，最长 30 秒；停一阵后逐级恢复
use std::time::{Duration, Instant};

const FREE: u32 = 3;
const BASE: Duration = Duration::from_secs(2);
const MAX: Duration = Duration::from_secs(30);
/// 每安静这么久，档位降一级
const DECAY: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct Throttle {
    level: u32,
    last: Option<Instant>,
    next: Option<Instant>,
}

impl Throttle {
    /// 允许发送返回 Ok；还在冷却返回剩余时间
    pub fn check(&mut self, now: Instant) -> Result<(), Duration> {
        if let Some(next) = self.next.filter(|n| now < *n) {
            return Err(next - now);
        }
        if let Some(last) = self.last {
            let idle = now.saturating_duration_since(last);
            let drop = (idle.as_secs() / DECAY.as_secs()) as u32;
            self.level = self.level.saturating_sub(drop);
        }
        self.level += 1;
        self.last = Some(now);
        self.next = Some(now + cooldown(self.level));
        Ok(())
    }
}

pub fn cooldown(level: u32) -> Duration {
    if level <= FREE {
        return Duration::ZERO;
    }
    let factor = 2u32.saturating_pow((level - FREE - 1).min(8));
    (BASE * factor).min(MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cooldown_grows_and_caps() {
        let steps: Vec<u64> = (1..=10).map(|l| cooldown(l).as_secs()).collect();
        assert_eq!(steps, [0, 0, 0, 2, 4, 8, 16, 30, 30, 30]);
    }
    #[test]
    fn burst_is_blocked_then_recovers() {
        let mut t = Throttle::default();
        let start = Instant::now();
        for _ in 0..4 {
            assert!(t.check(start).is_ok());
        }
        // 第 4 条之后要等 2 秒
        assert!(t.check(start).is_err());
        assert!(t.check(start + Duration::from_secs(2)).is_ok());
        // 安静一分钟后回到免冷却
        let later = start + Duration::from_secs(62);
        assert!(t.check(later).is_ok());
        assert!(t.check(later).is_ok());
    }
}
