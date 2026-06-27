const requiredMajor = 20;
const current = process.versions.node;
const major = Number(current.split(".")[0]);

if (!Number.isFinite(major) || major < requiredMajor) {
  console.error(`Node.js ${requiredMajor} 이상이 필요합니다. 현재 버전: v${current}`);
  console.error("macOS에서는 start.command를 실행하거나, https://nodejs.org/ 에서 최신 LTS를 설치한 뒤 다시 실행하세요.");
  process.exit(1);
}
