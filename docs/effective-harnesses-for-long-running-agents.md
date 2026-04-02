# Effective Harnesses for Long-Running Agents

Source: `Effective harnesses for long-running agents _ Anthropic.mhtml`

## Topic

How to build an agent harness that lets coding agents make reliable progress across many context windows.

## Extracted Content

The article argues that long-running agents fail when each new session starts without clear memory of prior work. Context compaction alone is not enough. In practice, agents lose track of partial implementations, attempt too much at once, or stop early after seeing some visible progress.

Anthropic describes a two-part harness to address this:

1. An initializer agent prepares the environment on the first run.
2. A coding agent makes incremental progress in later sessions while leaving clean handoff artifacts.

The initializer agent creates the scaffolding that later sessions depend on. That includes:

- an `init.sh` script to start the environment consistently
- a progress log such as `claude-progress.txt`
- an initial git commit that records the starting state
- a structured feature list that expands the original prompt into concrete end-to-end requirements

The coding agent then works one feature at a time instead of trying to complete the full project in one pass. Each session is expected to leave the repository in a clean state, meaning the code should be stable enough that another developer or later agent can continue without first repairing unrelated breakage.

The article emphasizes that structured state external to the model is what makes multi-session work possible. The progress log and git history let a fresh session recover context quickly. The feature list prevents the agent from declaring the project done too early and provides a concrete backlog of work.

Anthropic reports several common failure modes:

- the agent tries to one-shot the entire application
- the agent leaves partial, undocumented work behind
- the agent marks features complete without adequate verification
- the agent wastes time rediscovering how to run and test the project

The harness addresses these with explicit environment setup, incremental execution, disciplined progress recording, and stronger verification requirements.

## Key Practices

### 1. Use Different Prompts for First Run and Later Runs

The first session should not behave like a normal coding session. Its job is to set up durable project artifacts that future sessions can reuse.

### 2. Maintain a Structured Feature List

The initializer should expand the original task into a comprehensive list of end-to-end features. The article notes that JSON worked better than Markdown because the model was less likely to overwrite or casually restructure it. Coding agents should only update feature status, not rewrite the feature definitions.

### 3. Force Incremental Progress

Later sessions should select one unfinished feature and work on that feature only. This reduces context exhaustion and lowers the odds of half-finished, undocumented code paths.

### 4. Leave a Clean Handoff State

Each session should end with:

- working code
- a descriptive git commit
- a progress update explaining what changed and what remains

This gives the next session a stable checkpoint instead of requiring it to infer prior intent.

### 5. Start by Reconstructing State

At the beginning of a new session, the coding agent should:

- confirm the working directory
- read the progress log
- read the feature list
- inspect recent git history
- restart the app using the bootstrap script
- run a basic end-to-end verification before adding new work

This startup routine helps detect pre-existing breakage before new code makes the situation worse.

### 6. Verify Features End to End

The article identifies premature completion claims as a major weakness. Unit tests and ad hoc requests are not always enough. For web apps, browser automation improved results substantially because it let the agent test more like a real user.

### 7. Use Git as Recovery Infrastructure

Git is not only for version control but also for session continuity. It provides stable checkpoints, clear deltas, and a recovery path when a change degrades the codebase.

## Failure Modes and Proposed Solutions

| Problem | Initializer Agent Behavior | Coding Agent Behavior |
| --- | --- | --- |
| Declares the project finished too early | Create a structured feature list | Read it and choose one unfinished feature |
| Leaves bugs or undocumented progress | Write initial repo state and progress notes | Read notes and git log, test the app, then record new progress |
| Marks features done prematurely | Create explicit feature definitions | Mark as passing only after careful verification |
| Spends time figuring out how to run the app | Create `init.sh` | Start each session by using or checking that script |

## Testing Guidance

The article recommends stronger verification than agents typically do by default. For full-stack applications, browser automation can uncover issues that are not visible from code inspection or simple endpoint checks. It also notes current limitations, such as difficulty testing browser-native modals through some automation tools.

## Practical Session Pattern

A typical later-session workflow described in the article is:

1. Re-establish context with `pwd`, progress notes, feature list, and git log.
2. Start the application using the prepared bootstrap script.
3. Run a basic end-to-end smoke test.
4. Select the next highest-priority unfinished feature.
5. Implement that feature incrementally.
6. Verify it thoroughly.
7. Commit the change and update progress notes.

## Main Takeaway

The central idea is that long-running agents need an external working memory and a disciplined handoff process. The model should not be expected to preserve project continuity by context compaction alone. Reliable long-horizon work comes from combining:

- explicit environment setup
- structured feature tracking
- incremental execution
- frequent verification
- git-backed recovery and handoff

## Open Questions From the Article

- Whether one general-purpose coding agent is better than multiple specialized agents across long tasks
- How well these harness patterns generalize beyond full-stack web application work
- How much specialized testing and QA agents could improve overall reliability