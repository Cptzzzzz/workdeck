# Tailnet 浏览器探测（可选、实验阶段）

这是独立的身份探测基础设施，默认关闭；探测本身不提供节点直连或自动链路切换。未安装 Tailscale 的设备以及探测失败的浏览器继续使用原有路径。若尝试访问 Tailnet 地址被浏览器限制或拒绝，界面显示未确认，不判断是否安装了 Tailscale。

终端的 WebRTC 候选路径探测独立于此身份探测：新版 Hub 和节点支持时，会在既有 WebRTC 连接之外尝试另一组节点接口（Tailscale 接口或其他接口），并将实测延迟、抖动及超时情况与现有链路比较。失败时保留现有链路；候选表现明显更好时先安全切回 WebSocket，再通过原有有序切换机制接入候选。之后周期性重新探测。没有 Tailscale 时，普通 WebRTC 仍按原流程尝试；旧版节点继续使用原流程。

当前候选分组识别 Linux 上名称以 `tailscale` 开头的接口，不能据此判断 Tailscale 底层是否经过 DERP 或其他中继；它也不会改变 Tailscale 或系统的 IPv4/IPv6 选择。IPv6 的使用仍取决于双方公网连接和网络策略。工作区文件连接暂时沿用已有的单个 WebRTC 候选及 WebSocket 回退机制。

当主服务配置了 `*.ts.net` 探测地址，已认证的新版节点会获得主服务的 Tailnet 主机名提示，并在本机私有数据目录中保存，以便重启后使用。节点建立控制、终端和文件 WebSocket 时，会同时尝试原有公网地址及已验证属于 Tailnet 地址范围的主服务地址，使用先完成连接和 TLS 校验的路径；未安装 Tailscale、未配置探测或地址不可达时，公网路径继续正常使用。TLS 始终校验主服务的原始公网域名，签名请求和一次性票据只通过选中的连接发送一次。该机制优化节点到主服务的连接，不表示浏览器与节点之间已物理直连。

## 安全模型

Hub 给已登录会话发放随机挑战。运行在 Hub 宿主机的 `workdeck tailnet-probe` 仅监听该宿主机实际持有的 Tailscale IP，读取 HTTPS 连接的真实来源并询问本机 `tailscale whois`。它返回挑战及节点身份的 HMAC 派生值；Hub 用单次挑战校验并将身份摘要短时关联到当前登录会话。公网 Cookie 不会发给探测服务；原始节点 ID 和 IP 不进入 Hub 或浏览器。挑战有效 60 秒，结果保留两分钟，仅驻留内存，退出登录和密码变更撤销关联。

探测成功表示当前页面发起的请求能到达 Hub 的 Tailnet 入口，不代表目标节点可访问，也不证明底层是物理直连。不能用该状态替代针对节点的验证或直接授权终端访问。挑战能被当前会话转交给其他设备的协作方，因此不能把它当成不可转移的浏览器硬件身份。

## 前提

- Hub 宿主机运行 Tailscale；浏览器设备可访问该宿主机的 Tailnet IP 和选定端口。Tailnet 规则需允许该端口。
- 节点的 Tailnet DNS 名及浏览器可信的 HTTPS 证书。Tailscale HTTPS 需要管理员启用；申请证书会将设备名和 Tailnet 名写入公开的证书透明度日志，启用前先确认名称。证书必须续期，不能用自签名证书给普通浏览器使用。
- Hub 容器和宿主机探测服务读取同一份高熵密钥文件；它不能提交 Git、出现在命令行参数值或浏览器中。密钥泄漏将允许伪造探测结果，应轮换并重启两项服务。
- 选定未使用的端口（例如 18443）；不要覆盖现有 Tailscale Serve 配置或已使用的公网服务。

## 手动集成示意

下面的占位符必须替换为自己的实际值。首次运行前检查证书、端口、访问规则、部署路径和当前配置。以下步骤需要宿主机管理员权限。

1. 在 Hub 的部署目录创建密钥文件（如用 `openssl rand -hex 32` 写入临时文件后原子安装），将文件设为 UID 65532 所有、权限 `0400`；Hub 容器与运行探测服务的账号必须有读取权限。部署脚本还会验证文件为普通文件、长度 32–4096 字节且不可被其他账号读取。
2. 使用 Tailscale 提供的证书为节点的 `机器名.tailnet名.ts.net` 配置 HTTPS，证书和私钥保存在宿主机安全目录并按 Tailscale 的方式续期。探测服务绑定宿主机 `tailscale ip -4` 对应的精确 IP，而不是 `0.0.0.0`。
3. 以受 systemd 管理的独立服务运行。可参考仓库中的 `deploy/tailnet-probe.service.example` 和 `scripts/start-tailnet-probe.sh`；启动脚本每次读取当前 Tailscale IPv4 地址，避免节点地址变化后继续监听旧地址。创建仅用于探测的专用系统账号，并把共享密钥和证书的只读副本放入该账号可读、其他用户不可读的目录。原始文件继续由 root 管理。证书或密钥更新后需原子更新副本并重启探测服务；不要让探测服务读取 Hub 的其他密钥。可参考 `scripts/renew-tailnet-probe.sh` 和 `deploy/tailnet-probe-renew.*.example` 配置每日续期检查；脚本在证书变化时原子切换，重启失败时恢复上一份证书。示例命令：

```sh
workdeck tailnet-probe \
  --addr 'TAILSCALE_IP:18443' \
  --origin 'https://work.example.com' \
  --secret-file /opt/stacks/workdeck/secrets/tailnet_probe_secret \
  --tls-cert-file /secure/path/tailnet.crt \
  --tls-key-file /secure/path/tailnet.key
```

该账号需要能调用本机 `tailscale whois --json --proto=tcp` 查询连接来源。服务不会将本机 Tailscale 管理套接字挂载到 Hub 容器。

4. 在本地 `.env.deploy.local` 增加 `WORKDECK_TAILNET_PROBE_URL=https://TAILNET_MACHINE_NAME:18443/probe`，构建后运行标准部署脚本。部署脚本会检查远端密钥、启用 `compose.tailnet.yml` 覆盖、只读挂载密钥并添加 Hub 参数。也可以在 Hub 部署目录用 `docker compose -f compose.yml -f compose.tailnet.yml config` 预检。
5. 检查主服务健康、节点在线、已有终端进程和浏览器的探测状态；非 Tailnet 设备应仍能正常使用原链路。用户浏览器需要通过 Tailnet DNS 解析节点域名，不应跳过 TLS 校验。

**后续部署：** 保留本地部署配置中的 `WORKDECK_TAILNET_PROBE_URL`。如果远端已经启用探测而本地没有设置 URL，标准部署脚本会停止，避免无意中关闭；确需关闭时，显式设置 `WORKDECK_TAILNET_PROBE_DISABLE=1` 并移除 URL。不要把探测状态当成节点直连已实现。

## 临时链路诊断

仅在管理员于 Hub 数据目录放置权限为 `0600`、有效期不超过 15 分钟的 `.tailnet-diagnostic` 标记时启用。标记限定节点和此前使用共享密钥生成的设备匿名标识；只有完成 Tailnet 探测的同一 Workdeck 登录会话、且已连接目标节点终端时才能上报。记录仅含时间、链路和连接状态分类、地址类别及测得的延迟，不包含节点或终端 ID、IP、端口、SDP、按键或终端输出；最大 64 KiB，保存在 `tailnet-diagnostic.jsonl`。诊断完成后管理员应删除标记和记录；过期标记不再收集。浏览器隐藏地址时类别为未知；候选地址落在 Tailscale 范围也不足以证明底层物理直连。
