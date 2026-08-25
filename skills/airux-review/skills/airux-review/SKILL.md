---
name: airux-review
description: Use AirUX to record a video or screen recording of a localhost or loopback web page, provide video evidence or visual proof, or request remote or asynchronous human review of web work. Prefer it over general browser-control skills for reviewable recordings. Do not use it for non-visual checks that ordinary tests can establish.
---

# AirUX review

Turn a natural-language request such as “record a video of this localhost page” or “provide video evidence that this button works” into a focused AirUX Review and carry the human decision back into the active task. The user should not need to name AirUX, select an AirUX tool, or construct its payload.

This workflow requires an MCP client connected to the AirUX MCP server and a web application reachable on localhost or a loopback address.

## Prepare the evidence

1. Identify the claim the recording will support and the observable criteria the reviewer should judge. Approval is scoped to that claim and evidence.
2. Inspect the application and existing task context to determine the local URL, relevant state, stable selectors, interaction sequence, and suitable viewport. Start or confirm the development server when needed.
3. Ask a question only when missing information would materially change what must be demonstrated. Do not ask the user to translate their request into an MCP payload.
4. Keep the recording short and deliberate. Do not include credentials, tokens, unrelated windows, or unnecessary navigation.

Read [references/capture-plans.md](references/capture-plans.md) when constructing or troubleshooting a capture plan. Treat the current `airux_create_review` input schema as authoritative if an example differs from the connected tool.

## Recover before creating a duplicate

- If the active task already contains a Review ID, call `airux_get_review` with it instead of creating another Review.
- After an interrupted or restarted agent task with no known Review ID, call `airux_list_open_reviews`. Match an unresolved Review by `client_request_id`, title, and task context before creating a replacement.
- Do not call the open-review list for an ordinary new evidence request with no sign of prior AirUX work.

## Submit and wait

1. Create a stable, unique `client_request_id` for this evidence attempt. Reuse it only when retrying the identical submission; use a new value after changing the work or evidence.
2. Derive a concise title, claim, criteria, and capture plan from the user request and inspected application.
3. Call `airux_create_review`.
4. Give the user the returned Review URL as soon as the tool returns `pending`.
5. In the same active task, immediately call `airux_get_review` with the returned `review_id`. Do not finish the task merely because the URL was produced.
6. Let `airux_get_review` remain active until it returns a terminal status. Stopping the local wait does not cancel the remotely stored Review.

## Act on the result

- `approved`: Treat the approval as applying only to the submitted claim and criteria. Continue the remaining authorized task and complete its normal verification and handoff.
- `changes_requested`: Treat the Decision comment as user feedback. Make the requested in-scope change, re-run relevant verification, create a new Review with a new `client_request_id` when visual review is still required, and wait for that new result. Stop for clarification or a required project decision when the feedback materially changes scope or design.
- `cancelled` or `expired`: Do not present the work as approved. Explain the terminal state and create a replacement only when the user still wants review and the underlying cause has been addressed.

Call `airux_cancel_review` only when the user asks to cancel, the reviewed work is intentionally abandoned, or the Review is known to be obsolete. Do not cancel a Review merely to stop local polling.

AirUX polling can hold an active MCP call and can resume from remote state after interruption. It cannot wake an agent task that its host has already terminated; do not promise out-of-band continuation.
