# Git Docs 源码

## 一条命令生成 Docker 镜像包

准备 **Node.js 24（含 npm）和已启动的 Docker**。Windows、Linux、macOS 均可执行。在本目录运行：

```bash
npm run docker:package
```

**不需要提前执行 npm install，也不需要 Git、Java、Maven、Python、Compose 或启动脚本。**

命令在 Docker 构建阶段安装锁定依赖、运行测试、打包应用，并依次构建 amd64 和 arm64 两个原生镜像，最后导出到：

```text
dist/release/
├── git-docs-images.tar.gz
└── git-docs-images.tar.gz.sha256
```

同一个归档包含两个镜像：

- `git-docs:1.7.1-amd64`：Intel/AMD 电脑，包括 Windows、Linux、Intel Mac。
- `git-docs:1.7.1-arm64`：Apple M 系列 Mac、ARM64 Linux。

两个独立标签放在一个 Docker archive 中，不要求 Docker 开启 containerd 镜像存储。接收方只需 Docker，不需要 Node/npm，也不需要连接镜像仓库。

首次构建需要联网下载官方 Node 基础镜像和 npm 包，网络受限时应预先配置你现有的 Docker/npm 网络访问。命令使用已有 Docker builder，不会安装额外构建服务或修改 Docker 设置。应用构建和测试在构建主机的原生架构完成；最终镜像使用各自架构的官方 Node 运行时，不需要手动安装模拟器。

## 本地开发

```bash
npm ci
npm run build
npm test
npm run init
npm start
```

本地初始化和运行默认使用 `dist/data/`，可通过 `GIT_DOCS_DATA` 指定其他目录。测试临时文件放在 `dist/test/`，测试结束自动清理；镜像包输出到 `dist/release/`。`test/` 保存测试源码。

`dist/` 内含本地初始化配置和缓存，清理构建结果时不要删除整个目录；重新构建只更新程序文件。Docker 仍使用外部挂载的 `/data`。

源码目录：

```text
src/                       GitLab / GitHub / Gitee 同步、Markdown 处理与 HTTP 服务
public/                    阅读与管理网页（不依赖外网 CDN）
docker/entry.cjs            首次自动初始化与密码重置
Dockerfile                 多阶段构建
scripts/docker-package.mjs 两种架构构建、导出、压缩
scripts/licenses.mjs       第三方许可收集
scripts/build.mjs          打包应用并按 package.json 注入版本号
test/                      模拟 GitLab 与自动化测试
```

## 部署约定

服务监听容器内 8080，所有可变数据都在 `/data`。宿主机只需把选定的外部目录绑定到 `/data`。本版为了兼容首次挂载的空目录，使用容器默认用户写入；Linux 上生成文件默认归 root 所有。可由有经验的管理员使用可写目录配合 `--user UID:GID`，但不是部署必需步骤。

首次启动自动创建 `config.json`、`admin-password.txt`。Git 仓库地址、Token、文档副本都保存到外部目录；网页“管理仓库”可添加多个仓库。默认每 10 分钟同步。

主要限制：单篇 MD 2MB、单资源 25MB、每仓库文档与资源总量 256MB、仓库压缩包 512MB；不展开 Git 子模块，不下载 LFS 图片。阅读页面不继承 GitLab 用户权限，因此端口应按需要限制访问范围。

打包不会包含本地 data、Token、文档缓存或镜像归档；`.dockerignore` 使用白名单。版本号只需修改 `package.json`：镜像标签、镜像内的版本标签和请求 User-Agent 都由它自动生成，发布时再同步 3-部署说明.md 里的示例标签即可。

## 推送即同步（webhook）

在 Git 平台给仓库加一条 Webhook，push 之后平台会主动通知本服务，文档几秒内就更新，不用等定时同步。

- 地址填：http://服务器地址:端口/hook?token=密码
- 密码默认就是管理密码。如果想让推送用的密码和管理密码分开，给容器设置环境变量 GIT_DOCS_HOOK_TOKEN 即可，设置后只认这个值。
- 内容类型：GitLab 保持默认的 application/x-www-form-urlencoded 就行，GitHub 和 Gitee 选 application/json。也支持 GitLab / Gitee 的密码字段，服务会同时读 X-Gitlab-Token 和 X-Gitee-Token 请求头。
- 触发事件：只要 push（推事件），不必勾选全部。

