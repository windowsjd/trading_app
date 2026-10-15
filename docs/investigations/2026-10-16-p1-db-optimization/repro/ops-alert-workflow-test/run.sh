#!/bin/bash
# Runs the ops-readiness-alerts.yml step script against a local scripted HTTP
# server with a fake `gh` (one-issue state file), a no-op `sleep` and a Python
# stand-in for the three jq filters it uses. Usage: bash run.sh
set -u
D=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d)
python3 -c "import yaml;w=yaml.safe_load(open('$D/../../../../../.github/workflows/ops-readiness-alerts.yml'));open('$T/step.sh','w').write(w['jobs']['check']['steps'][0]['run'])"
: > $T/queue; python3 $D/server.py 57991 $T/queue > /dev/null 2>&1 & S=$!; sleep 1
cd "$T"  # the step writes body.json into its working directory
run() { local name=$1; shift; printf '%s\n' "$@" > $T/queue
  env PATH="$D/bin:$PATH" URL="${URLV-http://127.0.0.1:57991/readiness/alerts}" GH_TOKEN=x GH_REPO=o/r GH_STATE=$T/state.json GH_LOG=$T/gh.log bash -e $T/step.sh > $T/out.txt 2>&1
  echo "$name exit=$? issues=$(cat $T/state.json 2>/dev/null || echo '[]' | head -c 0)"; }
A='503 {"data":{"alerts":["DB_STORAGE_WARNING"]}}'; AB='503 {"data":{"alerts":["DB_STORAGE_WARNING","FUTURES_MARK_STALE"]}}'; OK='200 {"data":{"alerts":[]}}'
: > $T/gh.log
URLV= run unset; run healthy "$OK" "$OK"; run blip "$A" "$OK"; run persistent "$A" "$A"; run same "$A" "$A"
run changed "$AB" "$AB"; run half-recovered "$OK" "$AB"; run recovered "$OK" "$OK"
rm -f $T/state.json; URLV=http://127.0.0.1:57999/readiness/alerts run unreachable
echo "gh calls:"; cat $T/gh.log; kill $S
