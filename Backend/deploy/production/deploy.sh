#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

sha="${1:-}"
repository_root="${ATLAS_DEPLOY_REPOSITORY_ROOT:?ATLAS_DEPLOY_REPOSITORY_ROOT is required}"
status_root="${ATLAS_DEPLOY_STATUS_ROOT:?ATLAS_DEPLOY_STATUS_ROOT is required}"
deploy_root="${repository_root}/.deploy"
release_root="${deploy_root}/releases/${sha}"
backend_root="${release_root}/Backend"
log_root="${deploy_root}/logs"
lock_path="${deploy_root}/deploy.lock"
canary_port=19012
canary_pid=''
previous_ecosystem=''
switched=false

if [[ ! "${sha}" =~ ^[a-f0-9]{40}$ ]]; then
  exit 2
fi
if [[ ! "${repository_root}" = /* ]] || [[ "${status_root}" != "${deploy_root}/status" ]]; then
  exit 2
fi

mkdir -p "${status_root}" "${deploy_root}/releases" "${log_root}"
chmod 700 "${deploy_root}" "${status_root}" "${deploy_root}/releases" "${log_root}"
exec >>"${log_root}/${sha}.deploy.log" 2>&1

write_status() {
  local state="$1"
  local updated_unix_ms temporary_path status_path
  updated_unix_ms="$(date +%s%3N)"
  status_path="${status_root}/${sha}.json"
  temporary_path="${status_path}.$$.tmp"
  printf '{"sha":"%s","state":"%s","updated_unix_ms":%s}\n' \
    "${sha}" "${state}" "${updated_unix_ms}" > "${temporary_path}"
  chmod 600 "${temporary_path}"
  mv -f "${temporary_path}" "${status_path}"
}

handle_exit() {
  local exit_code="$1"
  trap - EXIT
  set +e
  if [[ -n "${canary_pid}" ]]; then
    kill "${canary_pid}" 2>/dev/null
    wait "${canary_pid}" 2>/dev/null
  fi
  if (( exit_code != 0 )); then
    if [[ "${switched}" == true && -n "${previous_ecosystem}" ]]; then
      pm2 delete atlas-api >/dev/null 2>&1 || true
      pm2 start "${previous_ecosystem}" --only atlas-api >/dev/null 2>&1
    fi
    write_status failed
  fi
  exit "${exit_code}"
}
trap 'handle_exit $?' EXIT

write_status running
exec 9>"${lock_path}"
if ! flock -n 9; then
  exit 3
fi

for command_name in curl find flock git grep node npm pm2 readlink seq ss; do
  command -v "${command_name}" >/dev/null
done

git -C "${repository_root}" fetch --prune origin main
remote_sha="$(git -C "${repository_root}" rev-parse refs/remotes/origin/main)"
if [[ "${remote_sha}" != "${sha}" ]]; then
  exit 4
fi

if [[ -e "${release_root}" ]]; then
  release_sha="$(git -C "${release_root}" rev-parse HEAD)"
  if [[ "${release_sha}" != "${sha}" ]]; then
    exit 5
  fi
else
  git -C "${repository_root}" worktree add --detach "${release_root}" "${sha}"
fi

canonical_env="${repository_root}/Backend/.env"
canonical_runtime="${repository_root}/Backend/runtime"
if [[ ! -f "${canonical_env}" ]]; then
  exit 6
fi
mkdir -p "${canonical_runtime}"
chmod 700 "${canonical_runtime}"

if [[ -e "${backend_root}/.env" || -L "${backend_root}/.env" ]]; then
  if [[ "$(readlink -f "${backend_root}/.env")" != "$(readlink -f "${canonical_env}")" ]]; then
    exit 7
  fi
else
  ln -s "${canonical_env}" "${backend_root}/.env"
fi

if [[ -e "${backend_root}/runtime" || -L "${backend_root}/runtime" ]]; then
  if [[ "$(readlink -f "${backend_root}/runtime")" != "$(readlink -f "${canonical_runtime}")" ]]; then
    exit 8
  fi
else
  ln -s "${canonical_runtime}" "${backend_root}/runtime"
fi

cd "${backend_root}"
PUPPETEER_SKIP_DOWNLOAD=true npm ci
# The dictionary agent and ASO renderer drive Chrome through Puppeteer. The browser lives in the
# shared ~/.cache/puppeteer, so this is a no-op unless the locked Puppeteer wants a new build.
npx puppeteer browsers install chrome
npm test
while IFS= read -r -d '' javascript_file; do
  node --check "${javascript_file}"
done < <(find . -path './node_modules' -prune -o -type f \( -name '*.js' -o -name '*.cjs' \) -print0)

if ss -H -ltn "sport = :${canary_port}" | grep -q .; then
  exit 9
fi
NODE_ENV=production HPA_HOST=127.0.0.1 HPA_PORT="${canary_port}" \
  node server.js >"${log_root}/${sha}.canary.log" 2>&1 &
canary_pid="$!"
canary_ready=false
for _ in $(seq 1 30); do
  if curl --silent --show-error --fail "http://127.0.0.1:${canary_port}/healthz" >/dev/null; then
    canary_ready=true
    break
  fi
  if ! kill -0 "${canary_pid}" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ "${canary_ready}" != true ]]; then
  exit 10
fi
kill "${canary_pid}"
wait "${canary_pid}" 2>/dev/null || true
canary_pid=''

previous_cwd="$(pm2 jlist | node -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const matches = JSON.parse(input).filter(app => app.name === "atlas-api");
  if (matches.length !== 1 || typeof matches[0].pm2_env?.pm_cwd !== "string") process.exit(1);
  process.stdout.write(matches[0].pm2_env.pm_cwd);
});
')"
previous_ecosystem="${previous_cwd}/deploy/pm2/ecosystem.config.cjs"
next_ecosystem="${backend_root}/deploy/pm2/ecosystem.config.cjs"
if [[ ! -f "${previous_ecosystem}" || ! -f "${next_ecosystem}" ]]; then
  exit 11
fi

# Refuse to replace the API from inside its own process tree: PM2 kills descendants of
# atlas-api on delete, which would kill this script mid-switch and leave nothing running.
atlas_pid="$(pm2 jlist | node -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const matches = JSON.parse(input).filter(app => app.name === "atlas-api");
  if (matches.length !== 1 || !Number.isInteger(matches[0].pid)) process.exit(1);
  process.stdout.write(String(matches[0].pid));
});
')"
ancestor_pid="$$"
while [[ -n "${ancestor_pid}" && "${ancestor_pid}" -gt 1 ]]; do
  if [[ "${ancestor_pid}" == "${atlas_pid}" ]]; then
    exit 14
  fi
  ancestor_pid="$(ps -o ppid= -p "${ancestor_pid}" | tr -d '[:space:]')"
done

switched=true
pm2 delete atlas-api
pm2 start "${next_ecosystem}" --only atlas-api
deployed_cwd="$(pm2 jlist | node -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const matches = JSON.parse(input).filter(app => app.name === "atlas-api");
  if (matches.length !== 1 || typeof matches[0].pm2_env?.pm_cwd !== "string") process.exit(1);
  process.stdout.write(matches[0].pm2_env.pm_cwd);
});
')"
if [[ "${deployed_cwd}" != "${backend_root}" ]]; then
  exit 12
fi

production_ready=false
for _ in $(seq 1 45); do
  if curl --silent --show-error --fail 'http://127.0.0.1:9000/healthz' >/dev/null; then
    production_ready=true
    break
  fi
  sleep 1
done
if [[ "${production_ready}" != true ]]; then
  exit 13
fi

temporary_link="${deploy_root}/current.$$.tmp"
ln -s "${release_root}" "${temporary_link}"
mv -Tf "${temporary_link}" "${deploy_root}/current"
write_status succeeded
