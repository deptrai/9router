# Mmomarket — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use Mmomarket for you.

> Tip: start with the **mmomarket** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://mmomarket.org/skills/mmomarket/SKILL.md |
| Chat / code-gen | https://mmomarket.org/skills/mmomarket-chat/SKILL.md |
| Image generation | https://mmomarket.org/skills/mmomarket-image/SKILL.md |
| Text-to-speech | https://mmomarket.org/skills/mmomarket-tts/SKILL.md |
| Speech-to-text | https://mmomarket.org/skills/mmomarket-stt/SKILL.md |
| Embeddings | https://mmomarket.org/skills/mmomarket-embeddings/SKILL.md |
| Web search | https://mmomarket.org/skills/mmomarket-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://mmomarket.org/skills/mmomarket-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://mmomarket.org/skills/mmomarket/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export NINEROUTER_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export NINEROUTER_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $NINEROUTER_URL/api/health` → `{"ok":true}`.

## Links


- Dashboard: https://mmomarket.org
