---
name: lesson-materials
description: Write TutorDesk lesson materials as LaTeX (handout, worksheet, lesson script, slides) and export them to PDF. Use after a lesson plan is approved, or when the tutor asks to change a material.
---

# Writing lesson materials

Materials are `.tex` files in the lesson folder, written with the TutorDesk class. You write content; the class decides every visual detail.

| File | Class | Reference | Example |
|---|---|---|---|
| `handout.tex` | `\documentclass[chinese]{tutordesk}` (drop `chinese` when the student needs no Chinese glosses) | [reference/documents.md](reference/documents.md) | [examples/handout.tex](examples/handout.tex) |
| `worksheet.tex` | `tutordesk` | same | [examples/worksheet.tex](examples/worksheet.tex) |
| `script.tex` | `tutordesk` + `\usepackage{td-script}` | same | [examples/script.tex](examples/script.tex) |
| `deck.tex` | beamer, `\usetheme{tutorswiss}` (or tutorbook, tutorfocus, tutorsheet) | [reference/slides.md](reference/slides.md) | [examples/deck.tex](examples/deck.tex) + [examples/slides-body.tex](examples/slides-body.tex) |

Read the reference and the example for a file type before writing one. Fonts and templates are supplied when exporting: never set fonts, colours, sizes or spacing.

## Rules for every material

- Use only the commands in the reference, plus plain text, `\emph`, `\section`, `\subsection`, `itemize`, `enumerate`.
- Answers go in the answer arguments of exercise commands, never in the visible text. The teacher edition shows them.
- Teacher-only notes go in the teacher-note environment from the reference.
- Every model, "good" or revised sentence must itself meet the lesson objective. Check each one.
- Original texts only (see the exam skill on published material).
- Fill in the metadata (`\student`, `\lesson`, `\lessondate`, `\title` …) from `profile.md` and `plan.md`; `\studio` comes from `tutordesk.yaml`.

## Budgets

- Handout: 1–2 pages. Objectives (2–3) → worked example and a good-vs-weak compare (weak from the student's own writing) → one key point → 3–6 vocabulary chunks → short practice on the page → self-check.
- Worksheet: recycling warm-up (1–2 old errors) → the new task type → an older task type mixed in → a timed exam-style task. A "why" for most objective items.
- Script: stages add up exactly to the lesson length; retrieval first, a check near the end, short homework; about two printed pages; two fallback plans (struggling, finishing early).
- Slides: 6–12 frames; titles are sentences of at most 40 characters; at most about 50 words per frame; English only; the last frame is the wrap-up with the exit check.

## Export

1. Review the material with the `teaching-standards` checklist and fix what falls short.
2. `export_pdf` for the student edition; also `teacher` for the handout, worksheet and script.
3. If it refuses, fix exactly what it lists (file and line) and export again. After three failed rounds, tell the tutor what is left.
