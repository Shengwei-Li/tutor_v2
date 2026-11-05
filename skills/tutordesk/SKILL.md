---
name: tutordesk
description: Start here for any TutorDesk work, the tutor's one-to-one IELTS and PTE teaching (students, lessons, course plans, materials, essays, parents). Sets up the tutor's workspace the first time and opens the TutorDesk desk.
---

# TutorDesk

TutorDesk keeps a private tutor's students and lessons as plain files in one folder (the workspace), and turns lesson materials into PDFs. The `tutordesk` tools are how you check that folder, export PDFs and open the desk.

## First time

If a TutorDesk tool says there is no workspace yet:

1. Ask the tutor, in one line, where to keep their student files. Suggest a `TutorDesk` folder in their Documents; also ask their name and studio name if you do not know them.
2. Call `setup_workspace` with that folder.
3. Call `open_desk`: the desk opens in the tutor's browser. Tell them it shows their week, their students and what needs them, and that they can keep it open.
4. Carry on with what the tutor asked for (often: describe the first student, `tutordesk-student-intake`).

## Every time

- If `tutordesk.yaml` still says `My Tutoring Studio` or has no tutor name, ask the tutor once for their name and studio name (they appear on every material) and write them there.
- Work in the workspace the tools report. Read its `AGENTS.md` once per conversation.
- When the tutor asks to see something ("show me the week", "where is the plan"), call `open_desk` rather than pasting the file.
- Use the skill for the job: `tutordesk-student-intake`, `tutordesk-course-roadmap`, `tutordesk-lesson-prep`, `tutordesk-lesson-materials`, `tutordesk-lesson-record`, `tutordesk-writing-review`; `tutordesk-teaching-standards` and `tutordesk-exam-ielts` / `tutordesk-exam-pte` for every plan and material.
- The tutor never needs a terminal. Do not tell them to run commands; do the step yourself or say what to click on the desk.
