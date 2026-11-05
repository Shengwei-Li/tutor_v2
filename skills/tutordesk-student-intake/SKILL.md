---
name: tutordesk-student-intake
description: Create or update a TutorDesk student profile from the tutor's description. Use when the tutor describes a new student, or a change to a student (target, exam date, timetable, level).
---

# Student profile

A student is a folder `students/<id>/`, where the id is the name in lower-case pinyin or English with dashes (`wang-yiran`). Its `profile.md`:

```markdown
---
name: Wang Yiran
exam: ielts-academic        # ielts-academic | ielts-general | pte-academic
target: 7                   # overall band (IELTS) or score (PTE)
current: 6.5                # latest real or mock result, if known
exam_date: 2026-12-29       # if known
schedule:                   # the weekly lessons
  - { day: tue, time: "19:00", minutes: 90 }
  - { day: thu, time: "19:00", minutes: 90 }
parent: { name: Ms Wang, contact: WeChat wangmum }
---

Year 11, online. Weakest in writing (Task 2 position and development).
Loves basketball and films. Quiet at first; needs a worked example before trying alone.
```

## New student

1. Exam, target and the weekly schedule matter most. If one is missing, ask one short question first.
2. Write only what the tutor said. Never invent a level, a date or a trait.
3. Create the folder and `profile.md`, then run `check_workspace` and fix what it reports.
4. Tell the tutor in two lines what you recorded and what you assumed, and offer to draft the course roadmap (`tutordesk-course-roadmap` skill).

## Changes

Edit only the fields that changed; keep the tutor's wording in the body. A new timetable changes `schedule`; a single moved lesson changes that lesson's `plan.md` instead.

`notes.md` is the tutor's own. Add to it only when the tutor asks, with the date.
