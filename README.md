# Bilibili Tracker

自托管的 B 站合集追更工具，把订阅合集、待看视频和观看进度整理到一个私人网页中。

从 B 站同步合集与观看历史，按系列、章节和观看状态筛选视频，也可以批量修改状态，或将已点赞的视频标为已看。

> 面向单人、单账号使用。非 B 站官方产品，依赖的网页接口可能变化或受到限流。

## 功能

- **合集追更**：导入「我追的」视频合集，自选同步范围，设置新合集是否默认同步。
- **观看进度**：同步历史，按分 P 保存进度，支持未看、观看中、已看完和忽略；手动标记可恢复自动判断。
- **待看清单**：按合集、章节、状态和关键词筛选，默认按发布日期从新到旧排序，支持分页和跨页批量操作。
- **点赞导入**：后台核对已同步视频的点赞状态，预览并确认后批量标为已看。
- **后台同步**：展示任务进度、同步日志和 Worker 心跳，支持断点续传、失败重试与限流退避。
- **私人部署**：密码访问，B 站凭据加密保存，支持 Docker Compose 和 Coolify。
- **网页体验**：响应式粉蓝界面，筛选、排序、页码和视频详情保留在 URL，支持直达、刷新与前进后退。

## 快速开始

### Docker Compose

需要 Docker 和 Docker Compose。

```sh
git clone https://github.com/pppwaw/bilibili-tracker.git
cd bilibili-tracker
cp .env.example .env
```

编辑 `.env`，设置访问地址、访问密码和加密密钥：

```dotenv
APP_ORIGIN=http://localhost:3000
APP_PASSWORD=replace-with-a-long-random-password
ENCRYPTION_KEY=replace-with-64-hex-characters
```

`APP_PASSWORD` 至少 12 位。使用以下命令生成 `ENCRYPTION_KEY`，将输出填入配置；上面的占位值不能直接使用：

```sh
# 本机安装 Node.js 时
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 或使用 Docker
docker run --rm node:24-alpine node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

启动网页和后台同步服务：

```sh
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

