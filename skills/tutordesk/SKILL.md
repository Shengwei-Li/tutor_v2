---
name: tutordesk
description: Start here for any TutorDesk work, the tutor's one-to-one IELTS and PTE teaching (students, lessons, course plans, materials, essays, parents). Says where things are and which skill does which job.
---

# TutorDesk

TutorDesk keeps a private tutor's students and lessons as plain files in one folder (the workspace), and turns lesson materials into PDFs. You read and write the files; the `tutordesk` tools check them, export PDFs and make the parent page.

## Where you are

- **Inside the TutorDesk app** (your instructions say so): the tutor sees the desk next to this conversation, with their week, students, plans and PDFs. Do not open or paste what they can already see; say in a line or two what you did and what is ready for them.
- **In the tutor's own agent** (no such instruction): call `open_desk` when they want to look at something. If a tool says there is no workspace, ask where to keep the student files (suggest a `TutorDesk` folder in Documents) and call `setup_workspace`.

## Every time

- Read the workspace's `AGENTS.md` once per conversation.
- If `tutordesk.yaml` still says `My Tutoring Studio` or has no tutor name, ask the tutor once for their name and studio name (they appear on every material) and write them there.
- Use the skill for the job: `tutordesk-student-intake`, `tutordesk-course-roadmap`, `tutordesk-lesson-prep`, `tutordesk-lesson-materials`, `tutordesk-lesson-record`, `tutordesk-writing-review`; `tutordesk-teaching-standards` and `tutordesk-exam-ielts` / `tutordesk-exam-pte` for every plan and material.
- The tutor approves lesson plans with the button on the desk. You cannot approve for them.
- The tutor never needs a terminal. Do not tell them to run commands.
