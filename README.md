# LeetCode 练习客户端（第三方）

技术栈：Vite + Vue 3 + Tailwind CSS v4（使用 `@tailwindcss/vite` 插件，不使用 PostCSS）+ Iconify。

## 环境要求

- Node.js：推荐 22.x（LTS）。Node 20+ 也可运行，但在 Windows 上如遇到原生 N-API 相关崩溃，优先切换到 Node 22。

## 开发启动

```bash
npm install
npm run dev
```

- 前端：Vite 默认端口（通常是 5173）
- 本地服务：`http://localhost:8787`（前端通过 Vite 代理访问 `/api/*`）

## 登录方式（Cookie）

当前使用“把浏览器里的 LeetCode Cookie 粘贴到本地服务”的方式建立会话：

1. 在浏览器登录 `leetcode.com` 或 `leetcode.cn`
2. 打开开发者工具获取 Cookie（至少需要 `csrftoken`、`LEETCODE_SESSION`）
3. 在页面的认证区域粘贴 Cookie，并选择对应域名

本地服务会把会话保存到 httpOnly Cookie（`lc_sid`）中，前端之后请求 `/api/*` 不需要再手动带 Cookie。
