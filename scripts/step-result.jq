# Is the fd-3 output of a step script a whole, valid result? (GitHub#599)
# Input: everything after the STARTED line, slurped (`jq -se`); $s = the script name the caller ran.
# True only for exactly one object whose `step` is $s, whose `status` is one this script defines,
# and which carries every field that status promises.
#
# The program is the one line below, and it exists twice on purpose — never as a copy on disk next to
# the entrypoints (PR #607 review rounds 2 and 3: a copied file can be left behind or replaced out of
# step with the release that uses it):
#   - the templates' cavil_step carries it inline, rendered with the template it belongs to;
#   - each script checks its own result with this file from its own release before writing it
#     (_step.sh step_result), so a result its own release would reject is never sent.
# tests/step-scripts.test.sh requires the inline copy in every base template to equal this line.
# A template and the script it calls can come from different releases around a switch: a change here
# may only add statuses or drop requirements, never require a field an older script does not write.
{"flip-label":{"done":"labels","not-done":"missing still_on labels deletes_sent diag","unknown":"writes diag","usage":"diag"},"conflict-check":{"clean":"base head","conflict":"base head files","error":"stage diag","usage":"diag"},"pr-feedback":{"ok":"comments","error":"stage diag","usage":"diag"}} as $t | length == 1 and (.[0] as $r | ($r | type) == "object" and $r.step == $s and ($t[$s][$r.status | tostring] // null) as $n | $n != null and all($n | split(" ")[]; . as $k | $r | has($k)))
