# AirUX capture-plan guidance

Use this reference when translating a natural-language evidence request into `airux_create_review` input or when a capture attempt needs adjustment. The MCP tool's current input schema is the source of truth for field names and limits.

## Choose review metadata

- `title`: Name the feature or interaction being judged.
- `claim`: State the observable behavior the recording demonstrates; do not claim implementation details the video cannot prove.
- `criteria`: Use short, unique IDs and human-facing prompts. Include only facts the reviewer can judge from the recording.
- `client_request_id`: Use a stable identifier for one exact submission attempt. Retry the same payload with the same identifier; use a new identifier after changing the implementation, metadata, or capture.

## Design the recording

- Target only `localhost`, `127.0.0.1`, or `[::1]` over HTTP or HTTPS.
- Prefer selectors based on stable IDs, accessible roles represented as CSS where possible, or deliberate test attributes. Avoid brittle position-dependent selectors.
- Begin from a state the isolated browser can reproduce. The capture session does not inherit the developer's normal browser profile.
- Wait for visible or changed UI state before and after the important interaction. Use a short pause only when motion or timing itself is part of the evidence.
- Record the minimum setup needed to make the result understandable. Put the judged interaction near the center of the recording.
- Choose a viewport that matches the claim. Do not imply mobile coverage from a desktop-only recording.

Supported actions are `goto`, `click`, `fill`, `press`, `hover`, `drag`, `scroll`, `wait_for`, and `pause`. Arbitrary JavaScript is not supported.

## Example: button interaction

For “Provide video evidence that clicking Save shows a success message,” derive metadata and a plan resembling:

```json
{
  "client_request_id": "save-success-<unique-attempt>",
  "title": "Save confirmation",
  "claim": "Clicking Save displays the success confirmation.",
  "criteria": [
    {
      "id": "confirmation",
      "prompt": "After Save is clicked, the success confirmation is clearly visible."
    }
  ],
  "capture_plan": {
    "start_url": "http://127.0.0.1:3000/settings",
    "viewport": {
      "width": 1280,
      "height": 720
    },
    "max_duration_ms": 30000,
    "steps": [
      {
        "action": "wait_for",
        "selector": "#save-button",
        "state": "visible"
      },
      {
        "action": "click",
        "selector": "#save-button"
      },
      {
        "action": "wait_for",
        "selector": "#save-success",
        "state": "visible"
      },
      {
        "action": "pause",
        "duration_ms": 1000
      }
    ]
  }
}
```

Replace every example value with details observed in the current application. Do not call selectors or behavior valid without inspecting or exercising them.
