---
name: tutordesk-lesson-record
description: Record how a TutorDesk lesson went (what was covered, what the student struggled with, homework) so the next lesson builds on it. Use when the tutor reports on a lesson that has happened.
---

# After the lesson

Write `record.md` in the lesson folder from what the tutor tells you:

```markdown
---
for_parents: Practised stating a clear position; Yiran wrote two strong introductions by the end.
homework: One Task 2 introduction and body paragraph on the remote-work question.
---

## Covered
- Position statements; the PEEL body paragraph up to Example.

## Not yet mastered
- Holds the position in the introduction but drifts in the conclusion (W-TR-POS).

## Observations
- Needed the worked example twice; faster once the topic was basketball.
```

Then:
1. Set the lesson's `status: taught` in `plan.md`.
2. Tick its line in `roadmap.md` (`- [x]`). If the lesson changed the plan, revise the next lines and say what moved.
3. Run `check_workspace` for the student.

`for_parents` is the only part parents ever see: one or two plain, encouraging, honest sentences, no error codes, nothing the tutor would not say to the parent. Everything else stays with the tutor. If the tutor did not mention something, do not invent it.
