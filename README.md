# Bilibili Tracker

个人 B 站视频合集追更管理。Next.js 网页/API + 独立 Node.js Worker + SQLite。仅做网页版，读取 B 站网页版账号历史，不依赖浏览器本地记录。

## 当前功能

- 扫码登录，或填写 SESSDATA/Cookie；凭据 AES-256-GCM 加密，接口不回显。
- 从「我追的」导入 Season，探测并排除普通收藏夹；分页获取合集视频与各分 P。
- 首次仅发现合集列表，在「我的合集 → 全部合集」的卡片上勾选需要的合集后导入视频，再按 UP 主分组搜索观看历史（缺少 UP 主时使用视频标题），通过 BV 号精确匹配并保存 CID 进度。历史任务默认每 5 分钟执行，每轮最近历史最多 5 页、搜索最多 10 页；分页断点持久保存，已核对的搜索组缓存 24 小时，日常进度由最近历史增量更新。合集默认每 15 分钟同步，手动同步通过数据库队列执行。合集列表导入不再等待逐视频详情；详情任务每批最多 10 个，先补章节代表视频，随后补分 P，成功详情缓存 7 天，失败项至少隔天再尝试。
- 未看/观看中/已看完/忽略，默认每个分 P 达到 95% 才算完成；可手动覆盖并恢复自动。
- 保存历史观测及最大观看进度；云端历史消失或重看不会清空完成证据。
- B 站粉蓝配色、设置页同步账号头像、响应式界面、搜索、概览/待看/最近收录按合集或系列筛选、合集详情按章节/分组筛选、合集详情、24 项分页、视频跨页批量状态修改、章节分组标题、同步日志、Worker 实时进度与心跳、凭据失效提醒。
- 请求至少间隔 3 秒、超时、网络重试、任务失败指数退避、单 Worker 租约。B 站限流后按失败次数冷却 30 分钟至 4 小时，保留分页断点和已保存进度。
- 私人密码登录、会话过期、登录限速、同源写入检查；可叠加 Cloudflare Access。

## 本地开发

Node.js 24.8+（24.x）。使用随源码提交的 package-lock.json 固定依赖。

```sh
cp .env.example .env
# 修改 APP_PASSWORD（至少 12 位）及 ENCRYPTION_KEY（32 字节十六进制）
npm ci
npm run dev
# 另开终端，使用相同 .env 和 DATABASE_PATH
npm run worker
```

Next.js 开发进程会读取 .env；Worker 命令也显式加载它。打开 http://localhost:3000，进入设置绑定 B 站，到「我的合集 → 全部合集」的卡片上勾选要同步的合集。同页支持按合集名称或 UP 主筛选，全选/全不选仅操作当前显示的合集，保留其他选择，并可设置“新发现的合集默认同步”，仅影响以后首次发现的合集，默认关闭。未选合集及其独有视频从主界面隐藏，停止同步，但保留已有数据。APP_ORIGIN 必须与浏览器地址完全一致，例如 http://localhost:3000。

生成加密密钥：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 批量修改与点赞导入

视频卡片标明完整发布日期，默认最新发布在前；可切换最早发布、最近收录、标题排序，合集详情另可按章节顺序排列。排序变化回到第一页。页面使用独立路径：/queue（待看）、/collections（合集）、/collections/123（合集详情）、/recent、/settings；合集/系列、章节/分组、搜索、状态、排序、页码和视频详情保留在 URL 查询参数中。旧版 ?view=... 链接会在打开时自动转换，支持刷新还原、分享直达与浏览器前进后退；搜索输入替换当前历史记录。视频列表每页 24 项，支持选择本页或全部筛选结果，批量标为已看完、未看、忽略，或恢复自动判断。修改只覆盖手动状态，不删除原始观看进度；批量请求验证所有视频后在事务中写入。

批量操作栏中的“导入点赞”按钮打开弹窗，会快照当前已同步合集的视频范围，在后台逐个调用点赞状态接口核对，每批最多 10 个，失败保留断点。弹窗显示已核对/总数，可取消或关闭后后台继续；收起时按钮旁仅显示进度百分比或“待确认”。完整核对完成后预览匹配数量并确认应用，才会标为已看完。不使用仅返回近期记录的点赞列表冒充全部点赞。视频多时核对仍需时间，可继续浏览；应用后可批量恢复自动判断。

合集详情显示上游提供的章节标题及每个分 P 的标题，搜索也包含已同步的分 P 标题。Worker 显示当前阶段、处理数量、待补详情及限流冷却时间，同步中每 3 秒刷新。

## Docker Compose（本地或 SSH 隧道）

```sh
cp .env.example .env
# 填写三个必需变量，APP_ORIGIN=http://localhost:3000
docker compose -f compose.yaml -f compose.local.yaml up -d --build
docker compose logs -f worker
```

