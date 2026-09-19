# 中国象棋 AI 竞技场

纯前端的中国象棋 AI 对战页面：两个大模型各执红黑一方，通过工具调用（`legal_moves` / `look_board` / `commit_move` / `resign`）在本地裁判规则下对弈。没有后端，没有数据库——页面托管在 GitHub Pages，浏览器直接调用大模型厂商的 OpenAI 兼容接口。

- 在线地址：`https://keyblues.github.io/chinese-chess-ai-arena/`
- 使用方式：打开页面 → 设置里填入厂商 Base URL、API Key、红黑双方的模型 ID → 开局。
- API Key 只保存在你自己浏览器的 localStorage 里，只会发给你填的那个厂商，不经过任何第三方。

## 厂商直连支持（浏览器 CORS）

浏览器调外部 API 受 CORS 约束：厂商服务器必须返回 `Access-Control-Allow-Origin` 等响应头，页面才能读到响应。这由厂商决定，纯静态页面无法绕过。以下为实测结果（2026-09）：

| 厂商 | Base URL | 浏览器直连 |
|---|---|---|
| SiliconFlow | `https://api.siliconflow.cn/v1` | ✅ |
| DeepSeek | `https://api.deepseek.com` | ✅ |
| Kimi / Moonshot | `https://api.moonshot.cn/v1` | ✅ |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | ✅ |
| OpenRouter | `https://openrouter.ai/api/v1` | ✅ |
| 日日新 SenseNova | `https://token.sensenova.cn/v1` | ❌ OPTIONS 预检缺响应头 |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | ⚠️ 实际响应未带跨域头，待验证 |

验证某个厂商的方法：

```bash
curl -s -o /dev/null -D - -X OPTIONS "<厂商地址>/chat/completions" \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

响应里同时有 `Access-Control-Allow-Origin` 和 `Access-Control-Allow-Headers`（含 authorization）即可直连。

## 部署到 GitHub Pages

仓库就是最终产物，无需构建：

1. 把代码推到 GitHub 仓库。
2. 仓库 Settings → Pages → Source 选 `main` 分支 `/ (root)`。
3. 访问 `https://<用户名>.github.io/<仓库名>/`。

## 安全提示

- 不要把 API Key 提交进仓库。
- 在聊天或截图里泄露过的 Key 建议立即作废重建。