打开 [http://localhost:3000](http://localhost:3000)，输入访问密码。

本地配置仅监听 `127.0.0.1:3000`。远程部署请配置 HTTPS 反向代理，或通过 SSH 隧道访问。

### 预构建镜像

GitHub Actions 在测试、类型检查和生产构建通过后，自动构建并发布镜像到 GHCR（目前为 `linux/amd64`）：

```sh
docker pull ghcr.io/pppwaw/bilibili-tracker:latest
```

- `latest`：主分支最新构建。
- `sha-<短提交号>`：对应具体提交的构建。
- 推送 `v1.2.3` 形式的版本标签：发布 `1.2.3` 和 `1.2` 镜像标签。
- Pull Request 仅检查和构建镜像，不推送。

web 和 worker 共用同一镜像；worker 启动命令为 `node --experimental-strip-types src/worker.ts`。使用现有 Compose 文件部署预构建镜像时，将共享配置中的 `image` 替换为上述镜像地址，并移除 `build`；保留环境变量与数据卷配置。

GHCR 包的可见性需在包设置中单独确认；仓库公开不代表镜像一定可匿名拉取。私有包需要先登录 GHCR。发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需另外配置发布密钥。

### 首次使用

1. 在「设置」中扫码绑定 B 站账号，也可填写 SESSDATA / Cookie。
2. 等待合集列表导入，在「我的合集 → 全部合集」勾选需要同步的合集。
3. 在概览或待看清单查看视频；章节和分 P 信息由后台逐步补齐。
4. 如需把已点赞的视频视为已看，点击批量操作栏的「导入点赞」，核对完成后预览并确认应用。

新发现的合集默认不自动同步，可在「我的合集」调整。全选和全不选只作用于当前筛选结果。取消同步会隐藏合集及其独有视频，保留已有数据。

## 配置

| 变量 | 说明 |
| --- | --- |
| `APP_ORIGIN` | 浏览器访问的完整源地址，含协议与端口，必须与实际地址一致 |
| `APP_PASSWORD` | 网页访问密码，至少 12 位 |
| `ENCRYPTION_KEY` | 32 字节加密密钥，以 64 位十六进制表示；web 和 worker 必须一致 |
| `DATABASE_PATH` | 本地数据库路径，默认配置为 `./data/bili.db`；Compose 中固定为 `/app/data/bili.db` |
| `TZ` | 时区，示例及 Compose 使用 `Asia/Shanghai` |

更改网页密码后需重启相关服务，已有会话将失效。加密密钥用于解密已保存的 B 站凭据，请妥善备份，不要随意更换。

### Coolify / 反向代理

1. 使用自己的仓库或 Fork，在 Coolify 中创建 Docker Compose 应用，配置文件选择 `/compose.yaml`。
2. 设置 `APP_ORIGIN=https://your-domain.example`、`APP_PASSWORD` 和 `ENCRYPTION_KEY`。
3. 为 `web` 的容器端口 `3000` 配置域名及 HTTPS。
4. 保持 `worker` 不对外暴露，确保两个服务共享数据卷与密钥。
5. 部署后登录网页，绑定账号，并检查 Worker 心跳和同步日志。

主 Compose 文件不发布宿主机端口。使用其他反向代理时，将代理接入应用网络并转发到 `web:3000`。可另外配置 Cloudflare Access；同时检查默认域名等其他入口是否受到保护。

SQLite 数据卷应位于同一台机器的本地磁盘，不支持 NFS 或多实例部署。web 与 worker 各运行一个实例。

## 同步与状态说明

合集默认每 15 分钟同步，历史默认每 5 分钟同步。视频详情分批补齐，请求至少间隔 3 秒；遇到限流会暂停并保留断点，稍后重试。视频较多时，首次同步和点赞核对需要较长时间，可关闭弹窗继续浏览。

观看状态以实际获取到的历史为依据，默认每个分 P 达到 95% 才算完成，可在设置中调整阈值。已保存的最大观看进度不会因历史消失或重看而清空。

- 没有匹配记录的视频显示为未看，可手动修正。
- B 站历史可能被清理，搜索也可能漏匹配，因此无法保证完整还原全部观看记录。
- 多 P 视频只记录实际观测到的分 P，不根据最后一 P 推断前面的内容已看完。
- 点赞核对仅覆盖当前已同步合集的视频，确认前不会修改观看状态。
- 账号凭据失效后需重新绑定；切换到不同 B 站账号应使用新的数据卷。

当前不提供多用户、通知、视频下载或离线播放。播放链接打开 B 站网页。

## 本地开发

需要 **Node.js 24.8+（24.x）**。使用 Node.js 内置 SQLite，无需额外数据库服务。

```sh
cp .env.example .env
# 填写配置后安装依赖
npm ci
npm run dev
```

另开终端，启动后台同步进程：

```sh
npm run worker
```

两个进程必须使用相同的环境配置和数据库路径。

```sh
npm test
npm run typecheck
npm run build
```

测试使用临时数据库和模拟上游，不需要 B 站账号。配置好环境变量后，可运行 `docker compose config --quiet` 验证部署配置。更多验证说明见 [验证记录](docs/VALIDATION.md)。

### 项目结构

```text
src/app/          页面与服务端 API
src/components/   交互界面与路由状态
src/lib/          B 站接口、数据库、鉴权与同步逻辑
src/worker.ts     后台任务进程
scripts/          备份与健康检查
tests/           自动化测试
```

技术栈：Next.js、React、TypeScript、Node.js 和 SQLite。数据库结构变更应追加迁移，保留已有用户数据。

## 备份与恢复

数据库使用 WAL，运行时不要只复制 `bili.db`。使用在线备份命令：

```sh
docker compose exec web node --experimental-strip-types scripts/backup.ts
# 将实际生成的文件复制到宿主机
docker compose cp web:/app/backups/<backup-file>.db ./<backup-file>.db
```

备份默认保存在容器内，请及时复制出去，或挂载 `/app/backups`。本地运行可使用 `npm run backup`。项目不自动安排定时备份。

备份包含加密后的登录凭据，需私密保存；同时另行保存 `ENCRYPTION_KEY`。恢复前停止 web 和 worker，将备份恢复为数据卷中的 `bili.db`，确认文件属于容器内的 node 用户（UID 1000），再使用原密钥启动服务。

`docker compose down -v` 会删除数据卷，请勿用于普通更新或重启。

## 参与贡献

欢迎通过 Issue 报告问题、提出建议，或提交 Pull Request。

报告同步问题时，请提供复现步骤、版本和已脱敏的错误信息。不要上传 Cookie、SESSDATA、访问密码、加密密钥、数据库或包含个人观看记录的完整日志。修改代码后请运行测试、类型检查和生产构建，并同步更新受影响的文档。

## 致谢

接口资料与项目参考：

- [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
- [bilibili-followup-aggregator](https://github.com/dnasdw/bilibili-followup-aggregator)
- [bili-progress-pwa](https://github.com/Haven16262/bili-progress-pwa)
- [BilibiliHistoryFinder](https://github.com/GDORT/BilibiliHistoryFinder)
- [HistoryHub](https://github.com/LifeArchiveProject/HistoryHub)

## 许可证

本项目基于 [MIT License](LICENSE) 发布。
