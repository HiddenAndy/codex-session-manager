export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}

export function chatSizeAdvice(size) {
  const mb = size / 1024 / 1024;
  if (mb >= 50) return { level: "danger", label: "새 채팅 강력 권장", detail: "파일 용량은 정확한 토큰 기준은 아니지만, 이 정도면 핵심 상태만 요약해 새 채팅으로 옮기는 편이 안정적입니다." };
  if (mb >= 30) return { level: "danger", label: "새 채팅 권장", detail: "오래된 로그와 결정이 섞일 수 있습니다. 특별한 이유가 없으면 요약 후 새 채팅을 권장합니다." };
  if (mb >= 15) return { level: "warning", label: "새 채팅 고려", detail: "아직 계속 쓸 수 있지만, 작업 단위가 바뀌었거나 답변이 산만해지면 새 채팅이 낫습니다." };
  if (mb >= 5) return { level: "notice", label: "압축 고려", detail: "크기만으로 문제는 아니지만, 긴 작업으로 이어질 예정이면 /compact나 짧은 요약을 고려하세요." };
  return null;
}

export function formatDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("ko-KR");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
