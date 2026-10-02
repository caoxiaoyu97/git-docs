# Git Docs 源码

## 一条命令生成 Docker 镜像包

准备 **Node.js 24（含 npm）和已启动的 Docker**。Windows、Linux、macOS 均可执行。在本目录运行：

```bash
npm run docker:package
```

**不需要提前执行 npm install，也不需要 Git、Java、Maven、Python、Compose 或启动脚本。**

命令在 Docker 构建阶段安装锁定依赖、运行测试、打包应用，并依次构建 amd64 和 arm64 两个原生镜像，最后导出到：

```text
release/
├── git-docs-images.tar.gz
└── git-docs-images.tar.gz.sha256
```

同一个归档包含两个镜像：

- `git-docs:1.2.0-amd64`：Intel/AMD 电脑，包括 Windows、Linux、Intel Mac。
- `git-docs:1.2.0-arm64`：Apple M 系列 Mac、ARM64 Linux。

两个独立标签放在一个 Docker archive 中，不要求 Docker 开启 containerd 镜像存储。接收方只需 Docker，不需要 Node/npm，也不需要连接镜像仓库。

首次构建需要联网下载官方 Node 基础镜像和 npm 包，网络受限时应预先配置你现有的 Docker/npm 网络访问。命令使用已有 Docker builder，不会安装额外构建服务或修改 Docker 设置。应用构建和测试在构建主机的原生架构完成；最终镜像使用各自架构的官方 Node 运行时，不需要手动安装模拟器。

## 本地开发

```bash
npm ci
npm run build
npm test
node dist/app.cjs init
npm start
```

源码目录：

```text
src/                       GitLab / GitHub / Gitee 同步、Markdown 处理与 HTTP 服务
public/                    阅读与管理网页（不依赖外网 CDN）
docker/entry.cjs            首次自动初始化与密码重置
Dockerfile                 多阶段构建
scripts/docker-package.mjs 两种架构构建、导出、压缩
scripts/licenses.mjs       第三方许可收集
test/                      模拟 GitLab 与自动化测试
```

## 部署约定

服务监听容器内 8080，所有可变数据都在 `/data`。宿主机只需把选定的外部目录绑定到 `/data`。本版为了兼容首次挂载的空目录，使用容器默认用户写入；Linux 上生成文件默认归 root 所有。可由有经验的管理员使用可写目录配合 `--user UID:GID`，但不是部署必需步骤。

首次启动自动创建 `config.json`、`admin-password.txt`。Git 仓库地址、Token、文档副本都保存到外部目录；网页“管理仓库”可添加多个仓库。默认每 10 分钟同步。

主要限制：单篇 MD 2MB、单资源 25MB、每仓库文档与资源总量 256MB、仓库压缩包 512MB；不展开 Git 子模块，不下载 LFS 图片，不专门渲染 Mermaid。阅读页面不继承 GitLab 用户权限，因此端口应按需要限制访问范围。

打包不会包含本地 data、Token、文档缓存或 release 归档；`.dockerignore` 使用白名单。修改应用版本号时请同步 Dockerfile 的版本标签和部署说明中的镜像名。

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
