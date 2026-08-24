---
name: goal
description: Resume the repository's planner-generated or native development campaign.
type: prompt
whenToUse: When the user asks to continue, resume, execute, or finish the current development goal.
disableModelInvocation: false
---
Read applicable `AGENTS.md`, `.agent/PLANNER_HANDOFF.md`, `.agent/EXECUTION_PROMPT.md` if present, and native goal/campaign/state/OpenSpec files. Inspect current Git/implementation. Reconcile work since `Planned-From`; if the prompt is `ACTIVE`, resume the first genuinely incomplete requirement autonomously, preserve intended behavior, avoid unrelated rewrites, validate, fix introduced Critical/High regressions, update durable state, and commit/push per repository policy. Otherwise fall back to native continuation semantics; if none exists, report that a planner pass is required.