# Is the fd-3 output of a step script a whole, valid result? (GitHub#599)
# Input: everything after the STARTED line, slurped (`jq -se`); $s = the script name the caller ran.
# True only for exactly one object whose `step` is $s, whose `status` is one this script defines,
# and which carries every field that status promises. The templates' cavil_step and the scripts'
# own tests use this one file; anything else is "did not finish, outcome unknown".
{
  "flip-label": {"done": ["labels"], "not-done": ["missing", "still_on", "labels", "deletes_sent", "diag"],
                 "unknown": ["writes", "diag"], "usage": ["diag"]},
  "conflict-check": {"clean": ["base", "head"], "conflict": ["base", "head", "files"],
                     "error": ["stage", "diag"], "usage": ["diag"]},
  "pr-feedback": {"ok": ["comments"], "error": ["stage", "diag"], "usage": ["diag"]}
} as $table
| length == 1 and (.[0] as $r
  | ($r | type) == "object" and ($r.step | type) == "string" and $r.step == $s
    and ($r.status | type) == "string"
    and ($table[$s][$r.status] // null) as $need
    | $need != null and all($need[]; . as $k | $r | has($k)))
