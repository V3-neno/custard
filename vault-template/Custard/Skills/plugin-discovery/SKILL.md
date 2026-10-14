---
name: plugin-discovery
description: Starter prompts for a plugin around a capability a provider lacks, used by Start building in Settings → Capabilities. In Plugins mode, read it to see what that first message asks for.
modes: plugins
---

# Plugin discovery

**Start building** in Settings → Capabilities makes a new plugin (like New plugin) and opens its workspace with a prompt from this note in the message box. Custard fills it in without a model; the user checks and sends it. Reword freely, keeping the shape:

- Heading: the capability id (`web_search`, `pdf`, `vision`, `reasoning`, …), or `default` for any without a section.
- First line: `Plugin name: …`, the new plugin's name.
- Then the prompt. `{who}`: who lacks it ("DeepSeek V4 Pro"). `{has}`: " (DeepSeek Flash can)" or nothing. `{provider}`: the provider. `{gap}`: what is missing ("web search").

A broken or missing section uses Custard's built-in copy. Only `web_search`, `pdf` and `vision` can go in `fills`.

## web_search
Plugin name: Web Search

{who} can't search the web in Custard{has}. Let's build a plugin with a read-only `search` tool that queries a web search API (Serper, Brave Search or DuckDuckGo) and returns titles, links and snippets. First read docs/MANIFEST.md (Fills) and docs/API.md, and help me pick the service: cost, API key, host. Declare `fills: [{ "capability": "web_search", "tool": "search" }]` only once it really returns web results.

## pdf
Plugin name: PDF Reader

{who} can't read PDFs in Custard{has}. Let's build a plugin with a read-only tool that turns a PDF I give it into text, page by page. First read docs/MANIFEST.md (Fills) and docs/API.md. Plugins have no npm packages, so tell me what would extract the text and what it costs. Declare `fills` with `"capability": "pdf"` only once it really works.

## vision
Plugin name: Image Describer

{who} can't see images in Custard{has}. Let's build a plugin with a read-only tool that sends an image I give it to a vision model (Claude's vision, say, with its own key) and returns a description. First read docs/MANIFEST.md (Fills) and docs/API.md, and tell me the cost and that my image goes to that service. Declare `fills` with `"capability": "vision"` only once it really works.

## reasoning
Plugin name: Reasoning Steps

{who} doesn't think before answering in Custard{has}, and no plugin can add that to the model itself. A plugin could add a tool that works through a problem step by step using a model that does think. First read docs/MANIFEST.md and docs/API.md; is it worth it (model, key, cost)? It can't go in `fills`.

## reasoning_summary
Plugin name: Reasoning Notes

{who} doesn't summarize its thinking in Custard{has}, and no plugin can change that in the model. A plugin could add a tool that writes a short summary of how an answer was reached. First read docs/MANIFEST.md and docs/API.md; is it worth it? It can't go in `fills`.

## effort
Plugin name: Effort Helper

{who} doesn't take effort levels in Custard{has}, and no plugin can add them to the model itself. A plugin could add a tool that gives a draft answer a more thorough second pass with a model that does. First read docs/MANIFEST.md and docs/API.md; is it worth it (model, key, cost)? It can't go in `fills`.

## compaction
Plugin name: Chat Condenser

{who} can't compact long chats in Custard{has}, and no plugin can change that; Continue in a new chat already carries a long chat on. A plugin could add a tool that condenses a long text into a summary. First read docs/MANIFEST.md and docs/API.md; does it add anything? It can't go in `fills`.

## token_counting
Plugin name: Token Counter

{who} has no exact token count in Custard{has}, and no plugin can change the gauge. A plugin could add a tool that counts tokens in a text. First read docs/MANIFEST.md and docs/API.md; which counter, and how close to {provider}'s? It can't go in `fills`.

## fallbacks
Plugin name: Second Opinion

{who} has no fallback model in Custard{has}, and no plugin can change that. A plugin could add a tool that asks another model for a second answer, labelled as such. First read docs/MANIFEST.md and docs/API.md; pick the model, key and cost. It can't go in `fills`.

## default
Plugin name: Capability Helper

{who} lacks {gap} in Custard{has}. Let's see whether a plugin tool can work around it. First read docs/MANIFEST.md and docs/API.md, and tell me plainly if a plugin can't help. Only `web_search`, `pdf` and `vision` can go in `fills`.
