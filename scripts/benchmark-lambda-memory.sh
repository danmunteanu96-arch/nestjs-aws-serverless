#!/usr/bin/env bash
set -euo pipefail

# Measures a disposable, already deployed stage and restores every original memory setting.
usage() {
  cat <<'USAGE'
Usage:
  ./scripts/benchmark-lambda-memory.sh --stage benchmark-NAME \
    --confirm-disposable-stage benchmark-NAME [--warm-invocations 3]

The stage must already exist and contain only disposable test data. Keep the
stage name short: the S3 bucket name includes it and must stay under 63
characters (use benchmark-1, not benchmark-auctions). The expiration handler can
close expired auctions. Notifications use the SES simulator. AWS calls can incur
cost; this script never runs implicitly as part of tests or deployment.
USAGE
}

STAGE=""
CONFIRM_STAGE=""
WARM_INVOCATIONS=3
AWS_REGION="${AWS_REGION:-eu-central-1}"
OUTPUT_ROOT="${OUTPUT_ROOT:-benchmark-results}"
LAMBDA_ARM_PRICE_PER_GB_SECOND="${LAMBDA_ARM_PRICE_PER_GB_SECOND:-0.0000133334}"
LAMBDA_REQUEST_PRICE="${LAMBDA_REQUEST_PRICE:-0.00000020}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="${2:-}"
      shift 2
      ;;
    --confirm-disposable-stage)
      CONFIRM_STAGE="${2:-}"
      shift 2
      ;;
    --warm-invocations)
      WARM_INVOCATIONS="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$STAGE" || "$CONFIRM_STAGE" != "$STAGE" ]]; then
  printf 'Specify the same existing stage with --stage and --confirm-disposable-stage.\n' >&2
  exit 2
fi
case "$STAGE" in
  prod|production)
    printf 'Production benchmarking is refused.\n' >&2
    exit 2
    ;;
  benchmark-*) ;;
  *)
    printf 'Stage must start with benchmark- to prove isolation.\n' >&2
    exit 2
    ;;
esac
if [[ ! "$WARM_INVOCATIONS" =~ ^[1-9][0-9]*$ || "$WARM_INVOCATIONS" -gt 20 ]]; then
  printf -- '--warm-invocations must be between 1 and 20.\n' >&2
  exit 2
fi
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || command -v python || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  printf 'Python 3 is required to build payloads and summarize results.\n' >&2
  exit 1
fi
for command_name in aws base64; do
  command -v "$command_name" >/dev/null || {
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  }
done

SERVICE="nestjs-aws-serverless-api"
functions=(api closeExpiredAuctions sendWinnerNotification)
declare -A original_memory=()
declare -A function_names=()

restore_memory() {
  local exit_code=$?
  trap - EXIT
  local function_name
  for function_name in "${!original_memory[@]}"; do
    printf 'Restoring %s to %s MiB.\n' "$function_name" "${original_memory[$function_name]}"
    if ! aws lambda update-function-configuration \
      --function-name "$function_name" \
      --memory-size "${original_memory[$function_name]}" \
      --region "$AWS_REGION" >/dev/null; then
      printf 'Failed to restore %s; restore it manually before deployment.\n' "$function_name" >&2
      exit_code=1
      continue
    fi
    aws lambda wait function-updated --function-name "$function_name" --region "$AWS_REGION" || exit_code=1
  done
  exit "$exit_code"
}
trap restore_memory EXIT

for function_key in "${functions[@]}"; do
  function_name="${SERVICE}-${STAGE}-${function_key}"
  function_names["$function_key"]="$function_name"
  original_memory["$function_name"]="$(aws lambda get-function-configuration \
    --function-name "$function_name" --region "$AWS_REGION" \
    --query 'MemorySize' --output text | tr -d '\r')"
  if [[ ! "${original_memory[$function_name]}" =~ ^[0-9]+$ ]]; then
    printf 'Could not read deployed configuration for %s.\n' "$function_name" >&2
    exit 1
  fi
