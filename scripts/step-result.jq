# Is a step script's own result complete? (GitHub#599) Used only by the script that produced it,
# through _step.sh step_result, with the copy from that script's own release: a result it rejects is
# never written. Input: the result line, slurped (`jq -se`); $s = the script's name.
# True only for exactly one object whose `step` is $s, whose `status` is one this script defines,
# and which carries every field that status promises.
#
# The caller's check is NOT this table. Each base template's cavil_step carries a fixed, minimal
# check inline — exactly one object, `step` = the script it ran, `status` a string — and the agent
# treats a status the template does not describe as "outcome unknown". A template is rendered at
# dispatch and may call the script of a later release (PR #607 review rounds 2–4): a consumer-side
# table would reject a newer script's valid result, so that check never changes
# (tests/step-scripts.test.sh pins it, and runs an old template against a newer script).
# What a change here or in a script may do:
#   - add fields, add statuses, stop requiring a field: allowed (an older template ignores what it
#     does not read; a new status reads as "outcome unknown" there, never as success);
#   - never rename a status or give an existing one another meaning; in particular flip-label's
#     `done` is the one way to say "target reached on the read-back", in every future version.
{"flip-label":{"done":"labels","not-done":"missing still_on labels deletes_sent diag","unknown":"writes diag","usage":"diag"},"conflict-check":{"clean":"base head","conflict":"base head files","error":"stage diag","usage":"diag"},"pr-feedback":{"ok":"comments","error":"stage diag","usage":"diag"}} as $t | length == 1 and (.[0] as $r | ($r | type) == "object" and $r.step == $s and ($t[$s][$r.status | tostring] // null) as $n | $n != null and all($n | split(" ")[]; . as $k | $r | has($k)))
