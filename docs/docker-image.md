# Git Docs 镜像使用说明

把 GitLab、GitHub、Gitee 上的 Markdown 文档聚合成一个可搜索的文档门户。镜像里只有应用本身，不含任何仓库、数据或凭据；仓库地址与 Token 都存在你挂载的 `/data` 目录里。

## 快速开始

```bash
docker run -d --name git-docs -p 18080:8080 -v /你的目录:/data ghcr.io/caoxiaoyu97/git-docs:latest
```

打开 `http://localhost:18080`。首次启动会自动生成管理密码：

```bash
docker exec git-docs cat /data/admin-password.txt
```

进入“管理仓库”填写仓库地址即可；Token 可选，留空则匿名读取公开仓库。

## 两个最容易踩的点

- **端口**：容器内固定监听 `8080`，要用 `-p 宿主机端口:8080` 发布出来，例如 `-p 18080:8080`。不发布端口，浏览器打不开。容器内的 8080 不要改。
- **数据目录**：务必挂载 `-v 宿主机目录:/data`。不挂载时配置、管理密码和文档缓存都落在容器内，容器重建即丢失。

## 可配置项

| 配置 | 作用 | 默认 |
| --- | --- | --- |
| `-p 宿主机端口:8080` | 对外访问端口 | 需要自行指定 |
| `-v 宿主机目录:/data` | 数据目录：config.json、管理密码、文档缓存 | 容器内匿名卷 |
| `GIT_DOCS_ADMIN_PASSWORD` | 首次启动的管理密码，至少 10 位 | 自动生成，写入 admin-password.txt |
| `GIT_DOCS_INTERVAL_MINUTES` | 自动检查更新的间隔（分钟） | `10` |
| `GIT_DOCS_AI_TOKEN` | 给 AI/MCP 接口加鉴权；设置后 `/llms.txt`、`/raw`、`/mcp` 需要 Bearer 令牌 | 不校验 |
| `GIT_DOCS_HOOK_TOKEN` | webhook 推送即同步的校验密钥 | 未设置时使用管理密码 |
| `GIT_DOCS_DATA` | 数据目录路径 | `/data` |
| `GIT_DOCS_HOME` | 应用目录 | `/app` |

环境变量只在数据目录尚未初始化时生效。已经存在 `config.json` 时，仓库配置、同步间隔和管理密码都以数据目录里的为准；改同步间隔可以编辑 `config.json` 里的 `intervalMinutes` 后重启容器。

## docker compose

```yaml
services:
  git-docs:
    image: ghcr.io/caoxiaoyu97/git-docs:latest
    container_name: git-docs
    ports:
      - "18080:8080"
    volumes:
      - ./git-docs-data:/data
    environment:
      GIT_DOCS_INTERVAL_MINUTES: "10"
    restart: unless-stopped
```

## 常用操作

```bash
docker logs git-docs                                   # 查看启动信息，首次启动会打印管理密码
docker exec git-docs node entry.cjs reset-password     # 重置管理密码
docker stop git-docs && docker start git-docs
```

备份前先停止服务，复制整个数据目录即可；不要让两个实例同时使用同一个数据目录。

## 说明

- 支持自建 GitLab、GitHub.com 与 Gitee.com。GitHub Enterprise、Gitee 私有化域名未适配。
- 单篇 Markdown 上限 2MB，单个资源 25MB，每仓库文档与资源合计 256MB；不展开 Git 子模块，不下载 LFS 图片。
- 阅读页对能访问该端口的人开放，管理页需要密码。给局域网使用时改成 `-p 18080:8080` 并放行防火墙。
