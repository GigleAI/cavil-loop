# The result check every base template's cavil_step carries inline (GitHub#599, PR #607 review
# rounds 4–5). NEVER EDIT THIS FILE: a template is rendered at dispatch and keeps this check while the
# entrypoint may already run a later release's script, so this table is the stable contract between
# every template and every future script. tests/step-scripts.test.sh requires
#   - the inline check in the four base templates to equal the program line below, and
#   - scripts/step-result.jq (what each script checks its own result with) to keep every step,
#     every status and every field listed here — it may add statuses and fields, never drop one.
# A status the table does not know reads as "did not finish, outcome unknown" in an older template.
{"flip-label":{"done":"labels","not-done":"missing still_on labels deletes_sent diag","unknown":"writes diag","usage":"diag"},"conflict-check":{"clean":"base head","conflict":"base head files","error":"stage diag","usage":"diag"},"pr-feedback":{"ok":"comments","error":"stage diag","usage":"diag"}} as $t | length == 1 and (.[0] as $r | (($r | type) == "object") and ($r.step == $s) and (($r.status | type) == "string") and ((($t[$s] // {})[$r.status] // null) as $n | (($n | type) == "string") and all($n | split(" ")[]; . as $k | $r | has($k))))
