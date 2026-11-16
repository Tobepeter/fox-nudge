import type { Snapshot } from './bindings/Snapshot'

// 首屏占位，拿到真实快照前使用；字段与 Rust 默认值一致
export const initial: Snapshot = {
  settings: {
    server: '',
    topic: '',
    encrypt: true,
    mode: 'stream',
    pollSeconds: 60,
    sound: 'Glass',
    soundFollowSystem: true,
    notify: true,
    notifyStyle: 'minimal',
    dockMode: 'window',
    theme: 'system',
    avatarStyle: 'beam',
    launchAtLogin: false,
  },
  identity: { id: '', name: 'anonymous' },
  templates: [],
  messages: [],
  connection: {
    state: 'connecting',
    mode: 'stream',
    connectedAt: null,
    lastEventAt: null,
    attempts: 0,
    retryAt: null,
    error: '',
  },
  serverSource: 'none',
  topicSource: 'none',
  tokenSource: 'none',
  keySource: 'none',
  recentClearedAt: 0,
  pausedUntil: 0,
  version: '',
  dev: false,
}

export const sounds = [
  { value: 'Glass', label: '玻璃' },
  { value: 'Ping', label: '叮' },
  { value: 'Pop', label: '啵' },
  { value: 'Purr', label: '呼噜' },
  { value: 'Submarine', label: '潜艇' },
  { value: 'Hero', label: '英雄' },
  { value: 'Funk', label: '放克' },
  { value: 'none', label: '静音' },
]
