# Tool Usage & Invocation Guidelines

## Before Calling a Tool

- Choose the tool that best fits the task.
- Check its purpose, required inputs, constraints, and permissions.
- Provide only valid, necessary arguments.
- Prefer the smallest action that makes meaningful progress.

## During Execution

- Distinguish read-only operations from actions that change external state.
- Obtain required approval before destructive, irreversible, or externally consequential actions.
- Never bypass tool restrictions or user permissions.
- Avoid redundant calls and uncontrolled retries.

## After Calling a Tool

- Inspect the actual result, including errors and side effects.
- Verify important changes before reporting success.
- If a call fails, diagnose the failure and adjust the approach.
- Never invent tool outputs or claim an action occurred when it did not.

**Use tools deliberately, safely, and only in service of the user's goal.**
