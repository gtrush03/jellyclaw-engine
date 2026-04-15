---
# Session closeout — update completion log

After completing the task above:

1. **Update `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md`:**

   - Find the `### Phase <NN> — <name>` section
   - If this prompt completed a SUB-PROMPT (phase has multiple), add a checkmark for that sub-prompt in the "Notes" section
   - If this prompt completed the PHASE, change `- [ ] Phase <NN>` to `- [x] ✅ Phase <NN>` in the checklist
   - Update the progress bar and counter: `[██░░░░░░░░...] X/20 phases complete (Y%)`
   - Update "Current phase" top field to the next phase if this one is fully complete
   - Update the Phase <NN> completion details block:
     - Status: ✅ Complete (or 🔄 In progress if sub-prompt)
     - Completed: <today's date> (if phase done)
     - Duration (actual): <X days>
     - Session count: <X>
     - Commits: <short hashes>
     - Tests passing: <X/Y>
     - Notes: <what landed, any deviations from spec>
   - Add a row to the Session log table:
     - Date | Session # | Phase | Sub-prompt | Outcome

2. **Update `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md`:**
   - Current phase field
   - Last updated timestamp
   - Tests passing count
   - Any new blockers

3. **Commit the log updates:**
   ```bash
   git add COMPLETION-LOG.md STATUS.md
   git commit -m "docs: phase <NN> <sub-prompt> progress"
   ```

4. **Tell the user:**
   - What landed
   - Tests status (pass/fail count)
   - Any blockers found
   - Next prompt to run (file path + when to start a new Claude session — almost always yes, start a new session per prompt)

5. **If phase is fully complete, suggest:**
   "✅ Phase <NN> complete. Start a new Claude Code session and run `prompts/phase-<NN+1>/01-<name>.md` next."
