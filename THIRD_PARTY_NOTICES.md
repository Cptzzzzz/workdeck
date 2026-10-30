# 第三方组件与许可

Workdeck 自身使用 [MIT 许可证](LICENSE)。以下列出编译进 Linux 服务端/Agent 的 Go 依赖、Go 标准库和前端运行时依赖。第三方许可原文保留上游语言与版权声明，不受本项目文档中文化影响。

xterm.js 5.5.0 包含本项目的字宽测量与逻辑列定位补丁，见 `scripts/patch-xterm-dom.mjs`；上游版权声明保持不变。开发工具、构建基础镜像和独立运行的 Caddy、tmux、systemd 各自遵循其上游许可。

清单由 `python3 scripts/update-notices.py` 生成；升级依赖后，在完成 `npm ci --prefix web` 和 Go 依赖安装的环境重新生成。容器在 `/licenses/` 内携带本项目和第三方许可文件。

| 组件 | 版本 | 许可原文 |
| --- | --- | --- |
| Go 标准库 | 随 Go 工具链 | [LICENSE](third_party/licenses/go-standard-library--LICENSE.txt) |
| github.com/creack/pty | v1.1.24 | [LICENSE](third_party/licenses/github.com_creack_pty--LICENSE.txt) |
| github.com/dustin/go-humanize | v1.0.1 | [LICENSE](third_party/licenses/github.com_dustin_go-humanize--LICENSE.txt) |
| github.com/google/uuid | v1.6.0 | [LICENSE](third_party/licenses/github.com_google_uuid--LICENSE.txt) |
| github.com/gorilla/websocket | v1.5.3 | [LICENSE](third_party/licenses/github.com_gorilla_websocket--LICENSE.txt) |
| github.com/pion/datachannel | v1.6.3 | [LICENSE](third_party/licenses/github.com_pion_datachannel--LICENSE.txt) |
| github.com/pion/dtls/v3 | v3.1.15 | [LICENSE](third_party/licenses/github.com_pion_dtls_v3--LICENSE.txt) |
| github.com/pion/ice/v4 | v4.4.8 | [LICENSE](third_party/licenses/github.com_pion_ice_v4--LICENSE.txt) |
| github.com/pion/interceptor | v0.1.51 | [LICENSE](third_party/licenses/github.com_pion_interceptor--LICENSE.txt) |
| github.com/pion/logging | v0.2.4 | [LICENSE](third_party/licenses/github.com_pion_logging--LICENSE.txt) |
| github.com/pion/mdns/v2 | v2.2.2 | [LICENSE](third_party/licenses/github.com_pion_mdns_v2--LICENSE.txt) |
| github.com/pion/randutil | v0.1.0 | [LICENSE](third_party/licenses/github.com_pion_randutil--LICENSE.txt) |
| github.com/pion/rtcp | v1.2.20 | [LICENSE](third_party/licenses/github.com_pion_rtcp--LICENSE.txt) |
| github.com/pion/rtp | v1.10.6 | [LICENSE](third_party/licenses/github.com_pion_rtp--LICENSE.txt) |
| github.com/pion/sctp | v1.12.0 | [LICENSE](third_party/licenses/github.com_pion_sctp--LICENSE.txt) |
| github.com/pion/sdp/v3 | v3.0.20 | [LICENSE](third_party/licenses/github.com_pion_sdp_v3--LICENSE.txt) |
| github.com/pion/srtp/v3 | v3.1.3 | [LICENSE](third_party/licenses/github.com_pion_srtp_v3--LICENSE.txt) |
| github.com/pion/stun/v4 | v4.0.1 | [LICENSE](third_party/licenses/github.com_pion_stun_v4--LICENSE.txt) |
| github.com/pion/transport/v5 | v5.1.4 | [LICENSE](third_party/licenses/github.com_pion_transport_v5--LICENSE.txt) |
| github.com/pion/turn/v5 | v5.1.3 | [LICENSE](third_party/licenses/github.com_pion_turn_v5--LICENSE.txt) |
| github.com/pion/webrtc/v4 | v4.2.26 | [LICENSE](third_party/licenses/github.com_pion_webrtc_v4--LICENSE.txt) |
| github.com/remyoudompheng/bigfft | v0.0.0-20230129092748-24d4a6f8daec | [LICENSE](third_party/licenses/github.com_remyoudompheng_bigfft--LICENSE.txt) |
| github.com/wlynxg/anet | v0.0.5 | [LICENSE](third_party/licenses/github.com_wlynxg_anet--LICENSE.txt) |
| golang.org/x/crypto | v0.48.0 | [LICENSE](third_party/licenses/golang.org_x_crypto--LICENSE.txt) |
| golang.org/x/exp | v0.0.0-20250620022241-b7579e27df2b | [LICENSE](third_party/licenses/golang.org_x_exp--LICENSE.txt) |
| golang.org/x/net | v0.50.0 | [LICENSE](third_party/licenses/golang.org_x_net--LICENSE.txt) |
| golang.org/x/sys | v0.41.0 | [LICENSE](third_party/licenses/golang.org_x_sys--LICENSE.txt) |
| golang.org/x/time | v0.14.0 | [LICENSE](third_party/licenses/golang.org_x_time--LICENSE.txt) |
| modernc.org/libc | v1.66.10 | [LICENSE](third_party/licenses/modernc.org_libc--LICENSE.txt), [LICENSE-GO](third_party/licenses/modernc.org_libc--LICENSE-GO.txt) |
| modernc.org/mathutil | v1.7.1 | [LICENSE](third_party/licenses/modernc.org_mathutil--LICENSE.txt) |
| modernc.org/memory | v1.11.0 | [LICENSE](third_party/licenses/modernc.org_memory--LICENSE.txt), [LICENSE-GO](third_party/licenses/modernc.org_memory--LICENSE-GO.txt), [LICENSE-LOGO](third_party/licenses/modernc.org_memory--LICENSE-LOGO.txt), [LICENSE-MMAP-GO](third_party/licenses/modernc.org_memory--LICENSE-MMAP-GO.txt) |
| modernc.org/sqlite | v1.40.1 | [LICENSE](third_party/licenses/modernc.org_sqlite--LICENSE.txt) |
| @xterm/addon-fit | 0.10.0 | [LICENSE](third_party/licenses/_xterm_addon-fit--LICENSE.txt) |
| @xterm/xterm | 5.5.0 | [LICENSE](third_party/licenses/_xterm_xterm--LICENSE.txt) |
| lucide-react | 0.468.0 | [LICENSE](third_party/licenses/lucide-react--LICENSE.txt) |
| react-dom | 19.3.1 | [LICENSE](third_party/licenses/react-dom--LICENSE.txt) |
| react | 19.3.1 | [LICENSE](third_party/licenses/react--LICENSE.txt) |
| scheduler | 0.28.0 | [LICENSE](third_party/licenses/scheduler--LICENSE.txt) |