服务收到通知后只会处理配置里已有的仓库，并且同一个仓库 15 秒内只触发一次，避免一次 push 的多条通知重复同步。定时同步仍然保留，作为兜底。

安全提醒：写进地址的密码会以明文保存在 Git 平台的 Webhook 配置里，能看到这个仓库设置的人都能看到它。如果这批人和使用管理后台的不是同一批人，建议改用独立的 GIT_DOCS_HOOK_TOKEN。


## 给 AI 使用（MCP 与原始 Markdown）

服务内置一个面向 AI 的独立模块，复用同一份已同步的文档，不额外占用存储，也不影响阅读页面。主服务只把匹配到的路由转发给它。

- POST /mcp：MCP 端点，提供 list_repos、list_branches、list_docs、search_docs、get_doc 五个工具，其中 get_doc 返回原始 Markdown。
- GET /raw?repo=&branch=&path=：直接返回单篇文档的原始 Markdown（text/markdown）。
- GET /llms.txt：文档索引；加 ?repo=仓库ID 可列出该仓库全部文档的链接。

支持远程 MCP 的 AI 客户端接入示例：

    claude mcp add --transport http git-docs http://服务器地址:端口/mcp
    codex mcp add git-docs --url http://服务器地址:端口/mcp

只读保证：该模块只读取已同步的快照，不写入数据目录，也不会读取或返回仓库 Token。默认不校验令牌，与阅读接口一致；若要把端口暴露到更大范围，设置环境变量 GIT_DOCS_AI_TOKEN 后，以上三个端点都必须带 Authorization: Bearer 令牌。

## 平台识别与访问权限

根据地址识别 github.com、gitee.com，其他普通内网地址按自建 GitLab 处理。GitLab Token 需 read_api；GitHub 私有仓库的细粒度 Token 需 Contents 只读权限；Gitee Token 需 projects 权限。所有平台的 Token 都可留空；填写时优先认证，无效不降级，未填写时匿名读取公开仓库。Gitee 匿名模式通过公开 tree/blob API 读取所选文件，以兼容其归档 API 要求认证的限制；文件多时会受匿名 API 限流约束。三者均还需有对应仓库的访问权限。Token 只发给各自平台的 API；归档跨域跳转不转发 Token。

GitHub Enterprise、Gitee 私有化专用域名未适配。特殊 GitLab 子路径部署可在 config.json 的仓库条目保留 gitlabBase，并将 project 设为相对该根地址的 group/repo，正常部署无需配置。

构建脚本会缓存两个官方 Node 基础镜像为 git-docs-node-base:24-amd64 / 24-arm64，后续重复打包复用缓存。如需更新基础镜像，删除这两个仅供构建的本地标签后重新打包，或自行拉取新版本并更新标签。


## 1.2.0 阅读体验更新

- 自动生成二、三级标题大纲，支持定位与当前章节高亮。
- 代码块复制、标题链接复制、返回顶部。
- 目录自然排序，减少标题与文件名重复显示。
- 文档不存在或加载失败时保留侧栏，提供重新加载和返回仓库入口。
- 窄屏默认收起目录，可随时展开。

复制在浏览器不允许时会提示手动复制。更新仍挂载原数据目录，密码和仓库配置继续使用。


## 1.3.0 多分支阅读

新增仓库无需配置分支，自动同步默认分支。阅读页左侧文档数量下方可筛选、切换分支：绿色已同步，灰色未同步，蓝色同步或排队中，红色失败可重试。首次切换会显示正在同步，请等待；完成后自动打开。已同步分支直接读取本地文档。每个访问者的分支保存在地址栏中，分享链接会保留分支，互不影响。

同一仓库同一分支的并发请求共用同步任务，最多同时同步两个分支，其余排队（最多50个任务）。已使用分支按原同步间隔检查更新，失败保留上一版。未使用分支不预先下载。

文档位于 repos/仓库ID/branches/分支摘要/versions/版本ID/files/，branch.json 记录真实分支名，内部保留原目录。摘要目录兼容含斜杠和中文的分支名。每个分支独立保留最多两个成功版本。分支越多，占用空间越多。旧版本文档首次启动自动迁移，旧目录保留用于回退；大仓库迁移期间服务启动可能较慢。原有配置指定的分支作为初始展示分支兼容保留。


## 1.4.0 稳定性和缓存管理

