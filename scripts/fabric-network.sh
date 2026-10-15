#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${FABRIC_SAMPLES_PATH:?Set FABRIC_SAMPLES_PATH to an installed fabric-samples checkout. See docs/FABRIC.md.}"
task_samples="$(cd "$FABRIC_SAMPLES_PATH" && pwd)"
task_channel="${FABRIC_CHANNEL:-kayakchannel}"
command -v docker >/dev/null || { echo 'Docker with Compose is required.' >&2; exit 1; }
[[ -x "$task_samples/test-network/network.sh" ]] || { echo 'Cannot find fabric-samples/test-network/network.sh' >&2; exit 1; }
export PATH="$task_samples/bin:$PATH"
export FABRIC_CFG_PATH="$task_samples/config"
cd "$task_samples/test-network"
case "${1:-}" in
  up) ./network.sh up createChannel -ca -c "$task_channel" ;;
  deploy) ./network.sh deployCC -c "$task_channel" -ccn blockchainkayak -ccp "$task_root/chaincode" -ccl javascript -ccv "${CHAINCODE_VERSION:-0.1.0}" -ccs "${CHAINCODE_SEQUENCE:-1}" ;;
  down) ./network.sh down ;;
  *) echo 'Usage: fabric-network.sh up|deploy|down' >&2; exit 1 ;;
esac
