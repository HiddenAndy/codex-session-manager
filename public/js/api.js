export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청 실패");
  return data;
}

export function startHeartbeat() {
  const send = () => {
    fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
  };
  send();
  setInterval(send, 2000);
}
