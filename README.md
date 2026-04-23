# 💕 恋爱记事簿 (Love Diary)

> 一款专为情侣设计的私密聊天记事应用，记录每一份甜蜜瞬间。

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![License](https://img.shields.io/badge/license-MIT-yellow.svg)

---

## 📖 项目概述

### 项目名称
**恋爱记事簿 (Love Diary)** — 一个充满爱意的情侣私密交流与回忆记录平台。

### 项目目标
为情侣提供一个安全、美观、私密的数字空间，用于日常聊天交流、分享照片、记录美好时刻。所有图片数据均经过 AES-256 加密存储，确保隐私安全。

### 主要功能

| 功能模块 | 描述 |
|---------|------|
| 💬 消息聊天 | 支持文本消息和图片消息的发送，气泡式对话界面 |
| 👤 双人身份 | 自定义发送者身份（小洋 / 小蔡），配合专属头像 |
| 😊 表情选择 | 内置 80+ 常用表情，一键插入聊天内容 |
| 📷 图片上传 | 聊天中发送图片，支持 JPG/PNG/GIF/WebP/BMP 格式 |
| 🖼️ 相册管理 | 独立相册功能，支持多图批量上传、缩略图浏览、原图查看 |
| 🔐 加密存储 | 所有图片采用 AES-256-CBC 对称加密，磁盘上不留明文 |
| ⏱️ 实时更新 | 基于 HTTP 长轮询的实时消息推送机制 |
| ✅ 已读回执 | 自动检测消息可见性并标记已读状态 |
| 💗 爱心动画 | Canvas 粒子动画背景，漂浮的粉色爱心营造浪漫氛围 |
| 📱 移动适配 | 全响应式设计，完美支持手机、平板、桌面端 |
| ✏️ 消息编辑 | 支持对已发送消息的内容编辑 |
| 🗑️ 消息删除 | 支持删除消息及关联的图片附件 |

### 技术栈

#### 后端
- **[Express.js](https://expressjs.com/)** v4.x — Web 应用框架，构建 RESTful API
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** v11.x — SQLite 数据库驱动（同步 API，WAL 模式）
- **[Multer](https://github.com/expressjs/multer)** v2.x — multipart/form-data 文件上传处理
- **[Sharp](https://sharp.pixelplumbing.com/)** — 高性能图片处理库（缩略图生成）
- **Node.js Crypto** — 内置加密模块（AES-256-CBC、PBKDF2-SHA512）

#### 前端
- **原生 HTML/CSS/JavaScript** — 无框架依赖，轻量高效
- **CSS Glassmorphism** — 毛玻璃拟态设计风格
- **Canvas 2D API** — 粒子爱心背景动画系统
- **IntersectionObserver API** — 已读回执自动检测
- **Fetch API + Long Polling** — 实时消息通信

#### 安全机制
- PBKDF2-SHA512 密码哈希（100,000 次迭代）
- AES-256-CBC 图片加密存储（随机 IV）
- Bearer Token 认证（7 天有效期）
- CSRF 令牌防护（一次性令牌策略）
- 登录速率限制（防暴力破解）
- Magic Bytes 文件校验（防伪装攻击）
- 路径穿越防御

---

## 🎨 项目展示

### 界面预览

> **提示**: 访问在线演示地址查看实际运行效果。

#### 主界面特性
- 🌸 粉色系浪漫主题配色
- 💗 Canvas 动态爱心粒子背景
- 💬 聊天气泡式消息展示（左右区分发送者）
- 👤 发送者头像个性化显示
- 📱 底部工具栏：发送者选择、输入框、表情按钮、图片上传按钮
- 🔄 下拉加载更多历史消息

#### 相册界面
- 📸 网格布局缩略图浏览（300×300 JPEG）
- 🔍 点击查看原始分辨率大图
- ➕ 批量多图上传
- 🗑️ 单张照片删除确认

---

## 🚀 部署指南

### 环境要求

| 环境 | 要求 |
|------|------|
| **Node.js** | >= 18.0.0 (推荐 LTS 版本) |
| **npm** | >= 9.0.0 (随 Node.js 安装) |
| **操作系统** | Linux / macOS / Windows |
| **内存** | >= 256MB RAM |
| **磁盘空间** | >= 100MB（不含用户上传数据） |

### 安装步骤

#### 1. 克隆或下载项目

```bash
# 如果使用 Git
git clone <repository-url>
cd love-diary

# 或直接下载解压后进入项目目录
cd 恋爱记事簿
```

#### 2. 安装依赖

```bash
npm install
```

> **注意**: `better-sqlite3` 包含原生 C++ 模块，需要编译工具链。
> - **Windows**: 通常无需额外操作，npm 会自动处理
> - **Linux**: 可能需要安装 `build-essential` 或 `python3`、`make`、`g++`
> - **macOS**: 可能需要执行 `xcode-select --install`
>
> 如遇编译问题，可尝试：
> ```bash
> npm install --build-from-source
> ```

#### 3. （可选）配置环境变量

项目开箱即用，默认配置即可运行。生产环境建议设置以下环境变量：

```bash
# 加密密钥（必须为强随机字符串，至少32字符）
export IMAGE_ENCRYPTION_KEY='your-super-secret-random-key-here'

# 服务端口（默认 520）
export PORT=520
```

#### 4. 启动服务

**开发模式：**
```bash
npm start
# 或
node server.js
```

**生产环境（使用 PM2）：**
```bash
# 安装 PM2（如未安装）
npm install -g pm2

# 启动服务
pm2 start ecosystem.config.cjs

# 设置开机自启
pm2 save
pm2 startup
```

#### 5. 访问应用

启动成功后，在浏览器中访问：

```
http://localhost:520
```

### 配置说明

| 配置项 | 默认值 | 说明 |
|--------|-------|------|
| `PORT` | `520` | 服务监听端口 |
| `IMAGE_ENCRYPTION_KEY` | `love-diary-2024-aes256-secret-key` | AES 加密主密钥（**生产环境务必修改**） |
| `NODE_ENV` | - | 运行环境标识 |

### 默认账号

| 用户名 | 密码 | 显示名称 |
|--------|------|---------|
| `xiaozhong` | `love0815` | 小洋 |
| `xiaocai` | `love0815` | 小蔡 |

> ⚠️ **安全提示**: 首次部署后请立即修改默认密码。可通过数据库直接更新密码哈希值。

### 生产环境部署（Linux + Nginx + PM2）

#### Nginx 反向代理配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:520;

        # 超时配置（长轮询需要较长超时）
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;

        # 缓冲配置
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;

        # WebSocket 支持（长轮询需要）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 头部转发
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### 一键部署脚本

项目提供了 `fix-502.sh` 自动化部署脚本（适用于宝塔面板环境），包含：
- PM2 进程管理
- 端口占用检测与释放
- better-sqlite3 编译修复
- Nginx 配置优化（超时 + 健康检查）
- 服务健康检查

```bash
chmod +x fix-502.sh
./fix-502.sh
```

### 常见问题解决

<details>
<summary><b>❌ 端口已被占用（EADDRINUSE）</b></summary>

```bash
# 查找占用端口的进程
netstat -ano | findstr :520      # Windows
lsof -i :520                      # Linux/macOS

# 终止进程后重启
taskkill /PID <进程ID> /F         # Windows
kill -9 <PID>                     # Linux/macOS
```

</details>

<details>
<summary><b>❌ better-sqlite3 编译失败</b></summary>

```bash
# 清除缓存后重新编译安装
npm cache clean --force
rm -rf node_modules
npm install --build-from-source
```

如果仍然失败，确保系统已安装编译工具链：
```bash
# Ubuntu/Debian
sudo apt-get install build-essential python3

# CentOS/RHEL
sudo yum groupinstall "Development Tools"
sudo yum install python3

# macOS
xcode-select --install
```

</details>

<details>
<summary><b>❌ 图片上传失败（请求失败）</b></summary>

可能原因及解决方案：

1. **文件大小超限** — 聊天图片上限 5MB，相册图片上限 20MB
2. **文件格式不支持** — 仅支持 jpg/jpeg/png/gif/webp/bmp
3. **JSON Body 超限** — 已调整为 10MB，若仍报错可修改 `server.js` 中的 `express.json({ limit: '10mb' })`
4. **加密失败** — 检查磁盘写入权限和可用空间

</details>

<details>
<summary><b>❌ 图片无法显示（401 Unauthorized）</b></summary>

图片访问需要有效的认证 Token。前端会自动附加 Token 到图片请求 URL 的 query 参数中。如果遇到此问题：

1. 确认已登录且 Token 未过期（7 天有效期）
2. 检查浏览器控制台是否有网络请求错误
3. 清除 localStorage 后重新登录

</details>

<details>
<summary><b>❌ 长轮询不工作 / 消息不实时更新</b></summary>

1. 确认 Nginx 配置中启用了 WebSocket/长连接支持（参考上方 Nginx 配置）
2. 检查 `proxy_read_timeout` 是否设置为 60s 以上
3. 确认防火墙未阻止长连接

</details>

<details>
<summary><b>❌ PM2 重启后出现 502 错误</b></summary>

```bash
# 使用优雅重启而非强制重启
pm2 reload love-diary

# 如果仍无效，检查日志
pm2 logs love-diary --lines 50

# 确认端口正常监听
curl http://127.0.0.1:520/
```

</details>

---

## 📖 使用说明

### 基本操作流程

```
打开应用 → 输入账号密码登录 → 进入主界面 → 开始聊天/传图/管理相册
```

### 功能模块介绍

#### 🔐 登录认证
1. 在登录页面输入用户名和密码
2. 点击「登录」按钮完成认证
3. 登录成功后跳转到主界面，Token 有效期为 7 天
4. 点击头像区域可退出登录

#### 💬 发送消息
1. 在左侧下拉框选择发送者身份（小洋 / 小蔡）
2. 在输入框中输入文字内容
3. 点击发送按钮（或按 Enter 键）发送消息
4. 消息以气泡形式显示，根据发送者区分左右位置

#### 😊 插入表情
1. 点击输入框右侧的笑脸图标（😊）打开表情选择面板
2. 从 80+ 个常用表情中选择一个
3. 表情自动插入到输入框光标位置
4. 再次点击笑脸图标关闭面板

#### 📷 发送图片（聊天中）
1. 点击输入框右侧的📷图标按钮
2. 在文件选择器中选择图片文件（支持多选）
3. 选中的图片会显示预览缩略图
4. 点击「发送」按钮将图片作为消息发送

#### 🖼️ 相册管理
- **浏览照片**: 点击底部导航栏的「相册」标签，以网格形式浏览所有照片缩略图
- **查看大图**: 点击任意缩略图即可查看该照片的原始分辨率版本
- **上传照片**: 点击「上传照片」按钮，可选择多张图片批量上传至相册
- **删除照片**: 悬停在照片上点击删除图标，确认后删除（同时清除缩略图缓存）

#### ✏️ 编辑消息
1. 将鼠标悬停在已发送的消息上
2. 点击出现的「编辑」图标按钮
3. 修改消息内容后点击确认保存

#### 🗑️ 删除消息
1. 将鼠标悬停在要删除的消息上
2. 点击出现的「删除」图标按钮
3. 在确认对话框中确认删除操作
4. 关联的图片附件会被同步删除

#### 📜 加载历史消息
- 在消息列表区域向下滚动
- 当滚动到接近顶部时，自动触发历史消息加载
- 支持分页加载，避免一次性加载过多数据

---

## 📁 项目结构

```
恋爱记事簿/
├── server.js                  # Express 服务器入口（API路由、中间件、启动逻辑）
├── auth.js                    # 认证授权模块（登录/登出/Token/CSRF/速率限制）
├── database.js                # SQLite 数据库管理（单例连接、表结构、种子数据）
├── crypto-utils.js            # 加密工具（PBKDF2密码哈希/Token生成/安全比较）
├── image-crypto.js            # 图片加解密（AES-256-CBC/流式解密/批量迁移）
├── package.json               # 项目配置和依赖声明
├── package-lock.json          # 依赖锁定文件
├── ecosystem.config.cjs       # PM2 进程管理配置（生产环境部署）
├── fix-502.sh                 # 一键部署脚本（Nginx配置修复+PM2重启）
│
├── public/                    # 前端静态资源目录
│   ├── index.html             # SPA 单页应用入口（HTML结构）
│   ├── css/
│   │   └── style.css          # 样式表（响应式布局/毛玻璃效果/动画）
│   ├── js/
│   │   └── app.js             # 前端核心逻辑（UI交互/API调用/状态管理）
│   ├── assets/
│   │   ├── avatar_girl.png    # 小洋的头像图片
│   │   └── avatar_boy.png     # 小蔡的头像图片
│   └── images/
│       ├── xiaoyang-avatar.png
│       └── xiaocai-avatar.png
│
├── data/                       # 运行时数据目录（首次启动自动创建）
│   ├── love-diary.db           # SQLite 主数据库文件
│   ├── love-diary.db-wal       # WAL 日志文件
│   ├── love-diary.db-shm       # WAL 共享内存文件
│   ├── uploads/                # 聊天图片存储（加密）
│   ├── album/                  # 相册照片存储（加密）
│   └── thumbnails/             # 缩略图缓存（明文JPEG）
│
└── .workbuddy/                 # IDE 工作区配置（可忽略）
```

### 核心文件说明

| 文件 | 职责 | 核心导出/功能 |
|------|------|-------------|
| `server.js` | HTTP 服务器主入口 | 20+ RESTful API 端点、中间件注册、安全头配置 |
| `auth.js` | 身份认证与授权 | `authMiddleware`、`loginHandler`、`logoutHandler`、CSRF 管理 |
| `database.js` | 数据库连接与初始化 | `getDb()` 单例、4 张表定义、数据迁移、种子数据 |
| `crypto-utils.js` | 密码学与随机数 | `hashPassword()`、`verifyPassword()`、`generateToken()` |
| `image-crypto.js` | 图片加密存储 | `encryptFile()`、`streamDecryptedFile()`、`generateThumbnail()` |
| `public/js/app.js` | 前端应用逻辑 | UI 渲染、API 通信、长轮询客户端、事件绑定 |

### API 接口总览

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/api/login` | 用户登录 | 否 |
| POST | `/api/logout` | 用户登出 | 是 |
| GET | `/api/csrf-token` | 获取 CSRF 令牌 | 是 |
| GET | `/api/messages` | 获取消息列表 | 是 |
| POST | `/api/messages` | 发送消息 | 是 + CSRF |
| PUT | `/api/messages/:id` | 编辑消息 | 是 + CSRF |
| DELETE | `/api/messages/:id` | 删除消息 | 是 + CSRF |
| GET | `/api/messages/poll` | 长轮询新消息 | 是 |
| POST | `/api/messages/read` | 标记已读 | 是 + CSRF |
| GET | `/api/messages/unread-count` | 获取未读数 | 是 |
| POST | `/api/upload` | 上传聊天图片 | 是 + CSRF |
| GET | `/api/album` | 获取相册列表 | 是 |
| POST | `/api/album/upload` | 上传相册图片 | 是 + CSRF |
| DELETE | `/api/album/:id` | 删除相册照片 | 是 + CSRF |
| GET | `/api/album/thumbnail/:id` | 获取缩略图 | 是 |
| GET | `/uploads/*` | 加密图片解密服务 | 是 |
| GET | `/album/*` | 加密图片解密服务 | 是 |

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request 来改进本项目！

### 开发流程

1. **Fork** 本仓库到你的 GitHub 账号
2. **Clone** 你的 Fork 到本地：`git clone https://github.com/<your-username>/love-diary.git`
3. 创建特性分支：`git checkout -b feature/your-feature-name`
4. 进行开发并确保代码风格一致
5. 提交更改：`git commit -m "feat: 添加某功能"`
6. 推送到你的 Fork：`git push origin feature/your-feature-name`
7. 创建 Pull Request 并描述你的改动

### 代码规范

- JavaScript 代码需添加 JSDoc 注释（函数参数、返回值、用途说明）
- 保持现有的代码风格和命名约定
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范
- 确保修改不影响现有功能的正常运行

### Issue 报告

提交 Issue 时请包含以下信息：
- 问题描述和复现步骤
- 运行环境（操作系统、Node.js 版本、浏览器）
- 相关的错误日志或截图
- 期望行为 vs 实际行为

---

## 📄 许可证

本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源。

```
MIT License

Copyright (c) 2024 Love Diary Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<p align="center">
  Made with 💕 by Love Diary Team
</p>
