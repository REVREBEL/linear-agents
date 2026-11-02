# ChatGPT Apple Shortcuts handoff

The bridge can pass an existing ChatGPT conversation URL and prompt to one macOS Shortcut. The interface is the private `*.chatgpt-handoff.json` file the bridge already writes:

```json
{
  "handoffId": "BRIDGE_JOB_ID",
  "projectUrl": "https://chatgpt.com/g/g-p-PROJECT/c/CONVERSATION",
  "conversationMode": "reuse-existing",
  "prompt": "Text to submit"
}
```

## Build the master shortcut

Create a shortcut named **Linear ChatGPT Handoff**. At the top, change **Receive** to **Files** and leave the source as **Nowhere**. Set the no-input behavior to **Stop and Respond**; do not use the clipboard as the input fallback.

Add these actions before the existing, tested browser/paste actions:

1. **Get Contents of File** from **Shortcut Input**.
2. **Get Dictionary from Input** using the file contents.
3. **Get Dictionary Value** for `projectUrl`; set variable `ChatGPT_URL`.
4. **Get Dictionary Value** for `prompt` from the same Dictionary; set variable `ChatGPT_Prompt`.
5. **Get Dictionary Value** for `handoffId` from the same Dictionary; set variable `ChatGPT_handoffId`.
6. **Open URLs** with `ChatGPT_URL`.
7. **Copy to Clipboard** with `ChatGPT_Prompt`.

Then keep the tested wait and AppleScript paste/submit actions. Remove the hard-coded project folder, `text-file.txt`, answer-copying, and outbox-save actions unless a separate response-capture workflow still needs them. The bridge does not treat browser text selection as a verified ChatGPT response.

The command-line runner supplies a **file**, not two positional text arguments. That is why the shortcut must receive Files and decode the JSON before asking for its two dictionary values.

Test the shortcut without submitting a real bridge job:

```bash
node scripts/chatgpt-shortcuts/handoff.mjs \
  --handoff-file "/absolute/path/to/test.chatgpt-handoff.json" \
  --dry-run

node scripts/chatgpt-shortcuts/handoff.mjs \
  --handoff-file "/absolute/path/to/test.chatgpt-handoff.json"
```

The first command validates only. The second runs the installed Shortcut. The shortcut name can be overridden with `CHATGPT_SHORTCUT_NAME`.

## Bridge configuration

Keep the mapped project restricted to an existing conversation and explicitly authorize automatic submission:

```json
{
  "chatgpt": {
    "projectUrl": "https://chatgpt.com/g/g-p-PROJECT/c/CONVERSATION",
    "conversationMode": "reuse-existing",
    "autoSend": true
  }
}
```

Set `CHATGPT_HANDOFF_MODE=shortcuts` in the bridge environment and restart the user LaunchAgent. Shortcuts UI automation requires a logged-in, unlocked macOS GUI session plus Automation and Accessibility permission for Shortcuts. A command succeeding only means the Shortcut finished; verify the first real test reached the intended conversation and submitted once.

Playwright remains available with `CHATGPT_HANDOFF_MODE=supervised-playwright`. Do not run both controllers for the same delivery.
