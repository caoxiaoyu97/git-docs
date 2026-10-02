# Git Docs 启动向导：问数据目录、管理密码、网页端口，然后把容器跑起来就结束。
Set-Location -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)

$version = '__VERSION__'
$name = 'git-docs'
$port = 18080
$defaultDir = Join-Path (Get-Location).Path 'git-docs-data'

Write-Host '============================================'
Write-Host ' Git Docs 启动向导'
Write-Host '============================================'
Write-Host ''

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host '没有找到 docker 命令。请先安装并启动 Docker Desktop。'
  Read-Host '按回车退出'
  exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$image = "git-docs:$version-$arch"

docker image inspect $image *> $null
if ($LASTEXITCODE -ne 0) {
  if (Test-Path -LiteralPath 'git-docs-images.tar.gz') {
    Write-Host '正在导入镜像，第一次需要一两分钟...'
    docker load -i git-docs-images.tar.gz
    if ($LASTEXITCODE -ne 0) { Read-Host '按回车退出'; exit 1 }
  } else {
    Write-Host "找不到镜像 $image，也没有找到 git-docs-images.tar.gz。"
    Read-Host '按回车退出'
    exit 1
  }
}
Write-Host "使用镜像：$image"
Write-Host ''

$answer = Read-Host "数据目录 [$defaultDir]"
$dataDir = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultDir } else { $answer }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$initialized = Test-Path -LiteralPath (Join-Path $dataDir 'config.json')
if ($initialized) {
  Write-Host ''
  Write-Host '提示：这个数据目录已经初始化过（之前启动过）。管理密码沿用原来的，'
  Write-Host '      下面填的密码不会生效；直接回车跳过即可。忘记密码可执行：'
  Write-Host '      docker exec <容器名> node entry.cjs reset-password'
  Write-Host ''
}

while ($true) {
  $password = Read-Host '管理密码（至少 10 位，留空自动生成）'
  if ([string]::IsNullOrEmpty($password)) { break }
  if ($password.Length -ge 10) { break }
  Write-Host '管理密码至少需要 10 位，请重新输入。'
}

while ($true) {
  $answer = Read-Host "网页端口 [$port]"
  $parsed = 0
  if (-not [string]::IsNullOrWhiteSpace($answer) -and [int]::TryParse($answer, [ref]$parsed)) { $port = $parsed }
  if (docker ps --format '{{.Ports}}' | Select-String -SimpleMatch ":$port->") {
    Write-Host "端口 $port 已被其他容器占用，请换一个。"
    continue
  }
  break
}

docker container inspect $name *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "已存在同名容器 $name，先移除它（数据还在数据目录里）..."
  docker rm -f $name *> $null
}

Write-Host ''
Write-Host '正在启动...'
docker run -d --name $name -p "${port}:8080" -v "${dataDir}:/data" -e "GIT_DOCS_ADMIN_PASSWORD=$password" $image *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "启动失败。常见原因：端口 $port 已被占用，或 Docker 没有运行。"
  Read-Host '按回车退出'
  exit 1
}

Write-Host ''
Write-Host '启动完成。'
Write-Host "网址：http://localhost:$port"
Write-Host "数据目录：$dataDir"
if ($initialized) {
  Write-Host "管理密码沿用该目录里原来的密码，保存在：$dataDir\admin-password.txt"
} elseif ([string]::IsNullOrEmpty($password)) {
  Write-Host "管理密码是自动生成的，保存在：$dataDir\admin-password.txt"
}
Write-Host "停止：docker stop $name     再次启动：docker start $name"
Read-Host '按回车退出'
