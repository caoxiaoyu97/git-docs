@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set VERSION=__VERSION__
set NAME=git-docs
set PORT=18080
set DEFAULT_DIR=%~dp0git-docs-data

echo ============================================
echo  Git Docs 启动向导
echo ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo 没有找到 docker 命令。请先安装并启动 Docker Desktop。
  pause
  exit /b 1
)

set ARCH=amd64
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set ARCH=arm64
set IMAGE=git-docs:%VERSION%-%ARCH%

docker image inspect %IMAGE% >nul 2>nul
if errorlevel 1 (
  if exist git-docs-images.tar.gz (
    echo 正在导入镜像，第一次需要一两分钟...
    docker load -i git-docs-images.tar.gz
    if errorlevel 1 ( pause & exit /b 1 )
  ) else (
    echo 找不到镜像 %IMAGE%，也没有找到 git-docs-images.tar.gz。
    pause
    exit /b 1
  )
)
echo 使用镜像：%IMAGE%
echo.

set DATA_DIR=
set /p DATA_DIR=数据目录 [%DEFAULT_DIR%]: 
if "%DATA_DIR%"=="" set DATA_DIR=%DEFAULT_DIR%
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

set PASSWORD=
set /p PASSWORD=管理密码（留空自动生成）: 

:askport
set INPUT_PORT=
set /p INPUT_PORT=网页端口 [%PORT%]: 
if not "%INPUT_PORT%"=="" set PORT=%INPUT_PORT%
docker ps --format "{{.Ports}}" | findstr /c:":%PORT%->" >nul
if not errorlevel 1 (
  echo 端口 %PORT% 已被其他容器占用，请换一个。
  goto askport
)

docker container inspect %NAME% >nul 2>nul
if not errorlevel 1 (
  echo 已存在同名容器 %NAME%，先移除它（数据还在数据目录里）...
  docker rm -f %NAME% >nul
)

echo.
echo 正在启动...
docker run -d --name %NAME% -p %PORT%:8080 -v "%DATA_DIR%:/data" -e "GIT_DOCS_ADMIN_PASSWORD=%PASSWORD%" %IMAGE% >nul
if errorlevel 1 (
  echo 启动失败。常见原因：端口 %PORT% 已被占用，或 Docker 没有运行。
  pause
  exit /b 1
)

echo.
echo 启动完成。
echo 网址：http://localhost:%PORT%
echo 数据目录：%DATA_DIR%
if "%PASSWORD%"=="" echo 管理密码是自动生成的，保存在：%DATA_DIR%\admin-password.txt
echo 停止：docker stop %NAME%     再次启动：docker start %NAME%
echo.
pause
endlocal
