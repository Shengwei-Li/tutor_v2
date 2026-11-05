---
name: tutordesk-writing-review
description: Review a student's IELTS Writing Task 1 or 2 essay, or transcribe a photographed one, into the TutorDesk student folder. Use when the tutor asks to mark, review, correct or transcribe an essay.
---

# Essay review

An essay is a folder `essays/<date>-<task>/` in the student folder (`essays/2026-11-02-task2/`) with `essay.md` (the question, then the student's text exactly as written) and `review.md`.

## Photo of handwriting

Transcribe exactly as written: keep the student's mistakes, mark unreadable words `[?]`. Save `essay.md`, then stop and ask the tutor to check the transcription before reviewing.

## Review

Read `profile.md`, earlier reviews and the `tutordesk-exam-ielts` skill, then write `review.md`:

```markdown
---
date: 2026-11-02
task: task2
estimate: { TR: "6-6.5", CC: "6", LR: "6-6.5", GRA: "5.5-6" }
---

## Top three issues
1. W-TR-POS: … what to do next time.

## Annotations
- "Some people think … but others think" (W-TR-POS): no position of the writer's own.
…

## Rewrite
The second body paragraph, raised by half to one band, keeping Yiran's idea.

## Next task
One focused task.
```

- A band range per criterion (half bands, at most one band wide), with quoted evidence.
- Up to 20 annotations; every quote copied character for character from the essay.
- Be honest and encouraging; never promise a score.

Tell the tutor the three top issues in one line each. The tutor gives the final bands: when they do, add `final: { TR: 6, CC: 6, LR: 6.5, GRA: 6 }` to the YAML. Only final bands reach the parent page.