done

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RESULT_DIR="${OUTPUT_ROOT}/${STAGE}-${RUN_ID}"
mkdir -p "$RESULT_DIR"
CSV="${RESULT_DIR}/invocations.csv"
SUMMARY="${RESULT_DIR}/summary.csv"
printf 'stage,function,memory_mib,invocation,billed_duration_ms,init_duration_ms,cost_usd\n' > "$CSV"

API_PAYLOAD="${RESULT_DIR}/api-health.json"
EXPIRATION_PAYLOAD="${RESULT_DIR}/expiration.json"
"$PYTHON_BIN" - "$API_PAYLOAD" "$EXPIRATION_PAYLOAD" "$RUN_ID" <<'PY'
import json
import sys
from datetime import datetime, timezone

api_path, expiration_path, run_id = sys.argv[1:]
now = datetime.now(timezone.utc)
api_event = {
    "version": "2.0",
    "routeKey": "GET /health",
    "rawPath": "/health",
    "rawQueryString": "",
    "headers": {"x-correlation-id": f"benchmark-{run_id}"},
    "requestContext": {
        "accountId": "benchmark",
        "apiId": "benchmark",
        "domainName": "benchmark.local",
        "domainPrefix": "benchmark",
        "http": {
            "method": "GET",
            "path": "/health",
            "protocol": "HTTP/1.1",
            "sourceIp": "127.0.0.1",
            "userAgent": "lambda-memory-benchmark",
        },
        "requestId": f"benchmark-{run_id}",
        "routeKey": "GET /health",
        "stage": "$default",
        "time": now.strftime("%d/%b/%Y:%H:%M:%S %z"),
        "timeEpoch": int(now.timestamp() * 1000),
    },
    "isBase64Encoded": False,
}
expiration_event = {
    "version": "0",
    "id": f"benchmark-{run_id}",
    "detail-type": "Scheduled Event",
    "source": "aws.events",
    "account": "benchmark",
    "time": now.isoformat(),
    "region": "eu-central-1",
    "resources": [],
    "detail": {},
}
with open(api_path, "w", encoding="utf-8") as stream:
    json.dump(api_event, stream)
with open(expiration_path, "w", encoding="utf-8") as stream:
    json.dump(expiration_event, stream)
PY

invoke_and_measure() {
  local function_key="$1"
  local memory="$2"
  local invocation_kind="$3"
  local sequence="$4"
  local function_name="${function_names[$function_key]}"
  local payload="$API_PAYLOAD"
  local invocation_id="${RUN_ID}-${function_key}-${memory}-${invocation_kind}-${sequence}"
  local invocation_json="${RESULT_DIR}/${invocation_id}.json"
  local response_json="${RESULT_DIR}/${invocation_id}.response.json"

  case "$function_key" in
    closeExpiredAuctions) payload="$EXPIRATION_PAYLOAD" ;;
    sendWinnerNotification)
      payload="${RESULT_DIR}/${invocation_id}.json.payload"
      "$PYTHON_BIN" - "$payload" "$invocation_id" <<'PY'
import json
import sys

