---
name: plugin-blueprint
description: Use in Plugins mode before writing code for a new plugin or a large change, to agree on the smallest plugin that does the job and how it will be tested.
modes: plugins
---

# Plugin blueprint

Decide what to build before building it. A short agreed spec keeps the build loop from wandering, which is where long and expensive plugin chats come from. Building itself follows `plugin-development`.

## Instructions

1. **Reuse first.** List `plugin/` and read the manifests of plugins that touch the same service or task. If one can be extended, propose that instead of a new plugin.
2. **Check the service.** Find out how the service's API works from its official docs (web search if needed): sign-in, the endpoints needed, rate limits, and what it costs. Say what you couldn't confirm.
3. **Write a one-page spec in the chat:**
   - What the user can do with it, in their words.
   - Each tool: name, read or write, input, what it returns.
   - Network hosts, and whether it needs storage, links or sign-in.
   - Account, plan or key the user needs, and any cost per use.
4. **Smallest version first.** Fewest tools, read-only where possible, no widget unless asked. List the nice-to-haves as a later round.
5. **Test plan before code.** What each test in `tests/` will check (success, each error, partial success, bad input), and what can't be tested without the real service; that part stays labelled unverified.
6. **Get a yes.** Ask the user to confirm or change the spec. Then build it with `plugin-development`, and stick to the spec; if it needs to change, say so first.
7. **Hand over clearly.** At the end, list the files, tools and permissions, the test results, and what is unverified. The user activates it with Manage on its card.
