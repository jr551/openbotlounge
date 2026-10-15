#!/bin/bash
# Verifies the security behaviour against a running instance.
#   APP_PASSWORD=pw ./scripts/verify-security.sh <base-url> <host:port the browser uses>
set -u
B=${1:?base url}
HOST=${2:?host:port as the browser sees it}
FAIL=0
check() {
  if [ "$2" = "$3" ]; then printf '  PASS  %-56s %s\n' "$1" "$3"
  else printf '  FAIL  %-56s got %s want %s\n' "$1" "$3" "$2"; FAIL=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "── a write aimed at us by another site is refused ──"
check "text/plain POST from a foreign origin" 403 \
  "$(code -X POST "$B/api/bots" -H 'content-type: text/plain' -H 'Origin: http://evil.example' -d '{"name":"x"}')"
check "form POST from a foreign origin" 403 \
  "$(code -X POST "$B/api/bots" -H 'content-type: application/x-www-form-urlencoded' -H 'Origin: http://evil.example' -d 'name=x')"
check "JSON POST from a foreign origin" 403 \
  "$(code -X POST "$B/api/bots" -H 'content-type: application/json' -H 'Origin: http://evil.example' -d '{"name":"x"}')"
check "opaque origin" 403 \
  "$(code -X POST "$B/api/bots" -H 'content-type: text/plain' -H 'Origin: null' -d '{"name":"x"}')"

echo "── the things that must keep working ──"
if [ -n "${APP_PASSWORD:-}" ]; then
  # with a password set an unauthenticated write is refused - but it must be the
  # auth gate answering (401), not the origin check (403)
  check "same-host JSON POST reaches the auth gate" 401 \
    "$(code -X POST "$B/api/bots" -H 'content-type: application/json' -H "Origin: $B" -d '{"name":"probe","persona":"x"}')"
else
    BODY=$(curl -s -w '\n%{http_code}' -X POST "$B/api/bots" -H 'content-type: application/json' \
    -H "Origin: $B" -d '{"name":"security-probe","persona":"x"}')
  STATUS=$(printf '%s' "$BODY" | tail -1)
  PROBE_ID=$(printf '%s' "$BODY" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  check "same-host JSON POST" 201 "$STATUS"
  # leave nothing behind
  [ -n "$PROBE_ID" ] && curl -s -o /dev/null -X DELETE "$B/api/bots/$PROBE_ID"
fi
check "webhook POST with no Origin (server to server)" 404 \
  "$(code -X POST "$B/api/hooks/bogus-token" -H 'content-type: application/json' -d '{"a":1}')"
check "webhook POST with no Origin, form encoded" 404 \
  "$(code -X POST "$B/api/hooks/bogus-token" -H 'content-type: application/x-www-form-urlencoded' -d 'a=1')"

if [ -n "${APP_PASSWORD:-}" ]; then
  echo "── the login a browser actually performs ──"
  JAR=$(mktemp)
  check "form POST with the browser's own Origin" 200 \
    "$(code -c "$JAR" -X POST "$B/login" -H 'content-type: application/x-www-form-urlencoded' -H "Origin: $B" -d "password=$APP_PASSWORD")"
  check "and the session then works" 200 "$(code -b "$JAR" "$B/api/bots")"
  check "a foreign origin cannot log in" 403 \
    "$(code -X POST "$B/login" -H 'content-type: application/x-www-form-urlencoded' -H 'Origin: http://evil.example' -d "password=$APP_PASSWORD")"
  COOKIE=$(curl -s -D - -o /dev/null -X POST "$B/login" -H 'content-type: application/x-www-form-urlencoded' -H "Origin: $B" -d "password=$APP_PASSWORD" | grep -i '^set-cookie' | head -1)
  case "$COOKIE" in
    *"; Secure"*) check "over http the cookie is not Secure" no-secure secure ;;
    *) check "over http the cookie is not Secure" no-secure no-secure ;;
  esac
  rm -f "$JAR"
fi

exit $FAIL