本地覆盖文件只监听 127.0.0.1:3000。远程服务器可先执行 ssh -L 3000:127.0.0.1:3000 user@server，从电脑访问 localhost。主 Compose 不发布宿主机端口，供反向代理接入。

## Coolify + Cloudflare Access

1. 将源码放入自己的 Git 仓库；Coolify 创建 Git 应用，构建方式选 Docker Compose，文件为 /compose.yaml。
2. 设置 APP_ORIGIN=https://你的域名、APP_PASSWORD、ENCRYPTION_KEY。web 与 worker 必须使用同一密钥与数据卷。
3. 为 web 的容器端口 3000 配置域名；不要给 worker 分配公开域名，也不要额外添加公网端口映射。
4. DNS 开启 Cloudflare 代理。在 Zero Trust 中为此具体域名添加自托管 Access 应用，保护整个域名（路径留空），Allow 仅限自己的邮箱。
5. 同时检查 Coolify 默认域名等其他入口。应用自身仍要求密码，避免其他入口绕过 Access 后直接读取数据。
6. 打开设置扫码，观察 Worker 心跳及首轮同步日志。

普通 Docker 可使用自己的反向代理，或 cloudflared 连接内部 web:3000；Tunnel 与应用需加入同一 Docker 网络。Cloudflare Access 只保护入站浏览器访问，不影响 Worker 向 B 站发起同步。

SQLite 数据卷必须位于同一台机器的本地磁盘，不能把 SQLite 放在 NFS 上。不要横向扩容 web/worker，当前设计每个服务各一个实例。后台仅绑定一个 B 站账号；更换成不同 UID 需使用新的数据卷，避免混合记录。

## 备份与恢复

SQLite 开启 WAL，运行期间不要只复制 bili.db。使用在线备份：

```sh
docker compose exec web node --experimental-strip-types scripts/backup.ts
# 取出备份（替换实际文件名）
docker compose cp web:/app/backups/备份文件名.db ./备份文件名.db
```

备份目录在容器内，生成后立即复制出去，或另行挂载 /app/backups。备份包含加密后的登录态，需私密保存；另存 ENCRYPTION_KEY，数据库与密钥缺一不可。恢复前停止两个服务，把备份恢复为数据卷中的 bili.db，并确认归属用户为容器 node 用户（UID 1000），恢复原密钥后启动。不要执行 docker compose down -v，除非明确要删除所有数据。

可用外部 cron 定期运行备份命令；程序未自动安排备份。

## 状态准确性的边界

- 缺少观看记录的影片按未看显示，接受旧历史清理或关键词搜索漏匹配造成的误差；可手动标为已看完。搜索失败保留原进度并记录失败。
- 所有没有进度证据的视频均标为未看；各分 P 仍分别判断，不推断跳过的分 P 已完成。
- 网页历史接口可能只提供一个 BV 最近观看的 CID；仅保存实际观测到的每个 CID，不推断跳过的 P 已完成。两次同步之间播放完又被覆盖的 P 可能无法捕获，可手动修正。
- 对同一 CID 保存观测到的最大进度；显式 progress=-1 作为完成证据。调整阈值会重新计算百分比判断。
- 合集成员变更只在其分页全部成功后清理旧关系；历史、视频记录保留。退订合集隐藏但不删除数据。
- 无通知、离线播放、下载、Android 客户端。网页播放链接打开 B 站网页，浏览器是否唤起 App 由 B 站处理。
- B 站未公开承诺这些接口稳定；已验证真实账号扫码绑定、合集导入与历史搜索返回；多 P 的所有边界仍需实际播放核对。账号与网络不同可能触发限流，程序保留断点并退避。

## 验证

```sh
npm test
npm run typecheck
npm run build
docker compose config
```

测试使用临时数据库和模拟上游，不访问真实 B 站，不含演示账号或硬编码登录凭据。详见 docs/VALIDATION.md。

## 结构

- src/app：Next.js 页面与 API。
- src/components：交互界面。
- src/lib/bilibili.ts：B 站适配器。
- src/lib/sync.ts：同步、观测与进度存储。
- src/lib/db.ts：SQLite、版本表及任务队列；当前 v2 schema（自动追加章节及详情重试表迁移）。后续变更须追加迁移，不能直接改已部署结构。
- src/worker.ts：常驻 Worker。
- scripts：备份与健康检查。
- tests：进度、数据、安全及同步测试。

数据访问使用 Node 24 内置 node:sqlite，避免 SQLite 原生扩展的额外编译依赖。此版未引入 Drizzle。

## 参考

独立实现，未复制其他项目源码。接口路径参考：
- https://github.com/dnasdw/bilibili-followup-aggregator
- https://github.com/SocialSisterYi/bilibili-API-collect

相关产品参考：
- https://github.com/Haven16262/bili-progress-pwa
- https://github.com/GDORT/BilibiliHistoryFinder
- https://github.com/LifeArchiveProject/HistoryHub

详细接口返回结构仍需实测核对。