path, invocation_id = sys.argv[1:]
body = {
    "auctionId": f"benchmark-{invocation_id}"[:128],
    "recipient": "success@simulator.amazonses.com",
    "title": "Lambda memory benchmark",
    "winningBid": "1.00",
}
event = {
    "Records": [{
        "messageId": f"benchmark-{invocation_id}",
        "receiptHandle": "benchmark",
        "body": json.dumps(body),
        "attributes": {},
        "messageAttributes": {},
        "md5OfBody": "benchmark",
        "eventSource": "aws:sqs",
        "eventSourceARN": "arn:aws:sqs:eu-central-1:000000000:benchmark",
        "awsRegion": "eu-central-1",
    }]
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(event, stream)
PY
      ;;
  esac

  aws lambda invoke \
    --function-name "$function_name" \
    --payload "fileb://${payload}" \
    --cli-binary-format raw-in-base64-out \
    --log-type Tail \
    --region "$AWS_REGION" \
    "$response_json" > "$invocation_json"

  "$PYTHON_BIN" - "$invocation_json" "$CSV" "$STAGE" "$function_key" "$memory" \
    "$invocation_kind" "$LAMBDA_ARM_PRICE_PER_GB_SECOND" "$LAMBDA_REQUEST_PRICE" <<'PY'
import base64
import csv
import json
import re
import sys

path, csv_path, stage, function, memory, kind, gb_price, request_price = sys.argv[1:]
with open(path, encoding="utf-8") as stream:
    result = json.load(stream)
if result.get("FunctionError"):
    raise SystemExit(f"Lambda returned FunctionError for {function}; inspect {path}")
encoded_logs = result.get("LogResult")
if not encoded_logs:
    raise SystemExit(f"Lambda returned no Tail logs for {function}")
logs = base64.b64decode(encoded_logs).decode("utf-8", errors="replace")
report = next((line for line in logs.splitlines() if line.startswith("REPORT RequestId:")), None)
if report is None:
    raise SystemExit(f"No REPORT line returned for {function}")
billed_match = re.search(r"Billed Duration:\s*(\d+)\s*ms", report)
if billed_match is None:
    raise SystemExit(f"No billed duration returned for {function}")
billed_ms = int(billed_match.group(1))
init_match = re.search(r"Init Duration:\s*([0-9.]+)\s*ms", report)
init_ms = float(init_match.group(1)) if init_match else 0.0
cost = (int(memory) / 1024) * (billed_ms / 1000) * float(gb_price) + float(request_price)
with open(csv_path, "a", newline="", encoding="utf-8") as stream:
    csv.writer(stream).writerow([
        stage, function, memory, kind, billed_ms, f"{init_ms:.2f}", f"{cost:.12f}",
    ])
print(f"{function:24} {memory:>4} MiB {kind:4} billed={billed_ms:>5} ms cost=${cost:.12f}")
PY
}

memory_sizes=(128 256 512 1024)
for memory in "${memory_sizes[@]}"; do
  for function_key in "${functions[@]}"; do
    function_name="${function_names[$function_key]}"
    printf 'Setting %s to %s MiB.\n' "$function_name" "$memory"
    aws lambda update-function-configuration \
      --function-name "$function_name" --memory-size "$memory" --region "$AWS_REGION" >/dev/null
    aws lambda wait function-updated --function-name "$function_name" --region "$AWS_REGION"

    # The first call follows a configuration change; Init Duration confirms its cold start.
    invoke_and_measure "$function_key" "$memory" cold 0
    for ((sequence = 1; sequence <= WARM_INVOCATIONS; sequence++)); do
      invoke_and_measure "$function_key" "$memory" warm "$sequence"
    done
  done
done

"$PYTHON_BIN" - "$CSV" "$SUMMARY" <<'PY'
import csv
import statistics
import sys
from collections import defaultdict

source, destination = sys.argv[1:]
groups = defaultdict(list)
with open(source, newline="", encoding="utf-8") as stream:
    for row in csv.DictReader(stream):
        groups[(row["stage"], row["function"], int(row["memory_mib"]))].append(row)
with open(destination, "w", newline="", encoding="utf-8") as stream:
    writer = csv.writer(stream)
    writer.writerow([
        "stage", "function", "memory_mib", "invocations",
        "average_billed_duration_ms", "average_init_duration_ms",
        "total_cost_usd", "cost_per_invocation_usd",
    ])
    for (stage, function, memory), rows in sorted(groups.items()):
        costs = [float(row["cost_usd"]) for row in rows]
        writer.writerow([
            stage, function, memory, len(rows),
            f"{statistics.mean(float(row['billed_duration_ms']) for row in rows):.2f}",
            f"{statistics.mean(float(row['init_duration_ms']) for row in rows):.2f}",
            f"{sum(costs):.12f}", f"{statistics.mean(costs):.12f}",
        ])
print(f"Summary written to {destination}")
PY
printf 'Results: %s\n' "$RESULT_DIR"
