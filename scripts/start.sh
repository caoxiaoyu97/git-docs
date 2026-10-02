#!/bin/sh
# Git Docs 启动向导：依次填写数据目录、管理密码、端口，然后把容器跑起来就结束。
cd "$(dirname "$0")" || exit 1

VERSION="__VERSION__"
NAME="git-docs"
PORT="18080"
DEFAULT_DIR="$PWD/git-docs-data"

echo "============================================"
echo " Git Docs 启动向导"
echo "============================================"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "没有找到 docker 命令。请先安装并启动 Docker。"
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "不支持的 CPU 架构：$(uname -m)"; exit 1 ;;
esac
IMAGE="git-docs:${VERSION}-${ARCH}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  FOUND=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^git-docs:.*-${ARCH}$" | head -n 1)
  if [ -n "$FOUND" ]; then
    IMAGE="$FOUND"
  elif [ -f "git-docs-images.tar.gz" ]; then
    echo "正在导入镜像，第一次需要一两分钟…"
    gzip -dc git-docs-images.tar.gz | docker load || exit 1
  else
    echo "找不到镜像 $IMAGE，也没有找到 git-docs-images.tar.gz。"
    exit 1
  fi
fi
echo "使用镜像：$IMAGE"
echo

printf "数据目录 [%s]： " "$DEFAULT_DIR"
read -r DATA_DIR
[ -z "$DATA_DIR" ] && DATA_DIR="$DEFAULT_DIR"
mkdir -p "$DATA_DIR" || exit 1

INITIALIZED=0
if [ -f "$DATA_DIR/config.json" ]; then
  INITIALIZED=1
  echo
  echo "提示：这个数据目录已经初始化过（之前启动过）。管理密码沿用原来的，"
  echo "      下面填的密码不会生效；直接回车跳过即可。忘记密码可执行："
  echo "      docker exec <容器名> node entry.cjs reset-password"
  echo
fi

while :; do
  printf "管理密码（至少 10 位，留空自动生成）： "
  read -r PASSWORD
  [ -z "$PASSWORD" ] && break
  [ ${#PASSWORD} -ge 10 ] && break
  echo "管理密码至少需要 10 位，请重新输入。"
done

while :; do
  printf "网页端口 [%s]： " "$PORT"
  read -r INPUT_PORT
  [ -n "$INPUT_PORT" ] && PORT="$INPUT_PORT"
  if docker ps --format '{{.Ports}}' | grep -q ":$PORT->"; then
    echo "端口 $PORT 已被其他容器占用，请换一个。"
    continue
  fi
  break
done

if docker container inspect "$NAME" >/dev/null 2>&1; then
  echo "已存在同名容器 $NAME，先移除它（数据还在数据目录里）…"
  docker rm -f "$NAME" >/dev/null || exit 1
fi

echo
echo "正在启动…"
if ! docker run -d --name "$NAME" -p "$PORT:8080" -v "$DATA_DIR:/data" -e "GIT_DOCS_ADMIN_PASSWORD=$PASSWORD" "$IMAGE" >/dev/null; then
  echo "启动失败。常见原因：端口 $PORT 已被占用，或 Docker 没有运行。"
  exit 1
fi

echo
echo "启动完成。"
echo "网址：http://localhost:$PORT"
echo "数据目录：$DATA_DIR"
if [ "$INITIALIZED" -eq 1 ]; then
  echo "管理密码沿用该目录里原来的密码，保存在：$DATA_DIR/admin-password.txt"
elif [ -z "$PASSWORD" ]; then
  echo "管理密码是自动生成的，保存在：$DATA_DIR/admin-password.txt"
fi
echo "停止：docker stop $NAME     再次启动：docker start $NAME"