分支状态每5秒刷新，保留展开和筛选状态。显示排队、检查更新、下载、处理、失败及最后成功同步时间。已有缓存和更新失败分别显示，更新失败仍能阅读旧版并重试；缓存出现新版时可手动刷新文章，避免打断阅读。

管理仓库 → 分支缓存：查看文档数量和实际占用空间（包括历史版本与下载缓存），清理非默认分支缓存。统计大仓库可能需要等待。默认展示分支保留；同步或清理期间禁止冲突操作。仅删除本地分支缓存，Git仓库不受影响，下次访问重新同步。

重启会清理没有完成索引的临时版本。磁盘空间不足时保留最后成功文档。修改仓库地址会创建独立的新存储身份，避免旧仓库文档串入新地址；旧目录保留用于人工恢复，不自动删除。


## Mermaid 图表

文档里的代码块语言写 mermaid，阅读页会渲染成图，支持流程图（graph / flowchart）、时序图（sequenceDiagram）、状态图、类图等 Mermaid 支持的图形，适合画模块依赖、调用时序。

模块依赖图示例：

    graph TD
      app[业务应用] --> auth[auth 权限模块]
      app --> common[common 公共工具]
      auth --> common

图表在浏览器本地渲染，脚本来自服务自身的 /vendor/mermaid，不依赖外网 CDN，而且只在页面真的出现图表时才加载。构建时会把 Mermaid 复制到 dist/vendor/mermaid（已被 gitignore，不属于源码），Docker 镜像里也已包含，因此离线可用。

因为 Mermaid 会把主题样式写进生成的 SVG，CSP 的 style-src 保留了 'unsafe-inline'；script-src 仍是 'self' 不变。


## 1.7.1 下载原文

文档页右上角新增“下载原文”，把当前文档的原始 Markdown 存成 .md 文件，文件名沿用仓库里的原名。“复制原文”保留，方便直接粘贴给 AI。


## 1.7.0 阅读体验与性能

阅读页新增深色模式（页头可切换，默认跟随系统）、面包屑、上一篇/下一篇（顺序与侧栏目录一致）、点击图片放大，以及“复制原文”一键复制当前文档的原始 Markdown。

新增 Mermaid 图表：代码块语言写 mermaid 就会渲染成图，适合画模块依赖和调用时序；图表在浏览器本地渲染，脚本来自服务自身，不依赖外网 CDN，而且只在页面真的出现图表时才加载。

性能方面：文本响应启用 Brotli/gzip 压缩，5612 篇文档的列表从 743KB 降到 150KB；文档图片改为流式返回并带 ETag 和长缓存，不再每次切文档重下；搜索复用了大小写索引，5612 篇的搜索从约 150ms 降到约 60ms。

新增“推送即同步”的 webhook：在 Git 平台配置一条地址即可，push 后几秒内更新。


## 1.6.0 面向 AI 的接入与版本统一

新增独立 AI 模块（src/ai），复用同一份已同步文档：只读，不写数据目录，不读取或返回仓库 Token。提供单篇原始 Markdown 接口 /raw、文档索引 /llms.txt，以及 MCP 端点 /mcp，内置 list_repos、list_branches、list_docs、search_docs、get_doc 五个工具，供业务组的 AI 参考框架文档进行开发。默认不校验令牌；设置 GIT_DOCS_AI_TOKEN 后，三个端点都需要 Bearer 令牌并校验 Origin。

版本号改为只在 package.json 维护：镜像标签、镜像内版本标签和请求 User-Agent 都由它生成。新增站点图标 favicon.svg。删除仓库或更换仓库地址时清理旧入口的文档缓存，启动时清理已不在配置中的孤立缓存目录。


## 1.5.0 性能与便捷设置

缓存管理现在直接读取持久化大小记录，显示当前版本的MD和资源总大小，不再统计历史版本和下载缓存。新同步处理文件时累计大小写入索引；旧缓存首次启动后台补统计并保存usage.json，完成前显示后台统计中，打开管理页不等待。

目录按展开层级生成，文档列表短暂缓存15秒。分支按当前、默认、最近使用、其他已缓存和未同步排序，最近使用记录保存在本浏览器。搜索仅针对当前分支，标题和路径优先，匹配词高亮。

管理页新增站点设置：可修改同步间隔（1–1440分钟）和密码（10–256位，需重复输入确认）。留空密码不修改，保存后立即生效；其他已登录管理页面在密码变更后需要重新登录。
