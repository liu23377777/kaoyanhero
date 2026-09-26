# 考研勇者打卡 V3.0

一个把文字记录与学习照片交给多模态模型评价的本地 Web 应用。支持 DeepSeek V4.1 Flash、阿里百炼 Qwen、智谱 GLM、火山方舟/豆包、安知鱼中转以及任意 OpenAI Chat Completions 兼容接口。

V3 支持一次上传最多 6 张学习图片、按知识点生成系统复盘与相关题型、用户自定义主题、Supabase 多用户账户，以及打卡后同步 Habitica 任务。未配置 Supabase 时自动回退为本机演示模式。

## 启动

1. 安装 Node.js 18 或更高版本。
2. 将 `.env.example` 复制为 `.env`。
3. 至少填写一个平台的 API Key；模型名可按控制台实际可用模型调整。
4. 运行 `npm start`，打开 `http://localhost:3000`。

项目当前只使用 Node.js 内置模块，不需要额外安装 npm 依赖。

## Supabase 多用户模式

1. 在 Supabase 创建一个项目。
2. 打开 SQL Editor，完整执行 `supabase-schema.sql`。
3. 从 Project Settings > API 复制 Project URL 与 anon/publishable key。
4. 在 `.env` 填写：

```env
SUPABASE_URL=https://你的项目.supabase.co
SUPABASE_ANON_KEY=你的匿名公开Key
SUPABASE_SERVICE_ROLE_KEY=你的Legacy service_role Key
ADMIN_PASSWORD=管理后台独立强密码
APP_ENCRYPTION_KEY=至少32个字符且部署后不再更换的随机密钥
PUBLIC_APP_URL=http://localhost:3000
DAILY_AI_REQUEST_LIMIT=10
```

配置后重启服务。网页会自动切换到云端模式，邮箱账户、经验、金币、连胜、打卡历史和 AI 偏好将在不同设备间同步。

如需 Google 登录，在 Supabase Authentication > Providers 启用 Google，将线上域名加入 Redirect URLs，然后设置：

```env
ENABLE_GOOGLE_AUTH=true
```

`APP_ENCRYPTION_KEY` 用于 AES-256-GCM 加密每位用户的 Habitica Token。更换此值会导致已保存的 Token 无法解密。

## 管理员审核

访问 `/#admin` 进入管理后台。新注册账户默认状态为“待审核”，管理员需要选择“通过”或“未通过”并填写评语；审核结果、评语与审核时间会显示给该用户。只有“已通过”账户可以提交 AI 打卡，数据库函数也会在服务端再次校验状态。

如果数据库是在审核功能上线前创建的，请在 Supabase SQL Editor 中重新完整执行一次最新的 `supabase-schema.sql`。脚本会保留现有用户数据，把旧的 `approved=true` 迁移为“已通过”、其他旧记录迁移为“待审核”，并新增三态审核与评语字段。脚本不会把现有已通过用户批量重置。

`SUPABASE_SERVICE_ROLE_KEY` 与 `ADMIN_PASSWORD` 只能保存在服务端环境变量中。管理员用户列表需要 Legacy `service_role` Key；不要使用 `anon`/publishable Key，也不要把该密钥写入网页或提交到 Git。

## Render 免费部署

仓库根目录已包含 `render.yaml`：

1. 将项目提交到 GitHub，确认 `.env` 未进入仓库。
2. 在 Render 选择 New > Blueprint，连接仓库。
3. 在 Render 环境变量中填写 Supabase、AI 平台和 `PUBLIC_APP_URL`。
4. 部署完成后，把 Render 生成的 HTTPS 地址同时填入 `PUBLIC_APP_URL` 和 Supabase Redirect URLs。
5. 打开 `/api/health`，返回 `{"ok":true}` 即部署成功。

Render 免费实例会休眠，但用户数据保存在 Supabase，不会因服务重启丢失。

## 平台配置

| 平台 | Base URL | 默认模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`（当前指向 V4.1 Flash） |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` |
| 阿里百炼 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-8b-instruct` |
| 火山方舟 / 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-vision-250815` |
| 安知鱼 | `https://sub.anzhiyu.com/v1` | 请按站点模型列表填写 |
| 自定义 | 通过 `CUSTOM_BASE_URL` 设置 | 通过 `CUSTOM_MODEL` 设置 |

方舟部分账号要求填写控制台创建的“推理接入点 ID”，这时直接将 `ARK_MODEL` 改为该 ID。

## Habitica 同步

本机模式可以在 `.env` 手动填写 Habitica 凭据，也可以在网页中一键配置。Supabase 多用户模式下，每个账户独立保存 Habitica User ID、任务 ID 和经过服务端加密的 API Token；任何用户都不会覆盖其他用户的配置。

## 安全说明

- API Key 只保存在服务端 `.env` 中，不会发到浏览器或写入前端源码。
- 自定义 Base URL 只能在服务端配置，避免网页请求被利用访问内网地址。
- 使用第三方中转站时，学习文字和照片会经过该服务。请勿上传身份证、准考证、聊天记录或包含其他隐私的照片。
- Supabase 模式使用 HttpOnly、SameSite Cookie 保存会话，访问数据库时由 Row Level Security 隔离用户数据。
- 免费公开测试建议保留 `DAILY_AI_REQUEST_LIMIT`，避免共享 AI Key 被滥用。
- 本机演示模式下，等级、经验、金币和打卡历史仍保存在当前浏览器的 `localStorage`。
