# Is a step script's own result complete? (GitHub#599) Used by the script that produced it, through
# _step.sh step_result, with the copy from that script's own release: a result it rejects is never
# written. Input: the result line, slurped (`jq -se`); $s = the script's name.
# True only for exactly one object whose `step` is $s, whose `status` is one this script defines,
# and which carries every field that status promises.
#
# The caller's side is tests/fixtures/step-result-stable.jq, carried inline by every base template
# and never edited: a template rendered at dispatch may call the script of a later release (PR #607
# review rounds 2–5). So this table is that stable table plus additions only:
#   - allowed: a new field on a status, a new status (an older template reads it as "outcome
#     unknown", never as success);
#   - never: drop a status, drop a field a status already promises, rename a status or change what
#     it means (flip-label's `done` = "target reached on the read-back", in every version).
# tests/step-scripts.test.sh checks the superset rule.
{"flip-label":{"done":"labels","not-done":"missing still_on labels deletes_sent diag","unknown":"writes diag","usage":"diag"},"conflict-check":{"clean":"base head","conflict":"base head files","error":"stage diag","usage":"diag"},"pr-feedback":{"ok":"comments","error":"stage diag","usage":"diag"}} as $t | length == 1 and (.[0] as $r | ($r | type) == "object" and $r.step == $s and ($t[$s][$r.status | tostring] // null) as $n | $n != null and all($n | split(" ")[]; . as $k | $r | has($k)))
