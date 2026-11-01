import type { ComputeNode } from "../../types";

function capacity(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return "未提供";
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes} B`;
}

export function HardwareDetails({
  node,
  initiallyOpen = false,
}: {
  node: ComputeNode;
  initiallyOpen?: boolean;
}) {
  const hardware = node.hardware;
  return (
    <details className="node-hardware" open={initiallyOpen || undefined}>
      <summary>硬件信息</summary>
      {!hardware ? (
        <p className="hardware-note">
          暂无硬件信息；节点上线并升级后自动上报。
        </p>
      ) : (
        <>
          <p className="hardware-note">
            {node.online ? "上次采集" : "节点离线，以下为上次采集"}：
            {new Date(hardware.collected_at).toLocaleString()}
          </p>
          <dl>
            <div>
              <dt>处理器</dt>
              <dd>{hardware.cpu_model || "型号未提供"}</dd>
            </div>
            <div>
              <dt>CPU 核心</dt>
              <dd>
                {hardware.physical_cores
                  ? `${hardware.physical_cores} 个物理核心 · `
                  : ""}
                {hardware.logical_cpus
                  ? `${hardware.logical_cpus} 个逻辑 CPU`
                  : "逻辑 CPU 数未提供"}
              </dd>
            </div>
            <div>
              <dt>内存</dt>
              <dd>
                {capacity(hardware.memory_bytes)}{" "}
                <span className="hardware-muted">（系统识别总量）</span>
              </dd>
            </div>
            <div>
              <dt>内存型号</dt>
              <dd>
                {hardware.memory_modules?.length ? (
                  <ul>
                    {hardware.memory_modules.map((m, i) => (
                      <li key={i}>
                        <span>
                          {[m.vendor, m.model].filter(Boolean).join(" ") ||
                            "型号未提供"}
                        </span>
                        <span>{capacity(m.size_bytes)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "未提供（可能受系统权限或硬件限制）"
                )}
              </dd>
            </div>
            <div>
              <dt>硬盘</dt>
              <dd>
                {hardware.disks?.length ? (
                  <ul>
                    {hardware.disks.map((d) => (
                      <li key={d.name}>
                        <span>
                          {[d.vendor, d.model].filter(Boolean).join(" ") ||
                            "型号未提供"}
                        </span>
                        <span>
                          {capacity(d.size_bytes)} · {d.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "未检测到可报告的块设备"
                )}
              </dd>
            </div>
            <div>
              <dt>显卡</dt>
              <dd>
                {hardware.gpus?.length ? (
                  <ul>
                    {hardware.gpus.map((g, i) => (
                      <li key={i}>
                        <span>{g.model}</span>
                        <span>
                          {g.memory_bytes
                            ? `显存 ${capacity(g.memory_bytes)}`
                            : "显存未提供"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "未检测到 NVIDIA 显卡或信息不可用"
                )}
              </dd>
            </div>
          </dl>
          <p className="hardware-note">
            硬盘为节点看到的块设备容量，可能包含虚拟磁盘；容量不等于文件系统可用空间。硬件信息约每
            5 分钟刷新。
          </p>
        </>
      )}
    </details>
  );
}
