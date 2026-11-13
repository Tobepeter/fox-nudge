# FoxNudge

macOS 菜单栏小工具：往 ntfy 主题广播一条消息，订阅了同一主题的电脑弹系统通知并响一声

```bash
pnpm env:open      # 从 secrets/env.sops.yaml 解出 .env（内置令牌和共享密钥）
pnpm dev           # 桌面开发版，Vite 5183，探针 5193
pnpm dev:web       # 浏览器 Web 模拟
pnpm probe -- snapshot
pnpm test
pnpm install:app   # 打包并覆盖安装到 /Applications
```

`curl` 也能直接发，桌面端显示为未知发送者：

```bash
curl -H "Authorization: Bearer $NTFY_TOKEN" -d '任务完成' "$NTFY_URL/$NTFY_TOPIC"
```

## 头像版权

头像由 [DiceBear](https://www.dicebear.com/) 生成，大部分风格为 CC0 或作者声明可免费使用。以下风格按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用：Adventurer（Lisa Wischofsky）、Big Ears（The Visual Team）、Big Smile（Ashley Seo）、Croodles（vijay verma）、Dylan（Natalia Spivak）、Fun Emoji（Davis Uche）、Micah（Micah Lanier）、Miniavs（Webpixels）、Personas（Draftbit）、Toon Head（Johan Melin）
