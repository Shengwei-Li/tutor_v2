---
name: lesson-prep
description: Plan one TutorDesk lesson for a student, wait for the tutor's approval, then write and export its materials. Use when the tutor asks to prepare, plan or get ready for a lesson.
---

# Preparing a lesson

## 1. Gather the evidence

Read, in the student folder:
- `profile.md`: exam, target, current level, lesson length, interests.
- `roadmap.md`: which step of the plan this lesson is.
- The last two lessons' `record.md`: what was not mastered, the homework.
- `essays/*/review.md`: recent errors with their codes.
- `notes.md`: the tutor's observations.

If there is no `roadmap.md` yet, use the `course-roadmap` skill first.

## 2. Write the plan

Create `lessons/<date>-<topic-slug>/plan.md`, for example `lessons/2026-11-06-task2-position/plan.md`:

```markdown
---
date: 2026-11-06
time: "19:00"
minutes: 90
topic: Stating a clear position in Task 2
status: draft
---

## Objectives
By the end, Yiran can … (observable, each with how it is checked)

## Evidence
- W-TR-POS: "Some people think … but others think …" (essay 2026-11-02): no position of her own.
- From last lesson: …

## Stages
| Min | Stage | What happens | Material |
|---|---|---|---|
| 8 | Retrieval | … | worksheet A |
…

## Materials
handout, worksheet, deck (script only if the tutor wants one)
```

Rules: stage minutes add up to the lesson length; one core skill; open with retrieval of last lesson; a check stage tests every objective; the student produces language for at least half the lesson. Check the plan against `teaching-standards` before showing it.

Run `check_workspace` for the student and fix anything it reports.

## 3. Stop for approval

Summarise the plan in five lines or fewer and ask the tutor to approve it, in the chat or on the TutorDesk desk. **Do not write materials yet.**

Set `status: approved` only when the tutor approves in so many words; if they ask for changes, edit the plan and ask again. On the desk, the tutor's approval sets the status for you: re-read `plan.md`, the tutor may also have edited it.

## 4. Materials

Use the `lesson-materials` skill for each material the plan lists. When every PDF is exported, set `status: ready` and tell the tutor what is ready and anything worth a look.
